#!/usr/bin/env bun
/**
 * One-shot local release driver.
 *
 *   bun run release
 *
 * Steps (any failure aborts before producing artifacts):
 *   1. Verify a clean git tree (no uncommitted changes).
 *   2. Read the version from package.json.
 *   3. Verify a tag v<version> doesn't already exist.
 *   4. Run a release-mode dependency rebuild.
 *   5. Build all linux artifacts (AppImage, deb, rpm, pacman, tar.xz).
 *   6. Generate SHA256SUMS.
 *   7. Print next-step instructions (tag, push, upload).
 *
 * We do NOT push or create the GitHub release automatically. Releases are
 * one-way doors; the script stops at "ready to ship" and lets you eyeball
 * the artifacts in dist/ before pushing the tag.
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';

function run(cmd, args, opts = {}) {
  console.log('$', cmd, args.join(' '));
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`[release] '${cmd} ${args.join(' ')}' failed (code ${r.status})`);
    process.exit(r.status || 1);
  }
}

function captureFail(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function main() {
  // 1. Clean tree?
  const status = captureFail('git', ['status', '--porcelain']);
  if (!status.ok) {
    console.error('[release] not a git repo or git failed; aborting.');
    process.exit(1);
  }
  if (status.stdout.trim()) {
    console.error('[release] working tree has uncommitted changes:');
    console.error(status.stdout);
    console.error('[release] commit or stash first.');
    process.exit(1);
  }

  // 2. Version
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (!version) {
    console.error('[release] package.json has no version field.');
    process.exit(1);
  }
  const tag = `v${version}`;
  console.log(`[release] preparing ${tag}`);

  // 3. Tag must not already exist locally.
  const existing = captureFail('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
  if (existing.ok) {
    console.error(`[release] tag ${tag} already exists. Bump the version in package.json.`);
    process.exit(1);
  }

  // 4-6. Build pipeline
  // We don't reinstall deps here — assume the dev did `bun install` already.
  run('bun', ['run', 'dist:all']);
  run('bun', ['run', 'checksums']);

  // 7. Next steps
  console.log('');
  console.log('======================================================');
  console.log(`Release ${tag} build complete.`);
  console.log('Artifacts in dist/:');
  run('ls', ['-1sh', 'dist/'], { stdio: 'inherit' });
  console.log('');
  console.log('Next steps:');
  console.log(`  git tag -a ${tag} -m "Release ${tag}"`);
  console.log(`  git push origin ${tag}`);
  console.log(`  gh release create ${tag} dist/SHA256SUMS \\`);
  console.log(`    dist/Hexshell-${version}-x64.AppImage \\`);
  console.log(`    dist/Hexshell-${version}-arm64.AppImage \\`);
  console.log(`    dist/hexshell_${version}_amd64.deb \\`);
  console.log(`    dist/hexshell_${version}_arm64.deb \\`);
  console.log(`    dist/hexshell-${version}.x86_64.rpm \\`);
  console.log(`    dist/hexshell-${version}.aarch64.rpm \\`);
  console.log(`    dist/hexshell-${version}.x86_64.pacman \\`);
  console.log(`    dist/hexshell-${version}.aarch64.pacman \\`);
  console.log(`    dist/Hexshell-${version}-x64.tar.xz \\`);
  console.log(`    dist/Hexshell-${version}-arm64.tar.xz \\`);
  console.log(`    --title "${tag}" --generate-notes`);
  console.log('======================================================');
}

main().catch((err) => {
  console.error('[release] failed:', err);
  process.exit(1);
});
