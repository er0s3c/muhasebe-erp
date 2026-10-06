import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
