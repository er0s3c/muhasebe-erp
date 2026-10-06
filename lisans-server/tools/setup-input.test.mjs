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
