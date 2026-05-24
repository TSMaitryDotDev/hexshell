#!/usr/bin/env bun
/**
 * Generate SHA256SUMS for everything in dist/.
 *
 * Why ship checksums:
 *   - Users on niche distros (Slackware, Void, Gentoo) often grab the
 *     tar.xz and want to verify integrity. SHA256SUMS is the de-facto
 *     Linux convention; pair it with a detached signature later if you
 *     want full trust.
 *   - GitHub Releases display SHA256SUMS automatically, so users can
 *     confirm a download wasn't tampered with in transit.
 *
 * Output:
 *   dist/SHA256SUMS  — one `<hex>  <basename>` line per artifact
 */

import { createHash } from 'node:crypto';
import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT     = dirname(fileURLToPath(import.meta.url)) + '/..';
const DIST_DIR = join(ROOT, 'dist');
const OUTPUT   = join(DIST_DIR, 'SHA256SUMS');

// Extensions we want to checksum. Skip electron-builder's intermediate
// blockmap files and YAML manifests; users don't care about those.
const KEEP_EXTS = new Set([
  '.appimage', '.deb', '.rpm', '.pacman',
  '.tar.xz', '.zip', '.exe', '.dmg', '.snap'
]);

function ext(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.xz')) return '.tar.xz';
  const dot = lower.lastIndexOf('.');
  return dot < 0 ? '' : lower.slice(dot);
}

async function sha256(file) {
  const buf = await readFile(file);
  return createHash('sha256').update(buf).digest('hex');
}

async function main() {
  let entries;
  try {
    entries = await readdir(DIST_DIR);
  } catch (err) {
    console.error(`[checksums] dist/ not found — run a build first.`);
    process.exit(1);
  }

  const lines = [];
  for (const name of entries.sort()) {
    const full = join(DIST_DIR, name);
    const st = await stat(full).catch(() => null);
    if (!st || !st.isFile()) continue;
    if (!KEEP_EXTS.has(ext(name))) continue;
    const hash = await sha256(full);
    lines.push(`${hash}  ${name}`);
    console.log(`[checksums] ${hash}  ${name}`);
  }

  if (!lines.length) {
    console.error('[checksums] no artifacts found in dist/');
    process.exit(1);
  }

  await writeFile(OUTPUT, lines.join('\n') + '\n', 'utf8');
  console.log(`[checksums] wrote ${OUTPUT}`);
}

main().catch((err) => {
  console.error('[checksums] failed:', err);
  process.exit(1);
});
