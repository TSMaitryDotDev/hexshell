'use strict';

/**
 * Distro logos as inline SVG strings.
 *
 * Why inline SVG instead of <img src="..."> or fetched assets:
 *   - Zero network at runtime, zero file-loading race for the splash.
 *   - SVGs inherit currentColor, so we can tint them through CSS if we
 *     ever want a fully-monochrome HUD pass.
 *   - Easy to swap one in: paste a new <svg ...> string against the
 *     distro's lowercase /etc/os-release ID.
 *
 * Style:
 *   - viewBox 0 0 128 128 — fixed canvas; the splash sets render size.
 *   - Brand colors where they're recognisable (Arch blue, Ubuntu orange,
 *     Debian red, etc.). The HUD's cyberpunk frame around them pulls the
 *     whole thing back to the same aesthetic.
 *   - Single path / minimal shapes; rendering 128×128 is a single GPU
 *     blit per draw.
 *
 * If you'd prefer the logos to follow the phosphor palette, set
 *   fill="currentColor"
 * inside each path and CSS will tint them green automatically.
 */

const SVG = (s) => s;

const LOGOS = {
  // Arch Linux — official mark from archlinux.org's brand kit.
  // The signature is a peak with a vertical light split through the
  // centre; the strokes converge at the apex and skew outward at the
  // base. Brand color: #1793D1.
  arch: SVG(`
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <path fill="#1793D1" d="M64 8
           C 64 8 47.6 47.4 35.2 75.2
           C 30.4 86 24.8 96.8 18.4 108
           C 30.4 105.2 41.2 102.8 51.2 100.8
           C 49.6 96 48.8 90.4 48.4 84.4
           C 47.2 75.2 49.6 67.6 53.2 60.8
           C 56 71.6 59.6 80.4 64 87.6
           C 68.4 80.4 72 71.6 74.8 60.8
           C 78.4 67.6 80.8 75.2 79.6 84.4
           C 79.2 90.4 78.4 96 76.8 100.8
           C 86.8 102.8 97.6 105.2 109.6 108
           C 103.2 96.8 97.6 86 92.8 75.2
           C 80.4 47.4 64 8 64 8 Z"/>
</svg>`),

  // Ubuntu — three "Friends" dots inside a circle; brand color #E95420.
  ubuntu: SVG(`
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <circle cx="64" cy="64" r="56" fill="#E95420"/>
  <circle cx="64" cy="64" r="48" fill="none" stroke="#FFFFFF" stroke-width="6"/>
  <circle cx="64" cy="20" r="9" fill="#FFFFFF"/>
  <circle cx="102" cy="86" r="9" fill="#FFFFFF"/>
  <circle cx="26" cy="86" r="9" fill="#FFFFFF"/>
  <line x1="64"  y1="20" x2="64"  y2="36" stroke="#FFFFFF" stroke-width="6"/>
  <line x1="102" y1="86" x2="86"  y2="76" stroke="#FFFFFF" stroke-width="6"/>
  <line x1="26"  y1="86" x2="42"  y2="76" stroke="#FFFFFF" stroke-width="6"/>
</svg>`),

  // Debian — official red swirl. Vector traced from the brand mark.
  debian: SVG(`
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <path fill="#A81D33" d="M84 76
           C 80 92 64 96 52 88
           C 40 80 38 60 50 50
           C 56 46 64 46 70 50
           C 60 48 50 56 50 68
           C 50 80 60 88 70 86
           C 78 84 84 78 84 76 Z
           M 86 50
           C 90 56 92 64 88 70
           C 86 64 86 56 82 52
           C 84 50 86 50 86 50 Z"/>
</svg>`),

  // Fedora — official "f" infinity-loop in a circle.
  fedora: SVG(`
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <circle cx="64" cy="64" r="56" fill="#294172"/>
  <path fill="#FFFFFF" d="M88 40
           C 88 32 80 24 70 24
           C 56 24 48 36 48 50
           L 48 60 L 38 60 L 38 72 L 48 72 L 48 88
           C 48 100 58 108 70 108
           C 80 108 86 100 86 90
           L 74 90
           C 74 94 72 96 68 96
           C 64 96 62 92 62 86 L 62 72 L 78 72 L 78 60 L 62 60
           L 62 52
           C 62 46 64 42 70 42
           C 74 42 76 44 76 48 Z"/>
</svg>`),

  // Manjaro — three vertical bars + corner; brand color #34BE5B.
  manjaro: SVG(`
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <rect x="14" y="14" width="34" height="100" rx="4" fill="#34BE5B"/>
  <rect x="56" y="14" width="22" height="34"  rx="4" fill="#34BE5B"/>
  <rect x="56" y="56" width="22" height="58"  rx="4" fill="#34BE5B"/>
  <rect x="86" y="56" width="28" height="58"  rx="4" fill="#34BE5B"/>
</svg>`),

  // Alpine — mountain on water; brand color #0D597F.
  alpine: SVG(`
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <circle cx="64" cy="64" r="56" fill="#0D597F"/>
  <path fill="none" stroke="#FFFFFF" stroke-width="6" stroke-linejoin="round"
        d="M22 86 L46 50 L66 78 L78 64 L106 86"/>
</svg>`),

  // NixOS — six lambda snowflake; brand color #5277C3.
  nixos: SVG(`
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <g stroke="#5277C3" stroke-width="8" stroke-linecap="round" fill="none">
    <line x1="64" y1="14"  x2="64" y2="44"/>
    <line x1="64" y1="84"  x2="64" y2="114"/>
    <line x1="14" y1="42"  x2="40" y2="56"/>
    <line x1="88" y1="72"  x2="114" y2="86"/>
    <line x1="14" y1="86"  x2="40" y2="72"/>
    <line x1="88" y1="56"  x2="114" y2="42"/>
  </g>
  <circle cx="64" cy="64" r="14" fill="#7EBAE4"/>
</svg>`),

  // Pop!_OS — interlocked "P" cubes; brand color #48B9C7.
  pop: SVG(`
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <rect x="14" y="14" width="100" height="100" rx="14" fill="#48B9C7"/>
  <path fill="#FFFFFF" d="M40 100 L40 40 L74 40
           C 90 40 96 50 96 60
           C 96 72 88 80 74 80 L56 80 L56 100 Z
           M 56 56 L56 64 L72 64
           C 76 64 78 62 78 60
           C 78 56 76 56 72 56 Z"/>
</svg>`),

  // Linux Mint — green tab + interlocked LM monogram; brand #87CF3E.
  linuxmint: SVG(`
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <path fill="#87CF3E"
        d="M14 40
           C 14 28 22 20 34 20
           L 114 20 L114 108 L34 108
           C 22 108 14 100 14 88 Z"/>
  <path fill="#FFFFFF"
        d="M30 88 L30 50 L46 50 L60 72 L74 50 L90 50 L90 88 L78 88
           L 78 68 L 70 86 L50 86 L42 68 L42 88 Z"/>
</svg>`),

  // Kali Linux — black square with the dragon-tail "K" mark.
  kali: SVG(`
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <rect x="6" y="6" width="116" height="116" rx="10" fill="#000000"/>
  <path fill="#367BF0"
        d="M30 30 L52 64 L30 98 H44 L62 70 L80 98 H98 L70 56 L98 30 H84 L62 56 L44 30 Z"/>
</svg>`),

  // Generic Linux fallback — Tux silhouette.
  linux: SVG(`
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="64" cy="48" rx="26" ry="32" fill="#1A1A1A"/>
  <path d="M38 80 Q40 110 64 116 Q88 110 90 80 Q88 60 64 60 Q40 60 38 80 Z" fill="#1A1A1A"/>
  <ellipse cx="56" cy="44" rx="6" ry="9" fill="#FFFFFF"/>
  <ellipse cx="72" cy="44" rx="6" ry="9" fill="#FFFFFF"/>
  <circle cx="56" cy="46" r="3" fill="#1A1A1A"/>
  <circle cx="72" cy="46" r="3" fill="#1A1A1A"/>
  <path d="M56 60 Q64 70 72 60 Q72 64 64 64 Q56 64 56 60 Z" fill="#F2C100"/>
  <path d="M40 88 Q26 102 38 116 Q44 110 50 102" fill="#F2C100"/>
  <path d="M88 88 Q102 102 90 116 Q84 110 78 102" fill="#F2C100"/>
</svg>`),
};

/**
 * Resolve a logo SVG string for a distro.
 *
 * Lookup order:
 *   1. Bundled simple-icons SVG  (window.hexLogosBundled, populated at boot)
 *   2. Hand-drawn fallback in LOGOS
 *   3. Linux fallback
 *
 * @param {string}   id     /etc/os-release ID, lowercased
 * @param {string[]} likes  /etc/os-release ID_LIKE entries
 */
function logoFor(id, likes) {
  // Prefer official Simple Icons brand SVGs, bundled at install time by
  // scripts/fetch-simple-icons.mjs into os-logos.generated.json. The
  // renderer attaches that file's parsed contents to window when it loads.
  if (typeof window !== 'undefined' &&
      window.hexLogosBundled &&
      window.hexLogosBundled[id]) {
    return window.hexLogosBundled[id].svg;
  }
  if (typeof window !== 'undefined' && window.hexLogosBundled) {
    for (const l of (likes || [])) {
      if (window.hexLogosBundled[l]) return window.hexLogosBundled[l].svg;
    }
  }
  // Fallback to hand-drawn logos for distros not covered by Simple Icons
  // (Garuda, Void, ArchLinuxARM, etc.).
  if (id && LOGOS[id]) return LOGOS[id];
  if (Array.isArray(likes)) {
    for (const l of likes) if (LOGOS[l]) return LOGOS[l];
  }
  if (typeof window !== 'undefined' &&
      window.hexLogosBundled &&
      window.hexLogosBundled.linux) {
    return window.hexLogosBundled.linux.svg;
  }
  return LOGOS.linux;
}

// Export for both contexts:
//   - CJS (Node tests): `module.exports = ...`
//   - Renderer (plain <script>): `window.hexLogos = ...`
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LOGOS, logoFor };
}
if (typeof window !== 'undefined') {
  window.hexLogos = Object.freeze({ LOGOS, logoFor });

  // Asynchronously load the bundled simple-icons SVGs at boot. Until
  // this resolves, logoFor() falls back to the hand-drawn shapes — so
  // the splash always has *something* to show even on a clean install
  // before postinstall has run.
  //
  // We expose `window.hexLogosReady` as a promise so the splash can
  // await it before populating, guaranteeing the official Simple Icons
  // SVG renders on first paint instead of flashing the fallback.
  window.hexLogosReady = (function loadBundledLogos() {
    return fetch('./os-logos.generated.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.icons) {
          window.hexLogosBundled = data.icons;
        }
      })
      .catch(() => { /* missing or invalid JSON: keep hand-drawn fallbacks */ });
  })();
}
