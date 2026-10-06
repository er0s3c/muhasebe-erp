import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = join(dirname(fileURLToPath(import.meta.url)), 'setup-input.sh');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const repository = 'ghcr.io/er0s3c/muhasebe-erp-license';
const digest = `${repository}@sha256:${'a'.repeat(64)}`;
function run(code, args = [], options = {}) {
  // Environment transport preserves multiline inputs on Git Bash/Windows too.
  const argumentEnvironment = Object.fromEntries(args.map((value, index) => [`SETUP_TEST_ARG_${index}`, value]));
  const parameters = args.map((_, index) => `"$SETUP_TEST_ARG_${index}"`).join(' ');
  return execFileSync(bash, ['-c', `set -euo pipefail; source "$SETUP_TEST_HELPER"; set -- ${parameters}; ${code}`], {
    encoding: 'utf8', timeout: 10_000, ...options,
    env: { ...process.env, ...options.env, ...argumentEnvironment, SETUP_TEST_HELPER: helper.replaceAll('\\', '/') },
  }).trim();
}

test('accepts pasted docker pull, tags, digests and surrounding whitespace', () => {
  for (const value of [
    `docker pull ${repository}:6351c5d8950fbe73aa0b197d9d1a689648b4a002`,
    `  docker   pull   ${repository}:v1.2.3  `,
    `${repository}:v1.2.3`, digest,
  ]) {
    const expected = value.includes('6351c5d') ? `${repository}:6351c5d8950fbe73aa0b197d9d1a689648b4a002`
      : value.includes('v1.2.3') ? `${repository}:v1.2.3` : digest;
    assert.equal(run('normalize_image_input "$1"', [value]), expected);
  }
});

test('rejects extra commands, options, control characters and unrelated repositories', () => {
  for (const value of [
    `docker pull ${repository}:v1; echo unsafe`,
    `docker pull ${repository}:$(echo unsafe)`,
    `docker pull --platform linux/amd64 ${repository}:v1`,
    `docker pull ghcr.io/other/image:v1`, `${repository}:v1\ncommand`,
    `${repository}@sha256:1234`, repository, `sudo docker pull ${repository}:v1`,
  ]) {
    assert.equal(run('if normalize_image_input "$1" 2>/dev/null; then exit 1; fi; printf rejected', [value]), 'rejected');
  }
});

test('blank input uses defaults and accidental trailing spaces are trimmed', () => {
  assert.equal(run('prompt_input result "Domain: " admin.er0s3c.com; printf "%s" "$result"', [], { input: '\n' }), 'admin.er0s3c.com');
  assert.equal(run('prompt_input result "Image: "; printf "%s" "$result"', [], { input: `  docker pull ${repository}:v1  \n` }), `docker pull ${repository}:v1`);
});

test('records the downloaded repository digest instead of a mutable tag', () => {
  const code = 'docker() { [[ "$1" == image && "$2" == inspect && "$5" == "$EXPECTED_IMAGE" ]]; printf "%s\\n" "$TEST_DIGESTS"; }; resolve_image_digest "$1"';
  assert.equal(run(code, [`${repository}:v1`], {
    env: { ...process.env, EXPECTED_IMAGE: `${repository}:v1`, TEST_DIGESTS: `ghcr.io/other/image@sha256:${'b'.repeat(64)}\n${digest}` },
  }), digest);
});

test('fails closed on missing, mismatched or unrelated digests', () => {
  for (const candidate of ['', `ghcr.io/other/image@sha256:${'b'.repeat(64)}`, `${repository}@sha256:${'b'.repeat(64)}`]) {
    assert.equal(run('docker() { printf "%s\\n" "$TEST_DIGESTS"; }; if resolve_image_digest "$1" 2>/dev/null; then exit 1; fi; printf rejected', [digest], {
      env: { ...process.env, TEST_DIGESTS: candidate },
    }), 'rejected');
  }
});

test('propagates inspect failures without creating an image reference', () => {
  assert.equal(run('docker() { return 1; }; if resolve_image_digest "$1"; then exit 1; fi; printf rejected', [`${repository}:v1`]), 'rejected');
});

test('rejects a standalone input patch and accepts the complete deployment kit', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'erp-vps-patch-'));
  try {
    mkdirSync(join(fixture, 'tools'));
    copyFileSync(helper, join(fixture, 'tools/setup-input.sh'));
    copyFileSync(join(dirname(helper), 'setup-vps.sh'), join(fixture, 'tools/setup-vps.sh'));
    assert.equal(run('if require_setup_files "$1" 2>/dev/null; then exit 1; fi; printf rejected', [fixture.replaceAll('\\', '/')]), 'rejected');
    assert.equal(run('require_setup_files "$1"; printf complete', [join(dirname(helper), '..').replaceAll('\\', '/')]), 'complete');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('uses the explicitly published image and never infers it from an installer commit', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'erp-vps-image-'));
  try {
    const fixturePath = fixture.replaceAll('\\', '/');
    writeFileSync(join(fixture, 'COMMIT'), '64635547a35b8003c28ee51235923f9640770f59\n');
    assert.equal(run('default_image_prompt "$1"', [fixturePath]), '');
    writeFileSync(join(fixture, 'RUNTIME_IMAGE'), `${digest}\n`);
    assert.equal(run('default_image_prompt "$1"', [fixturePath]), `docker pull ${digest}`);
    writeFileSync(join(fixture, 'RUNTIME_IMAGE'), 'docker pull ghcr.io/other/image:v1\n');
    assert.equal(run('if default_image_prompt "$1" 2>/dev/null; then exit 1; fi; printf rejected', [fixturePath]), 'rejected');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('key generation passes the shell password to a child environment, never command arguments', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'erp-vps-key-'));
  try {
    const code = [
      'source "${SETUP_TEST_HELPER%/*}/resume-setup-vps.sh";',
      'unset LICENSE_SIGNING_KEY_PASSPHRASE;',
      'LICENSE_SIGNING_KEY_PASSPHRASE=test-only-secret-passphrase;',
      'docker() {',
      'for argument in "$@"; do [[ "$argument" != *test-only-secret-passphrase* ]] || return 1; done;',
      "env bash -c '[[ \"$LICENSE_SIGNING_KEY_PASSPHRASE\" == test-only-secret-passphrase ]]' || return 1;",
      'printf child-received-password;',
      '}; ensure_signing_key "$1" test-image',
    ].join('\n');
    assert.equal(run(code, [fixture.replaceAll('\\', '/')]), 'child-received-password');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('resume preserves an existing signing key and rejects an empty key', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'erp-vps-key-'));
  try {
    const file = join(fixture, 'signing-key.json');
    const root = fixture.replaceAll('\\', '/');
    const code = 'source "${SETUP_TEST_HELPER%/*}/resume-setup-vps.sh"; docker() { echo unexpected-key-rotation; return 1; }; ensure_signing_key "$1" test-image';
    writeFileSync(file, 'existing-key-sentinel');
    assert.equal(run(code, [root]), 'Mevcut imza anahtarı korunuyor.');
    writeFileSync(file, '');
    assert.equal(run('source "${SETUP_TEST_HELPER%/*}/resume-setup-vps.sh"; if ensure_signing_key "$1" test-image 2>/dev/null; then exit 1; fi; printf rejected', [root]), 'rejected');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('resume reads only the requested setting without executing .env contents', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'erp-vps-env-'));
  try {
    const file = join(fixture, '.env');
    const path = file.replaceAll('\\', '/');
    writeFileSync(file, 'IGNORED=$(exit 1)\nLICENSE_DOMAIN=admin.er0s3c.com\n');
    assert.equal(run('source "${SETUP_TEST_HELPER%/*}/resume-setup-vps.sh"; read_setup_value "$1" LICENSE_DOMAIN', [path]), 'admin.er0s3c.com');
    writeFileSync(file, 'LICENSE_DOMAIN=one\nLICENSE_DOMAIN=two\n');
    assert.equal(run('source "${SETUP_TEST_HELPER%/*}/resume-setup-vps.sh"; if read_setup_value "$1" LICENSE_DOMAIN 2>/dev/null; then exit 1; fi; printf rejected', [path]), 'rejected');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('repeated setup with an existing admin succeeds without generating another token', () => {
  const code = 'source "${SETUP_TEST_HELPER%/*}/resume-setup-vps.sh"; docker() { [[ "$*" == *"SELECT EXISTS"* ]] || return 1; printf t; }; show_admin_entrypoint admin.example.test docker compose';
  assert.equal(run(code), 'Kurulum tamamlandı; mevcut yönetici hesabınızla https://admin.example.test/login adresinden giriş yapın (MFA zorunlu).');
});

test('first setup offers its code only when the admin table is empty', () => {
  const code = 'source "${SETUP_TEST_HELPER%/*}/resume-setup-vps.sh"; docker() { if [[ "$*" == *"SELECT EXISTS"* ]]; then printf f; elif [[ "$*" == *setup:token ]]; then printf test-setup-code; else return 1; fi; }; show_admin_entrypoint admin.example.test docker compose';
  assert.equal(run(code), 'Kurulum hizmetleri hazır: https://admin.example.test/setup (MFA zorunlu).\ntest-setup-code');
});

test('admin-state query and token failures remain failures', () => {
  for (const body of ['return 1', 'printf unexpected', 'if [[ "$*" == *"SELECT EXISTS"* ]]; then printf f; else return 1; fi']) {
    const code = `source "\${SETUP_TEST_HELPER%/*}/resume-setup-vps.sh"; docker() { ${body}; }; if show_admin_entrypoint admin.example.test docker compose >/dev/null 2>&1; then exit 1; fi; printf rejected`;
    assert.equal(run(code), 'rejected');
  }
});
