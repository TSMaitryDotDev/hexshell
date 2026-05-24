#!/usr/bin/env bun
/**
 * Download Nerd Fonts' canonical glyphnames.json and slim it down for
 * runtime use.
 *
 * Why slim:
 *   - The upstream file is ~600 KB and includes per-glyph metadata
 *     (deprecated names, descriptions, language hints) we don't need
 *     at runtime.
 *   - We only need {nameWithoutPrefix: char}. Stripping shrinks it to
 *     ~80–90 KB, which is fine to ship with the app and load eagerly.
 *
 * Source:
 *   https://raw.githubusercontent.com/ryanoasis/nerd-fonts/master/glyphnames.json
 *
 * Output:
 *   src/main/shell/glyphnames.generated.json
 *     {
 *       "_version":  "<sha256-prefix>",
 *       "_fetched":  "<ISO date>",
 *       "_count":    9234,
 *       "glyphs": {
 *         "dev-rust":   "\ue7a8",
 *         "cod-folder": "\uea83",
 *         ...
 *       }
 *     }
 *
 * Idempotent: if the output exists already, we skip the download.
 * Run `bun run glyphs --force` to refresh.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT   = dirname(fileURLToPath(import.meta.url)) + '/..';
const OUT    = join(ROOT, 'src', 'main', 'shell', 'glyphnames.generated.json');
const SOURCE =
  'https://raw.githubusercontent.com/ryanoasis/nerd-fonts/master/glyphnames.json';

const force = process.argv.includes('--force') ||
              process.env.HEXSHELL_REFRESH_GLYPHS === '1';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function main() {
  if (!force && await exists(OUT)) {
    console.log('[glyphs] already present, skipping (use --force to refresh)');
    return;
  }

  console.log(`[glyphs] downloading ${SOURCE}`);
  const res = await fetch(SOURCE, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`[glyphs] HTTP ${res.status} from ${SOURCE}`);
    process.exit(1);
  }
  const raw = await res.text();
  const sha = createHash('sha256').update(raw).digest('hex').slice(0, 12);

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    console.error('[glyphs] failed to parse upstream JSON:', err.message);
    process.exit(1);
  }

  // Strip:
  //   - METADATA key (it sits at the top of the file)
  //   - any entry without a `char` field (rare but possible)
  // Keys arrive as "<family>-<name>" — we keep that as the lookup key.
  const glyphs = {};
  let count = 0;
  for (const [name, value] of Object.entries(parsed)) {
    if (name === 'METADATA' || name.startsWith('_')) continue;
    if (!value || typeof value !== 'object') continue;
    const ch = value.char;
    if (typeof ch !== 'string' || ch.length === 0) continue;
    glyphs[name] = ch;
    count++;
  }

  const out = {
    _version: sha,
    _fetched: new Date().toISOString(),
    _count:   count,
    glyphs
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 0), 'utf8');
  console.log(`[glyphs] wrote ${OUT} (${count} glyphs, sha ${sha})`);
}

main().catch((err) => {
  console.error('[glyphs] FAILED:', err.message);
  process.exit(1);
});
