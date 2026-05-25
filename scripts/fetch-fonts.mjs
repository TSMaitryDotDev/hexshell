#!/usr/bin/env bun
/**
 * Download MesloLGL Nerd Font Mono TTFs into src/renderer/fonts/.
 *
 * Why bundle the font instead of relying on the system?
 *   - Hexshell ships as an AppImage; the target machine may not have Meslo.
 *   - The Nerd Font variant gives us powerline glyphs + icons (starship,
 *     powerlevel10k, lsd, exa, etc.) without users installing anything.
 *   - "Mono" pack keeps every glyph in a single cell so the xterm grid
 *     stays aligned with prompts that use icons.
 *
 * Source: https://github.com/ryanoasis/nerd-fonts releases.
 *   Asset:  MesloLGM.zip (contains the 4 weights of MesloLGL Nerd Font Mono)
 *
 * The script is idempotent: it skips download if the four TTFs already
 * exist and pass a basic size sanity check.
 */

import { mkdir, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONT_DIR  = join(__dirname, '..', 'src', 'renderer', 'fonts');

// Nerd Fonts release tag. Pinning to a known-good version makes builds
// reproducible. Bump deliberately when you want newer glyphs.
const NF_VERSION = 'v3.2.1';
const ZIP_URL    = `https://github.com/ryanoasis/nerd-fonts/releases/download/${NF_VERSION}/Meslo.zip`;

// We want the *Mono*, *LGL* (Light Line) variants. Each TTF inside the zip
// follows this pattern, and these are the only ones we extract.
const WANTED = [
  // weight     -> output filename
  ['Regular',     'MesloLGLNerdFontMono-Regular.ttf'],
  ['Bold',        'MesloLGLNerdFontMono-Bold.ttf'],
  ['Italic',      'MesloLGLNerdFontMono-Italic.ttf'],
  ['Bold Italic', 'MesloLGLNerdFontMono-BoldItalic.ttf'],
];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function alreadyInstalled() {
  for (const [, name] of WANTED) {
    const p = join(FONT_DIR, name);
    if (!(await exists(p))) return false;
    const s = await stat(p);
    // Sanity check: any TTF smaller than 50KB is almost certainly a 404
    // page or an interrupted download.
    if (s.size < 50_000) return false;
  }
  return true;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const out = createWriteStream(dest);
  await pipeline(res.body, out);
}

async function extract(zipPath, outDir) {
  // Bun ships with a `Bun.spawn` that can call `unzip`. We avoid pulling in
  // a JS unzip dependency for one-time use. `unzip` is in `unzip` package
  // on Arch and is part of base on most Linux distros.
  const proc = Bun.spawn(['unzip', '-o', zipPath, '-d', outDir], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      'unzip failed. Install it with: sudo pacman -S unzip'
    );
  }
}

async function main() {
  if (await alreadyInstalled()) {
    console.log('[fonts] MesloLGL Nerd Font Mono already present, skipping.');
    // Still ensure Orbitron — it might be missing on an older install.
    await ensureOrbitron();
    return;
  }

  await mkdir(FONT_DIR, { recursive: true });

  const work = await mkdir(join(tmpdir(), `hexshell-fonts-${Date.now()}`), { recursive: true })
    .then((d) => d || join(tmpdir(), `hexshell-fonts-${Date.now()}`));
  // mkdir returns undefined when the dir was created; recompute the path.
  const workDir = work || join(tmpdir(), `hexshell-fonts-${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  const zipPath = join(workDir, 'Meslo.zip');
  console.log(`[fonts] downloading ${ZIP_URL}`);
  await download(ZIP_URL, zipPath);

  console.log('[fonts] extracting…');
  await extract(zipPath, workDir);

  // The zip contains many variants; pick the Mono LGL ones we want.
  const all = await readdir(workDir);
  const candidates = all.filter((n) => n.endsWith('.ttf'));

  let copied = 0;
  for (const [weight, target] of WANTED) {
    // Filenames inside the zip: e.g. "MesloLGLNerdFontMono-Regular.ttf"
    const match = candidates.find((n) => n === target);
    if (!match) {
      console.warn(`[fonts] WARN: missing ${weight} (${target}) in archive`);
      continue;
    }
    const src = join(workDir, match);
    const dst = join(FONT_DIR, target);
    const buf = await Bun.file(src).arrayBuffer();
    await writeFile(dst, new Uint8Array(buf));
    copied++;
    console.log(`[fonts] -> ${target}`);
  }

  // Cleanup tmp directory.
  await rm(workDir, { recursive: true, force: true }).catch(() => {});

  if (copied === 0) {
    throw new Error('No Meslo TTFs were extracted. Aborting.');
  }
  console.log(`[fonts] done (${copied}/${WANTED.length} files).`);

  // Also ensure Orbitron is present. Used by the HUD clock so the
  // titlebar time has the proper sci-fi look.
  await ensureOrbitron();
}

main().catch((err) => {
  console.error('[fonts] FAILED:', err.message);
  process.exit(1);
});

// ───────────────────────────────────────────────────────────────────────────
// Orbitron (sci-fi display face used by the HUD clock)
// ───────────────────────────────────────────────────────────────────────────
//
// Pulled directly from the Google Fonts repository on GitHub. The variable-
// weight TTF covers 400..900 in a single file, so we ship just one weight
// file and hit any boldness via @font-face's `font-weight` declaration.
//
// We never need bold/italic/etc. as separate files because Orbitron has
// no italic in its design and the variable axis lets us treat it as a
// weight-axis font. We rename the file at save time to drop the brackets
// from the upstream filename — square brackets in CSS url() can stall
// some font loaders, and the renamed file is what fonts.css references.
const ORBITRON_FILE = 'Orbitron-Variable.ttf';
const ORBITRON_URL  =
  'https://raw.githubusercontent.com/google/fonts/main/ofl/orbitron/Orbitron%5Bwght%5D.ttf';

async function ensureOrbitron() {
  const target = join(FONT_DIR, ORBITRON_FILE);
  try {
    const s = await stat(target);
    if (s && s.size > 50_000) {
      console.log('[fonts] Orbitron already present, skipping.');
      return;
    }
  } catch (_) { /* fall through to download */ }

  console.log(`[fonts] downloading ${ORBITRON_URL}`);
  await download(ORBITRON_URL, target);
  console.log(`[fonts] -> ${ORBITRON_FILE}`);
}
