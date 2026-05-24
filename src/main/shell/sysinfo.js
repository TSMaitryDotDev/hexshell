'use strict';

/**
 * System info + banner.
 *
 * Replaces the old plain banner with a fastfetch-class readout in the
 * Hexshell HUD aesthetic. We DO NOT shell out to fastfetch / neofetch,
 * but we DO read the same surfaces they read (procfs, sysfs, dotfiles)
 * and run a couple of cheap subprocesses with strict timeouts to match
 * their output.
 *
 * Public:
 *   gather(env)         -> structured info object
 *   render(emit, env)   -> emit the banner to a renderer (the boot
 *                          banner and the `sys` builtin both use it)
 */

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ANSI } = require('./env');

// ───────────────────────────────────────────────────────────────────────────
// Distro detection
// ───────────────────────────────────────────────────────────────────────────
const DISTRO_TO_GLYPH = {
  arch: 'linux-archlinux', artix: 'linux-artix',
  endeavouros: 'linux-endeavour', garuda: 'linux-garuda',
  manjaro: 'linux-manjaro', archcraft: 'linux-archcraft',
  debian: 'linux-debian', ubuntu: 'linux-ubuntu',
  pop: 'linux-pop_os', linuxmint: 'linux-mint',
  elementary: 'linux-elementary', kali: 'linux-kali_linux',
  parrot: 'linux-parrot', fedora: 'linux-fedora',
  rhel: 'linux-redhat', centos: 'linux-centos',
  rocky: 'linux-rocky', almalinux: 'linux-almalinux',
  opensuse: 'linux-opensuse',
  'opensuse-leap': 'linux-opensuse',
  'opensuse-tumbleweed': 'linux-opensuse',
  alpine: 'linux-alpine', nixos: 'linux-nixos',
  gentoo: 'linux-gentoo', void: 'linux-void',
  slackware: 'linux-slackware', freebsd: 'linux-freebsd',
};

function readOsRelease() {
  for (const p of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      const out = {};
      for (const line of text.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq).trim();
        let v = line.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        out[k] = v;
      }
      return out;
    } catch (_) { /* try next */ }
  }
  return {};
}

function osGlyphName(rel) {
  const id = (rel.ID || '').toLowerCase();
  if (DISTRO_TO_GLYPH[id]) return DISTRO_TO_GLYPH[id];
  const likes = (rel.ID_LIKE || '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const l of likes) {
    if (DISTRO_TO_GLYPH[l]) return DISTRO_TO_GLYPH[l];
  }
  return 'linux-tux';
}

// ───────────────────────────────────────────────────────────────────────────
// Procfs / sysfs helpers
// ───────────────────────────────────────────────────────────────────────────

/** Run a command with a tight timeout. Empty string on any failure. */
function tryRun(file, args, timeoutMs = 200) {
  try {
    const out = execFileSync(file, args, {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      maxBuffer: 1 << 20,
    });
    return out.trim();
  } catch (_) { return ''; }
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}

/** Parse INI-style `Key=Value` files (KDE / GTK config). */
function parseIni(text) {
  const out = Object.create(null);
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      out[section] = out[section] || Object.create(null);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (section) out[section][k] = v;
    else out[k] = v;
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-field gatherers
// ───────────────────────────────────────────────────────────────────────────
//
// Each gatherer returns a string (or empty string for "unknown"). Together
// they fill the structured object that `render()` walks.
//
// We cache the whole bundle for a few seconds so repeated `sys` calls,
// banner re-renders, etc. don't re-stat the same files. 5s is short
// enough that uptime/memory still feel "live" when the user runs `sys`
// twice in a row.

const CACHE_MS = 5000;
let _cache = null;
let _cacheAt = 0;

function gather(env, opts = {}) {
  const now = Date.now();
  if (!opts.fresh && _cache && (now - _cacheAt) < CACHE_MS) {
    // Still refresh the few "live" numbers (uptime, memory %, display)
    // so the cache doesn't lie about constantly-changing stuff.
    return liveOverlay(_cache, env);
  }
  _cache = doGather(env);
  _cacheAt = now;
  return _cache;
}

function liveOverlay(base, env) {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  const usedPct  = totalMem ? Math.round((usedMem / totalMem) * 100) : 0;
  return {
    ...base,
    uptime: formatUptime(os.uptime()),
    memory: {
      used: usedMem, total: totalMem, pct: usedPct,
      pretty: `${formatGiB(usedMem)} / ${formatGiB(totalMem)} · ${usedPct}%`
    },
    display: {
      ...base.display,
      cols: (env && env.cols) || base.display.cols || 0,
      rows: (env && env.rows) || base.display.rows || 0,
    }
  };
}

function doGather(env) {
  const rel  = readOsRelease();
  const cpus = os.cpus();
  const kernel = os.release();
  const archK  = unameMachine();

  let username = process.env.USER || 'user';
  try { username = os.userInfo().username; } catch (_) {}

  // Memory + swap — straight from /proc/meminfo for accuracy. os.freemem
  // counts cached memory as "free", which inflates available; MemAvailable
  // is what every modern fetch tool prefers.
  const mem = readMemInfo();

  // Display: monitor resolution from sysfs DRM. Falls back to terminal
  // cell size if no monitor info is available (headless / unsupported).
  const monitor = readMonitor();

  // CPU model + base clock. We strip the "with X Graphics" suffix that
  // AMD APUs carry — the GPU row reports that separately, so repeating
  // it here just bloats the string and forces a wrap in narrow layouts.
  const cpuModel  = cpus.length
    ? cpus[0].model
        .replace(/\s+/g, ' ')
        .replace(/\s+with\s+(Integrated|Radeon|UHD|HD|Iris)\s+Graphics?/i, '')
        .trim()
    : 'unknown';
  const cpuClock  = cpus.length ? (cpus[0].speed / 1000).toFixed(2) + ' GHz' : '';
  const cpuPretty = cpuClock
    ? `${cpuModel} (${cpus.length}) @ ${cpuClock}`
    : `${cpuModel} (${cpus.length})`;

  // GPU — best-effort from lspci. Falls back to empty if not installed
  // (Hexshell never depends on it).
  const gpu = readGpu();

  // Packages — count is what fastfetch reports. Gate by what's installed
  // so a Debian box doesn't run `pacman` and vice-versa.
  const pkgs = readPackages();

  // Desktop environment / window manager / themes / fonts / cursor.
  const desktop = readDesktop();

  // Disk usage of the root filesystem.
  const disk = readDisk('/');

  // Network: first non-loopback IPv4 address with its interface name.
  const ip = readPrimaryIp();

  // Locale.
  const locale = process.env.LC_ALL || process.env.LANG || '';

  return {
    os: {
      id:        (rel.ID || 'linux').toLowerCase(),
      pretty:    rel.PRETTY_NAME || rel.NAME || 'Linux',
      version:   rel.VERSION_ID || '',
      arch:      archK || process.arch,
      glyphName: osGlyphName(rel)
    },
    kernel,
    host:      os.hostname(),
    user:      username,
    uptime:    formatUptime(os.uptime()),
    cpu:       cpuPretty,
    cpuModel,
    cpuCount:  cpus.length,
    gpu,
    memory:    mem,
    swap:      readSwap(),
    disk,
    packages:  pkgs,
    shell:     'hexsh',
    terminal:  `Hexshell ${pkgVersion()}`,
    version:   pkgVersion(),
    node:      process.versions.node,
    electron:  process.versions.electron || null,
    de:        desktop.de,
    wm:        desktop.wm,
    wmTheme:   desktop.wmTheme,
    theme:     desktop.theme,
    icons:     desktop.icons,
    font:      desktop.font,
    cursor:    desktop.cursor,
    locale,
    ip,
    display: {
      cols:    (env && env.cols) || 0,
      rows:    (env && env.rows) || 0,
      session: process.env.XDG_SESSION_TYPE || '',
      desktop: process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '',
      monitor: monitor || ''
    }
  };
}

// -- specific readers -------------------------------------------------------

function unameMachine() {
  // os.arch() = 'x64'; users expect 'x86_64'. uname -m matches the kernel.
  const out = tryRun('uname', ['-m'], 50);
  return out || os.arch();
}

function readMemInfo() {
  const text = readFileSafe('/proc/meminfo');
  const lines = text.split('\n');
  const map = Object.create(null);
  for (const line of lines) {
    const m = line.match(/^([A-Za-z()_]+):\s+(\d+)\s*kB/);
    if (m) map[m[1]] = Number(m[2]) * 1024;
  }
  const total     = map.MemTotal || os.totalmem();
  const available = map.MemAvailable != null ? map.MemAvailable : os.freemem();
  const used      = Math.max(0, total - available);
  const pct       = total ? Math.round((used / total) * 100) : 0;
  return {
    used, total, pct,
    pretty: `${formatGiB(used)} / ${formatGiB(total)} · ${pct}%`
  };
}

function readSwap() {
  const text = readFileSafe('/proc/meminfo');
  let total = 0, free = 0;
  const t = text.match(/SwapTotal:\s+(\d+)\s*kB/);
  const f = text.match(/SwapFree:\s+(\d+)\s*kB/);
  if (t) total = Number(t[1]) * 1024;
  if (f) free  = Number(f[1]) * 1024;
  if (!total) return { total: 0, used: 0, pct: 0, pretty: '0 B / 0 B (0%)' };
  const used = Math.max(0, total - free);
  const pct  = Math.round((used / total) * 100);
  return { used, total, pct, pretty: `${formatGiB(used)} / ${formatGiB(total)} · ${pct}%` };
}

function readDisk(mount) {
  // statvfs would be ideal but isn't in stdlib node; df is universal.
  const out = tryRun('df', ['-B1', '--output=size,used,avail,target', mount], 150);
  if (!out) return { used: 0, total: 0, pct: 0, pretty: '—' };
  const lines = out.trim().split('\n');
  if (lines.length < 2) return { used: 0, total: 0, pct: 0, pretty: '—' };
  const cols = lines[1].trim().split(/\s+/);
  const total = Number(cols[0]) || 0;
  const used  = Number(cols[1]) || 0;
  const pct   = total ? Math.round((used / total) * 100) : 0;
  return {
    used, total, pct,
    pretty: `${formatGiB(used)} / ${formatGiB(total)} · ${pct}%`
  };
}

function readMonitor() {
  // Walk /sys/class/drm/*/modes; the first non-empty modes file gives
  // us the active resolution of the connected display.
  try {
    const drmDir = '/sys/class/drm';
    const entries = fs.readdirSync(drmDir);
    for (const ent of entries) {
      // We want connectors (e.g. card1-eDP-1), not card devices.
      if (!/-(eDP|HDMI|DP|VGA|DSI|LVDS)/i.test(ent)) continue;
      const status = readFileSafe(path.join(drmDir, ent, 'status')).trim();
      if (status !== 'connected') continue;
      const modes = readFileSafe(path.join(drmDir, ent, 'modes')).trim();
      if (!modes) continue;
      // First line is the active mode like "1920x1080".
      const mode = modes.split('\n')[0].trim();
      return mode;
    }
  } catch (_) {}
  return '';
}

function readGpu() {
  const out = tryRun('lspci', ['-mm'], 250);
  if (!out) return '';
  // `lspci -mm` quoted-field format. Note the slot ("05:00.0") is NOT
  // quoted, so the quoted-field array starts at:
  //   [0] class    "VGA compatible controller"
  //   [1] vendor   "Advanced Micro Devices, Inc. [AMD/ATI]"
  //   [2] device   "Cezanne [Radeon Vega Series / Radeon Vega Mobile Series]"
  //   [3] subsys-vendor   (optional)
  //   [4] subsys-device   (optional)
  // The "device" field's bracketed alias is the user-friendly product
  // name; fastfetch prefers it. The vendor field has its own bracketed
  // suffix "[AMD/ATI]" we don't want to match by accident.
  for (const line of out.split('\n')) {
    if (!/VGA compatible controller|3D controller|Display controller/i.test(line)) continue;
    const fields = line.match(/"([^"]*)"/g) || [];
    if (fields.length < 3) continue;

    const vendorRaw = fields[1].slice(1, -1);
    const deviceRaw = fields[2].slice(1, -1);

    // Trim vendor noise to a recognisable prefix (NVIDIA, AMD, Intel).
    const vendor = vendorRaw
      .replace(/Advanced Micro Devices, Inc\.?\s*\[?AMD(\/ATI)?\]?/i, 'AMD')
      .replace(/NVIDIA Corporation/i, 'NVIDIA')
      .replace(/Intel Corporation/i, 'Intel')
      .trim();

    // Pull the product name out of brackets if present, else use codename.
    const bracket = deviceRaw.match(/\[([^\]]+)\]/);
    let product;
    if (bracket) {
      product = bracket[1];
      // Multiple aliases ("X / Y") — keep just the first; it's the canonical.
      product = product.split('/')[0].trim();
    } else {
      product = deviceRaw.trim();
    }

    return `${vendor} ${product}`.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function readPackages() {
  // Most-common distros first — bail on the first that returns a count.
  // Each call is timeout-bounded so missing tools don't slow us down.
  const probes = [
    ['pacman', ['-Qq'],   'pacman'],
    ['dpkg-query', ['-f', '${binary:Package}\\n', '-W'], 'dpkg'],
    ['rpm',    ['-qa'],   'rpm'],
    ['apk',    ['info'],  'apk'],
    ['xbps-query', ['-l'],'xbps'],
    ['flatpak',['list'],  'flatpak'],
  ];
  const counts = [];
  for (const [bin, args, label] of probes) {
    const out = tryRun(bin, args, 300);
    if (!out) continue;
    const n = out.split('\n').filter(Boolean).length;
    if (n > 0) counts.push(`${n} (${label})`);
  }
  if (!counts.length) return '';
  return counts.join(', ');
}

function readDesktop() {
  const empty = { de: '', wm: '', wmTheme: '', theme: '', icons: '', font: '', cursor: '' };
  const env = process.env;

  // Name-only "Plasma 6.x" / "GNOME 45". XDG_CURRENT_DESKTOP gives the
  // family; we look up an upstream version where it's cheap to do so.
  const family = (env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || '').split(':')[0];
  let de = family || '';
  if (/KDE/i.test(family)) {
    const v = tryRun('plasmashell', ['--version'], 100);
    const m = v && v.match(/plasmashell\s+([\d.]+)/i);
    de = m ? `KDE Plasma ${m[1]}` : 'KDE Plasma';
  } else if (/GNOME/i.test(family)) {
    const v = tryRun('gnome-shell', ['--version'], 100);
    const m = v && v.match(/GNOME Shell\s+([\d.]+)/);
    de = m ? `GNOME ${m[1]}` : 'GNOME';
  } else if (/XFCE/i.test(family)) {
    const v = tryRun('xfce4-session', ['--version'], 100);
    const m = v && v.match(/xfce4-session\s+([\d.]+)/);
    de = m ? `XFCE ${m[1]}` : 'XFCE';
  } else if (/MATE/i.test(family)) {
    de = 'MATE';
  } else if (/CINNAMON/i.test(family)) {
    de = 'Cinnamon';
  } else if (/LXQT/i.test(family)) {
    de = 'LXQt';
  }

  // WM. For Wayland sessions the session type IS the WM in many cases;
  // for X11 wmctrl is the cheapest probe but it might not be installed.
  let wm = '';
  if (env.WAYLAND_DISPLAY) {
    if (/KDE/i.test(family))      wm = 'KWin (Wayland)';
    else if (/GNOME/i.test(family)) wm = 'Mutter (Wayland)';
    else if (env.HYPRLAND_INSTANCE_SIGNATURE) wm = 'Hyprland';
    else if (env.SWAYSOCK)        wm = 'sway';
    else                          wm = 'Wayland';
  } else {
    const wmctrl = tryRun('wmctrl', ['-m'], 100);
    const m = wmctrl && wmctrl.match(/Name:\s+(.+)/);
    if (m) wm = m[1].trim();
    else if (env.DISPLAY) wm = 'X11';
  }

  // KDE-specific theme + icons + font + cursor from kdeglobals + kwinrc.
  let theme = '', icons = '', font = '', cursor = '', wmTheme = '';
  const HOME = env.HOME || os.homedir();

  const kdeGlobals = parseIni(readFileSafe(path.join(HOME, '.config', 'kdeglobals')));
  const kwinrc     = parseIni(readFileSafe(path.join(HOME, '.config', 'kwinrc')));
  if (kdeGlobals.General) {
    theme = kdeGlobals.General.ColorScheme || '';
    if (kdeGlobals.General.font) font = kdeGlobals.General.font.split(',')[0];
  }
  if (kdeGlobals.Icons) {
    icons = kdeGlobals.Icons.Theme || icons;
  }
  if (kwinrc.org_kde_kwin_decoration || kwinrc.Plugins) {
    wmTheme = (kwinrc['org.kde.kdecoration2'] && kwinrc['org.kde.kdecoration2'].theme) || '';
  }
  // GTK fallback (XFCE / MATE / Cinnamon / etc.).
  if (!theme || !icons || !font) {
    const gtk = parseIni(readFileSafe(path.join(HOME, '.config', 'gtk-3.0', 'settings.ini')));
    const s = gtk.Settings || {};
    theme = theme || s['gtk-theme-name']      || '';
    icons = icons || s['gtk-icon-theme-name'] || '';
    font  = font  || s['gtk-font-name']       || '';
    cursor = cursor || s['gtk-cursor-theme-name'] || '';
  }
  if (!cursor) {
    const idx = parseIni(readFileSafe(path.join(HOME, '.icons', 'default', 'index.theme')));
    cursor = (idx['Icon Theme'] && idx['Icon Theme'].Inherits) || cursor;
  }

  return { de, wm, wmTheme, theme, icons, font, cursor };
}

function readPrimaryIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    if (name === 'lo' || name.startsWith('docker') || name.startsWith('br-')) continue;
    for (const a of ifs[name]) {
      if (a.family === 'IPv4' && !a.internal) return `${a.address} (${name})`;
    }
  }
  return '';
}

// ───────────────────────────────────────────────────────────────────────────
// Formatters
// ───────────────────────────────────────────────────────────────────────────
function formatUptime(secs) {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const out = [];
  if (d) out.push(`${d}d`);
  if (h) out.push(`${h}h`);
  if (m || !out.length) out.push(`${m}m`);
  return out.join(' ');
}
function formatGiB(n) { return `${(n / (1024 ** 3)).toFixed(2)} GiB`; }
function pkgVersion() {
  try { return require('../../../package.json').version || '0.0.0'; }
  catch (_) { return '0.0.0'; }
}
function fit(s, max) {
  s = String(s == null ? '' : s);
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + '…';
}

// ───────────────────────────────────────────────────────────────────────────
// Banner rendering
// ───────────────────────────────────────────────────────────────────────────
const PALETTE_BLOCK = (() => {
  let out = '';
  for (let i = 0; i < 16; i++) out += `\x1b[38;5;${i}m█`;
  return out + '\x1b[0m';
})();

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function bar(width)        { return '─'.repeat(Math.max(1, width)); }

/**
 * The 12 (or so) info pairs the banner shows. We only include rows that
 * actually have a value — empty fields are dropped, so machines without
 * GPU/lspci or without a desktop session don't get blank lines.
 */
function buildPairs(sys) {
  const displayParts = [
    sys.display.monitor || `${sys.display.cols}×${sys.display.rows}`,
    sys.display.session,
    sys.display.desktop
  ].filter(Boolean).join(' · ');

  const all = [
    ['os',        `${sys.os.pretty} · ${sys.os.arch}`],
    ['kernel',    sys.kernel],
    ['host',      `${sys.user}@${sys.host}`],
    ['uptime',    sys.uptime],
    ['packages',  sys.packages],
    ['shell',     sys.shell],
    ['terminal',  sys.terminal],
    ['display',   displayParts],
    ['de',        sys.de],
    ['wm',        sys.wm],
    ['theme',     sys.theme],
    ['icons',     sys.icons],
    ['font',      sys.font],
    ['cursor',    sys.cursor],
    ['cpu',       sys.cpu],
    ['gpu',       sys.gpu],
    ['memory',    sys.memory.pretty],
    ['swap',      sys.swap.total ? sys.swap.pretty : ''],
    ['disk',      sys.disk.pretty],
    ['ip',        sys.ip],
    ['locale',    sys.locale],
    ['node',      `v${sys.node}`],
    ['electron',  sys.electron ? `v${sys.electron}` : ''],
  ];
  return all.filter(([, v]) => v && v.length);
}

/**
 * @param {(s:string)=>void} emit
 * @param {object} env Hexshell env (uses env.cols / env.rows)
 */
function render(emit, env) {
  const C = ANSI;
  const sys = gather(env);

  const W = clamp((env && env.cols) ? env.cols - 2 : 100, 60, 110);
  const wantEmblem  = W >= 70;
  const wantTwoCol  = W >= 100;

  const EMBLEM_W = wantEmblem ? 7 : 0;
  const KEY_W    = 9;
  const COL1_W   = wantTwoCol
    ? Math.floor((W - 6 - EMBLEM_W - 4) / 2)
    : (W - 6 - EMBLEM_W);
  const COL2_W   = wantTwoCol
    ? (W - 6 - EMBLEM_W - 4 - COL1_W)
    : 0;

  const pairs = buildPairs(sys);
  // Split for two-column layout: first half left, rest right.
  const half  = Math.ceil(pairs.length / 2);
  const col1Pairs = wantTwoCol ? pairs.slice(0, half) : pairs;
  const col2Pairs = wantTwoCol ? pairs.slice(half)    : [];
  const rows = Math.max(col1Pairs.length, col2Pairs.length, 5);

  const headerLabel = `[ HEXSHELL · v${sys.version} ]`;
  const headerFill  = bar(Math.max(0, W - headerLabel.length - 4));
  emit(`${C.dim}┌─${C.reset}${C.bold}${C.green}${headerLabel}${C.reset}${C.dim}${headerFill}${C.reset}\r\n`);
  emit(`${C.dim}│${C.reset}\r\n`);

  emit(
    `${C.dim}│${C.reset}   ${C.cyan}${sys.os.pretty}${C.reset}` +
    `${C.dim} · ${C.reset}${sys.os.arch}\r\n`
  );
  emit(`${C.dim}│${C.reset}\r\n`);

  // Try to load the OS glyph just to anchor the eye on the left side.
  let emblemGlyph = '';
  try {
    const I = require('./icons');
    emblemGlyph = I.glyph(sys.os.glyphName, '\uf17c');
  } catch (_) {}
  const emblemRow = Math.floor(rows / 2);

  for (let i = 0; i < rows; i++) {
    let line = `${C.dim}│${C.reset}   `;
    if (wantEmblem) {
      if (i === emblemRow) {
        line += `${C.dim} [${C.reset} ${C.green}${emblemGlyph}${C.reset} ${C.dim}]${C.reset} `;
      } else if (i === emblemRow - 1 || i === emblemRow + 1) {
        line += `${C.dim}  ╴ ╶  ${C.reset}`;
      } else {
        line += ' '.repeat(EMBLEM_W);
      }
    }
    line += renderKV(col1Pairs[i], COL1_W, KEY_W, C);
    if (wantTwoCol) {
      line += '   ';
      line += renderKV(col2Pairs[i], COL2_W, KEY_W, C);
    }
    emit(line + '\r\n');
  }

  emit(`${C.dim}│${C.reset}\r\n`);
  emit(`${C.dim}│${C.reset}   ${PALETTE_BLOCK}  ${C.dim}truecolor / 256-color${C.reset}\r\n`);
  emit(`${C.dim}│${C.reset}\r\n`);
  emit(`${C.dim}└${bar(W - 1)}${C.reset}\r\n`);
  emit(`${C.dim}type ${C.reset}help${C.dim} for keybindings + builtins${C.reset}\r\n`);
}

function renderKV(pair, colW, keyW, C) {
  if (!pair) return ' '.repeat(colW);
  const [k, v] = pair;
  const valW = Math.max(1, colW - keyW - 2);
  const keyStr = `${C.dim}${k.padEnd(keyW, ' ')}${C.reset}`;
  const valStr = fit(v, valW).padEnd(valW, ' ');
  return `${keyStr}  ${valStr}`;
}

module.exports = { gather, render, osGlyphName };
