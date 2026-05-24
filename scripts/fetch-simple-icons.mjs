#!/usr/bin/env bun
/**
 * Bundle official brand SVGs from `simple-icons` for the OS splash.
 *
 * Why a build-time bundle and not a runtime require:
 *   - The renderer is sandboxed under `contextIsolation: true` and has
 *     no access to `require`, so it can't pull simple-icons directly.
 *   - simple-icons ships ~3000 brand SVGs (~20MB on disk). We only want
 *     the ~25 distro icons. Bundling a tiny derived JSON keeps the app
 *     small and the load fast.
 *   - The brand color sits on the icon's `hex` field, NOT inside the
 *     SVG. We inject it into the path's `fill` so the renderer can drop
 *     the SVG straight into the DOM with no post-processing.
 *
 * Output:
 *   src/renderer/os-logos.generated.json
 *     {
 *       _generated: ISO date,
 *       _count:     N,
 *       icons: {
 *         "<distro-key>": {
 *           "title":  "Arch Linux",
 *           "color":  "#1793D1",
 *           "svg":    "<svg viewBox=...>... fill=\"#1793D1\" .../></svg>"
 *         },
 *         ...
 *       }
 *     }
 *
 * Map keys mirror /etc/os-release IDs we care about so the renderer can
 * look up by `info.os.id` directly.
 */

import { writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const OUT  = join(ROOT, 'src', 'renderer', 'os-logos.generated.json');

// Only re-bundle if forced — simple-icons rarely changes the distros we
// list, and we don't want every `bun install` to rewrite the file.
const force = process.argv.includes('--force') ||
              process.env.HEXSHELL_REFRESH_LOGOS === '1';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// /etc/os-release ID  ->  simple-icons slug
// (id keys are lowercased to match the renderer's gather().os.id)
const MAP = {
  arch:                 'archlinux',
  artix:                'artixlinux',
  ubuntu:               'ubuntu',
  debian:               'debian',
  fedora:               'fedora',
  manjaro:              'manjaro',
  alpine:               'alpinelinux',
  nixos:                'nixos',
  linuxmint:            'linuxmint',
  pop:                  'popos',
  kali:                 'kalilinux',
  rhel:                 'redhat',
  centos:               'centos',
  endeavouros:          'endeavouros',
  elementary:           'elementary',
  rocky:                'rockylinux',
  almalinux:            'almalinux',
  opensuse:             'opensuse',
  'opensuse-leap':      'opensuse',
  'opensuse-tumbleweed':'opensuse',
  gentoo:               'gentoo',
  slackware:            'slackware',
  freebsd:              'freebsd',
  // Generic fallback used when a distro isn't found.
  linux:                'linux',
};

async function main() {
  if (!force && await exists(OUT)) {
    console.log('[icons] os-logos already present, skipping (use --force to refresh)');
    return;
  }

  // Dynamically import simple-icons. It exposes named camelCase exports
  // like `siArchlinux`. Build the lookup once.
  const si = await import('simple-icons');

  const lookup = (slug) => {
    const camel = 'si' + slug.charAt(0).toUpperCase() + slug.slice(1);
    return si[camel] || null;
  };

  /**
   * Inject the brand color into the path fill so the SVG is drop-in.
   * simple-icons ships paths without `fill`, expecting the consumer to
   * style via CSS — but our renderer plants the SVG with innerHTML and
   * we want the brand color baked in.
   */
  function svgWith(icon, color) {
    // simple-icons exposes the inner path string on `.path`, plus title.
    // We compose a complete <svg> wrapper with viewBox 0 0 24 24 (their
    // canvas) and a single <path d="..." fill="...">.
    const safeColor = '#' + (color || icon.hex || '000000').replace(/^#/, '');
    return (
      `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"` +
      ` role="img" aria-label="${escapeAttr(icon.title)}">` +
      `<path d="${icon.path}" fill="${safeColor}"/>` +
      `</svg>`
    );
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  const icons = {};
  let hits = 0;
  let misses = [];
  for (const [key, slug] of Object.entries(MAP)) {
    const icon = lookup(slug);
    if (!icon) { misses.push(`${key} (${slug})`); continue; }
    icons[key] = {
      title: icon.title,
      color: '#' + icon.hex,
      svg:   svgWith(icon, icon.hex),
    };
    hits++;
  }

  if (misses.length) {
    console.warn('[icons] not found in simple-icons:', misses.join(', '));
  }

  const out = {
    _generated: new Date().toISOString(),
    _count:     hits,
    icons
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 0), 'utf8');
  console.log(`[icons] wrote ${OUT} (${hits} icons)`);
}

main().catch((err) => {
  console.error('[icons] FAILED:', err.message);
  process.exit(1);
});
