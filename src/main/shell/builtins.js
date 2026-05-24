'use strict';

/**
 * Builtin commands.
 *
 * Each builtin runs in the main process (not in a child). They get:
 *   - argv     (already alias-expanded and variable-expanded)
 *   - env      (the Env instance)
 *   - emit     (string -> renderer; should NOT include the final '\r\n')
 *   - emitErr  (string -> renderer, colored red)
 *
 * Convention: builtins return a number -> exit status. Async ones return
 * Promise<number>. The orchestrator awaits both.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ANSI } = require('./env');
const I = require('./icons');

class Builtins {
  /**
   * @param {import('./env').Env} env
   * @param {import('./history').History} history
   */
  constructor(env, history) {
    this._env = env;
    this._history = history;
    this._table = Object.create(null);
    this._register();
  }

  has(name)  { return Object.prototype.hasOwnProperty.call(this._table, name); }
  names()    { return Object.keys(this._table); }
  get(name)  { return this._table[name]; }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  _register() {
    this._table.cd       = (a, e, o) => this.cd(a, e, o);
    this._table.pwd      = (a, e, o) => this.pwd(a, e, o);
    this._table.export   = (a, e, o) => this.export_(a, e, o);
    this._table.unset    = (a, e, o) => this.unset(a, e, o);
    this._table.alias    = (a, e, o) => this.alias(a, e, o);
    this._table.unalias  = (a, e, o) => this.unalias(a, e, o);
    this._table.history  = (a, e, o) => this.history(a, e, o);
    this._table.clear    = (a, e, o) => this.clear(a, e, o);
    this._table.which    = (a, e, o) => this.which(a, e, o);
    this._table.help     = (a, e, o) => this.help(a, e, o);
    this._table.set      = (a, e, o) => this.set(a, e, o);
    this._table.exit     = (a, e, o) => this.exit(a, e, o);
    this._table.ls       = (a, e, o) => this.ls(a, e, o);
    this._table.ll       = (a, e, o) => this.ls(['ls', '-l', ...a.slice(1)], e, o);
    this._table.la       = (a, e, o) => this.ls(['ls', '-la', ...a.slice(1)], e, o);
    this._table.sys      = (a, e, o) => this.sys(a, e, o);
    this._table[':']     = () => 0; // POSIX no-op
  }

  // -------------------------------------------------------------------------
  // Implementations
  // -------------------------------------------------------------------------

  cd(argv, env, { emitErr }) {
    let target = argv[1];
    if (!target || target === '~') target = env.env.HOME || os.homedir();
    else if (target === '-') {
      const prev = env.vars.OLDPWD;
      if (!prev) { emitErr('cd: OLDPWD not set\r\n'); return 1; }
      target = prev;
    } else if (target.startsWith('~/')) {
      target = path.join(env.env.HOME || os.homedir(), target.slice(2));
    }
    const abs = path.resolve(env.cwd, target);
    try {
      const st = fs.statSync(abs);
      if (!st.isDirectory()) { emitErr(`cd: not a directory: ${abs}\r\n`); return 1; }
      env.vars.OLDPWD = env.cwd;
      env.exportVar('OLDPWD');
      env.cwd = abs;
      env.vars.PWD = abs;
      env.exportVar('PWD');
      return 0;
    } catch (err) {
      emitErr(`cd: ${err.message}\r\n`);
      return 1;
    }
  }

  pwd(_argv, env, { emit }) {
    emit(env.cwd + '\r\n');
    return 0;
  }

  export_(argv, env, { emit, emitErr }) {
    if (argv.length === 1) {
      // Print all exported.
      for (const k of Object.keys(env.vars).sort()) {
        if (k in env.env) emit(`${k}=${shellQuote(env.vars[k])}\r\n`);
      }
      return 0;
    }
    for (let i = 1; i < argv.length; i++) {
      const eq = argv[i].indexOf('=');
      if (eq >= 0) {
        const name = argv[i].slice(0, eq);
        const val  = argv[i].slice(eq + 1);
        if (!validName(name)) { emitErr(`export: invalid name: ${name}\r\n`); continue; }
        env.exportVar(name, val);
      } else {
        if (!validName(argv[i])) { emitErr(`export: invalid name: ${argv[i]}\r\n`); continue; }
        env.exportVar(argv[i]);
      }
    }
    return 0;
  }

  unset(argv, env) {
    for (let i = 1; i < argv.length; i++) env.unsetVar(argv[i]);
    return 0;
  }

  alias(argv, env, { emit }) {
    if (argv.length === 1) {
      for (const k of Object.keys(env.aliases).sort()) {
        emit(`alias ${k}=${shellQuote(env.aliases[k])}\r\n`);
      }
      return 0;
    }
    for (let i = 1; i < argv.length; i++) {
      const eq = argv[i].indexOf('=');
      if (eq < 0) {
        const v = env.aliases[argv[i]];
        if (v !== undefined) emit(`alias ${argv[i]}=${shellQuote(v)}\r\n`);
      } else {
        env.setAlias(argv[i].slice(0, eq), argv[i].slice(eq + 1));
      }
    }
    return 0;
  }

  unalias(argv, env) {
    for (let i = 1; i < argv.length; i++) env.unsetAlias(argv[i]);
    return 0;
  }

  history(_argv, _env, { emit }) {
    const items = this._history.items;
    const width = String(items.length).length;
    for (let i = 0; i < items.length; i++) {
      emit(`${String(i + 1).padStart(width, ' ')}  ${items[i]}\r\n`);
    }
    return 0;
  }

  clear(_argv, _env, { emit }) {
    // Full screen clear + cursor home.
    emit('\x1b[2J\x1b[H');
    return 0;
  }

  which(argv, env, { emit, emitErr }) {
    let exit = 0;
    for (let i = 1; i < argv.length; i++) {
      const name = argv[i];
      if (this.has(name)) { emit(`${name}: hexshell builtin\r\n`); continue; }
      if (env.aliases[name]) { emit(`${name}: aliased to '${env.aliases[name]}'\r\n`); continue; }
      const found = lookupOnPath(env, name);
      if (found) emit(found + '\r\n');
      else { emitErr(`which: ${name}: not found\r\n`); exit = 1; }
    }
    return exit;
  }

  help(_argv, _env, { emit }) {
    const lines = [
      `${ANSI.bold}hexsh${ANSI.reset} — Hexshell's interactive shell`,
      '',
      `${ANSI.green}Editing${ANSI.reset}`,
      '  ←/→  Home/End  Ctrl+A/E    move cursor',
      '  Ctrl+W                     delete previous word',
      '  Ctrl+U  Ctrl+K             kill to start / end of line',
      '  Ctrl+Y                     yank',
      '  Tab                         complete commands or paths',
      '  →  / End                    accept autosuggestion',
      '  ↑ / ↓                      browse history',
      '  Ctrl+L                     clear screen',
      '  Ctrl+C                     cancel current line',
      '  Ctrl+D                     exit (when line is empty)',
      '',
      `${ANSI.green}Builtins${ANSI.reset}`,
      `  ${Object.keys(this._table).sort().join('  ')}`,
      '',
      `${ANSI.green}Operators${ANSI.reset}`,
      '  ;  &&  ||  |  >  >>  <  2>  &',
      '',
      'Anything else is run as an external program with a fresh PTY.',
      ''
    ];
    for (const l of lines) emit(l + '\r\n');
    return 0;
  }

  set(argv, env, { emit }) {
    if (argv.length === 1) {
      const all = { ...env.vars };
      for (const k of Object.keys(all).sort()) {
        emit(`${k}=${shellQuote(all[k])}\r\n`);
      }
      return 0;
    }
    for (let i = 1; i < argv.length; i++) {
      const eq = argv[i].indexOf('=');
      if (eq < 0) continue;
      env.setVar(argv[i].slice(0, eq), argv[i].slice(eq + 1));
    }
    return 0;
  }

  exit(argv, _env) {
    const code = Number(argv[1] || 0);
    process.nextTick(() => {
      const { app } = require('electron');
      app.exit(Number.isFinite(code) ? code : 0);
    });
    return 0;
  }

  /**
   * Print the Hexshell system banner. Same renderer used by startup; this
   * builtin lets users re-display it on demand. With `--json` it prints
   * the structured object instead — handy for piping into scripts.
   */
  sys(argv, env, { emit }) {
    const sysinfo = require('./sysinfo');
    if (argv.includes('--json')) {
      emit(JSON.stringify(sysinfo.gather(env), null, 2) + '\r\n');
      return 0;
    }
    sysinfo.render(emit, env);
    return 0;
  }

  // -------------------------------------------------------------------------
  // ls — directory listing with HexShell iconography
  // -------------------------------------------------------------------------
  // Supported flags (POSIX-ish, only what's common in interactive use):
  //   -a / --all          show entries starting with '.'
  //   -A / --almost-all   like -a but skip '.' and '..'
  //   -l                  long format (perms / size / mtime / name)
  //   -h / --human        human-readable sizes in long mode
  //   -1                  one entry per line
  //   -r / --reverse      reverse sort order
  //   -t                  sort by mtime (newest first)
  //   -S                  sort by size (largest first)
  //   -X                  sort by extension
  //   --color=auto|never  (auto by default; we always have a TTY here)
  //   --no-icons          skip the leading icon (useful for piping)
  //
  // Multiple positional paths are listed each in turn, with a header row
  // when more than one path is given (matches GNU ls behavior).
  ls(argv, env, { emit, emitErr }) {
    const opts = parseLsArgs(argv);
    if (opts.error) { emitErr(`ls: ${opts.error}\r\n`); return 2; }

    const targets = opts.paths.length ? opts.paths : ['.'];
    const cols = (env.cols && env.cols > 0) ? env.cols : 80;
    let exit = 0;

    for (let pi = 0; pi < targets.length; pi++) {
      const rel = targets[pi];
      const abs = path.resolve(env.cwd, expandTilde(rel, env));
      let st;
      try { st = fs.lstatSync(abs); }
      catch (err) {
        emitErr(`ls: ${err.message}\r\n`);
        exit = 2;
        continue;
      }

      // Header between multiple paths.
      if (targets.length > 1) {
        if (pi > 0) emit('\r\n');
        emit(`${ANSI.dim}${rel}:${ANSI.reset}\r\n`);
      }

      // If the user passed a file (or a non-dir), list THAT entry alone.
      if (!st.isDirectory()) {
        const dirent = makeShallowDirent(path.basename(abs), st);
        const rows = [decorate(dirent, abs, opts)];
        if (opts.long) emitLongRows(emit, rows, opts);
        else           emitColumns(emit, rows, opts, cols);
        continue;
      }

      let entries;
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
      catch (err) {
        emitErr(`ls: ${err.message}\r\n`);
        exit = 2;
        continue;
      }

      // Filter dotfiles unless -a / -A.
      if (!opts.all && !opts.almostAll) {
        entries = entries.filter((d) => !d.name.startsWith('.'));
      }

      // -a synthesizes '.' and '..' the way GNU ls does.
      if (opts.all) {
        entries.unshift(makeShallowDirent('..', null));
        entries.unshift(makeShallowDirent('.',  null));
      }

      // Decorate (stat once per entry for size/mtime/perms). We only
      // call lstat in long mode or when sorting needs it, so the short
      // path stays fast on huge directories.
      const needStat = opts.long || opts.sort === 'time' || opts.sort === 'size';
      const rows = entries.map((d) => decorate(d, path.join(abs, d.name), opts, needStat));

      sortRows(rows, opts);

      if (opts.long) emitLongRows(emit, rows, opts);
      else           emitColumns(emit, rows, opts, cols);
    }

    return exit;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ls helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Parse `ls` argv. Returns the parsed options, or { error: '...' }.
 * Short flags can be combined: -la, -lhSr, etc. Long flags are matched
 * literally. A bare `--` ends option parsing.
 */
function parseLsArgs(argv) {
  const opts = {
    all: false, almostAll: false, long: false, human: false,
    onePerLine: false, reverse: false, sort: 'name',
    color: true, icons: true, paths: [], error: null
  };
  let i = 1;
  let endOfOpts = false;
  while (i < argv.length) {
    const a = argv[i++];
    if (endOfOpts) { opts.paths.push(a); continue; }
    if (a === '--') { endOfOpts = true; continue; }
    if (a === '--all')          { opts.all = true; continue; }
    if (a === '--almost-all')   { opts.almostAll = true; continue; }
    if (a === '--human')        { opts.human = true; continue; }
    if (a === '--reverse')      { opts.reverse = true; continue; }
    if (a === '--no-icons')     { opts.icons = false; continue; }
    if (a === '--color=never')  { opts.color = false; continue; }
    if (a === '--color' || a === '--color=auto' || a === '--color=always') {
      opts.color = true; continue;
    }
    if (a.startsWith('--')) {
      opts.error = `unrecognized option '${a}'`;
      return opts;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (const ch of a.slice(1)) {
        switch (ch) {
          case 'a': opts.all = true; break;
          case 'A': opts.almostAll = true; break;
          case 'l': opts.long = true; break;
          case 'h': opts.human = true; break;
          case '1': opts.onePerLine = true; break;
          case 'r': opts.reverse = true; break;
          case 't': opts.sort = 'time'; break;
          case 'S': opts.sort = 'size'; break;
          case 'X': opts.sort = 'extension'; break;
          default:
            opts.error = `invalid option -- '${ch}'`;
            return opts;
        }
      }
      continue;
    }
    opts.paths.push(a);
  }
  return opts;
}

function expandTilde(p, env) {
  if (p === '~') return env.env.HOME || os.homedir();
  if (p.startsWith('~/')) return path.join(env.env.HOME || os.homedir(), p.slice(2));
  return p;
}

/** Synthesize a Dirent-shaped object for entries we don't stat. */
function makeShallowDirent(name, st) {
  return {
    name,
    isDirectory()    { return st ? st.isDirectory()    : false; },
    isFile()         { return st ? st.isFile()         : false; },
    isSymbolicLink() { return st ? st.isSymbolicLink() : false; },
    _stat: st || null
  };
}

/**
 * Convert a Dirent into a "row" with everything we need to render and sort.
 * Stat is taken only when `withStat` is true (long mode / sort by time|size)
 * to keep big short-mode listings fast.
 */
function decorate(dirent, full, opts, withStat) {
  let st = dirent._stat || null;
  let isDir  = dirent.isDirectory();
  let isLink = dirent.isSymbolicLink();
  if ((!st && (withStat || isLink)) || (withStat && !st)) {
    try { st = fs.lstatSync(full); }
    catch (_) { st = null; }
  }
  if (st) {
    isDir  = st.isDirectory();
    isLink = st.isSymbolicLink();
  }
  const isExec = !!st && !st.isDirectory() && (st.mode & 0o111) !== 0;
  const icon   = I.iconForCached(dirent.name, { dir: isDir, exec: isExec, symlink: isLink });
  return {
    name:    dirent.name,
    full,
    stat:    st,
    isDir, isLink, isExec,
    icon,
    color:   colorFor(icon.kind, { isDir, isLink, isExec })
  };
}

/**
 * Sort rows. Default is name; 't' uses mtime; 'S' uses size; 'X' uses
 * extension then name. Reverse flips the result. Directories always sort
 * before files in name mode (matches `lsd`/`exa` defaults).
 */
function sortRows(rows, opts) {
  const sgn = opts.reverse ? -1 : 1;
  rows.sort((a, b) => {
    if (opts.sort === 'time') {
      const at = a.stat ? a.stat.mtimeMs : 0;
      const bt = b.stat ? b.stat.mtimeMs : 0;
      return sgn * (bt - at);
    }
    if (opts.sort === 'size') {
      const as = a.stat ? a.stat.size : 0;
      const bs = b.stat ? b.stat.size : 0;
      return sgn * (bs - as);
    }
    if (opts.sort === 'extension') {
      const ax = path.extname(a.name).toLowerCase();
      const bx = path.extname(b.name).toLowerCase();
      if (ax !== bx) return sgn * ax.localeCompare(bx);
      return sgn * a.name.localeCompare(b.name);
    }
    // name (default): dirs first, then case-insensitive name compare
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return sgn * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/**
 * Color picker keyed off the icon `kind` namespace. Cheap, deterministic,
 * and centralised so the look stays consistent across `ls`, completion,
 * and any future builtins.
 */
function colorFor(kind, flags) {
  if (flags.isDir)  return ANSI.cyan;
  if (flags.isLink) return ANSI.magenta;
  if (!kind) return ANSI.fg;
  if (kind.startsWith('lang.'))    return ANSI.green;
  if (kind.startsWith('web.'))     return ANSI.green;
  if (kind.startsWith('data.'))    return ANSI.yellow;
  if (kind.startsWith('config.'))  return ANSI.yellow;
  if (kind === 'env' || kind.startsWith('env.')) return ANSI.yellow;
  if (kind.startsWith('rc.'))      return ANSI.yellow;
  if (kind.startsWith('vcs.'))     return ANSI.magenta;
  if (kind.startsWith('infra.'))   return ANSI.magenta;
  if (kind.startsWith('media.'))   return ANSI.magenta;
  if (kind.startsWith('archive') || kind === 'archive') return ANSI.red;
  if (kind.startsWith('pkg.'))     return ANSI.red;
  if (kind.startsWith('bin'))      return flags.isExec ? ANSI.green : ANSI.red;
  if (kind === 'symlink')          return ANSI.magenta;
  if (kind.startsWith('doc.'))     return ANSI.blue;
  if (kind.startsWith('xdg.'))     return ANSI.cyan;
  return ANSI.fg;
}

/**
 * Short / column listing.
 *
 * Algorithm: try fitting into the widest column count where total row
 * width (sum of column widths + gutters) fits in `cols`. We bias toward
 * fewer columns of stable width over many cramped ones.
 */
function emitColumns(emit, rows, opts, cols) {
  if (!rows.length) return;
  if (opts.onePerLine) {
    for (const r of rows) emit(formatRow(r, opts, /*linePad*/ 0) + '\r\n');
    return;
  }
  // Width of the "icon + space + name + maybe '/'" payload, in cells.
  const widths = rows.map((r) => visibleWidth(r, opts));
  const max = widths.reduce((m, w) => Math.max(m, w), 0);
  const GUTTER = 2;
  const ncols = Math.max(1, Math.floor((cols + GUTTER) / (max + GUTTER)));
  const colW = max + GUTTER;
  for (let i = 0; i < rows.length; i++) {
    const isLastInRow = ((i + 1) % ncols === 0);
    const pad = isLastInRow ? 0 : Math.max(0, colW - widths[i]);
    emit(formatRow(rows[i], opts, pad));
    if (isLastInRow) emit('\r\n');
  }
  if (rows.length % ncols !== 0) emit('\r\n');
}

/** Long mode: -l. Five aligned columns: perms, size, mtime, icon+name. */
function emitLongRows(emit, rows, opts) {
  if (!rows.length) return;

  const fmt = rows.map((r) => ({
    perms: r.stat ? permString(r.stat) : '----------',
    size:  r.stat ? (opts.human ? humanSize(r.stat.size) : String(r.stat.size)) : '?',
    mtime: r.stat ? formatMtime(r.stat.mtimeMs) : '?',
  }));

  const sizeW = fmt.reduce((m, f) => Math.max(m, f.size.length), 0);
  const timeW = fmt.reduce((m, f) => Math.max(m, f.mtime.length), 0);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const f = fmt[i];
    const sizeStr = f.size.padStart(sizeW, ' ');
    const line =
      `${ANSI.dim}${f.perms}${ANSI.reset} ` +
      `${ANSI.fg}${sizeStr}${ANSI.reset} ` +
      `${ANSI.dim}${f.mtime.padEnd(timeW, ' ')}${ANSI.reset}  ` +
      formatRow(r, opts, 0);
    emit(line + '\r\n');
  }
}

/** "<icon> <colored-name>[/]" with an optional trailing pad of spaces. */
function formatRow(r, opts, pad) {
  const trail = r.isDir ? '/' : '';
  const iconPart = opts.icons ? `${r.icon.glyph} ` : '';
  const colored  = opts.color ? `${r.color}${r.name}${trail}${ANSI.reset}` : `${r.name}${trail}`;
  return iconPart + colored + (pad > 0 ? ' '.repeat(pad) : '');
}

/** Visible cell width of "<icon> <name>[/]" without ANSI codes. */
function visibleWidth(r, opts) {
  const trail = r.isDir ? 1 : 0;
  return (opts.icons ? 2 : 0) + r.name.length + trail;
}

/** rwxr-xr-x style permission line. */
function permString(st) {
  let s = '';
  if      (st.isDirectory())   s += 'd';
  else if (st.isSymbolicLink())s += 'l';
  else if (st.isCharacterDevice()) s += 'c';
  else if (st.isBlockDevice()) s += 'b';
  else if (st.isFIFO())        s += 'p';
  else if (st.isSocket())      s += 's';
  else                         s += '-';
  const m = st.mode;
  s += (m & 0o400) ? 'r' : '-';
  s += (m & 0o200) ? 'w' : '-';
  s += (m & 0o100) ? 'x' : '-';
  s += (m & 0o040) ? 'r' : '-';
  s += (m & 0o020) ? 'w' : '-';
  s += (m & 0o010) ? 'x' : '-';
  s += (m & 0o004) ? 'r' : '-';
  s += (m & 0o002) ? 'w' : '-';
  s += (m & 0o001) ? 'x' : '-';
  return s;
}

/** "12.3K" / "4.2M" / "1.1G" style. Base 1024 — matches `ls -h`. */
function humanSize(n) {
  if (n < 1024) return `${n}B`;
  const units = ['K', 'M', 'G', 'T', 'P'];
  let i = -1;
  let v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}${units[i]}`;
}

/**
 * Mtime in either "MMM DD  YYYY" (older than 6 months) or "MMM DD HH:MM"
 * (recent), like GNU ls. Keeps long output narrow.
 */
function formatMtime(ms) {
  const d = new Date(ms);
  const now = Date.now();
  const sixMonthsMs = 1000 * 60 * 60 * 24 * 30 * 6;
  const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  const day = String(d.getDate()).padStart(2, ' ');
  if (now - ms > sixMonthsMs) {
    return `${monthShort} ${day}  ${d.getFullYear()}`;
  }
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${monthShort} ${day} ${hh}:${mm}`;
}

function validName(s) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

function shellQuote(s) {
  if (/^[\w@%+=:,./-]*$/.test(s)) return s;
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function lookupOnPath(env, name) {
  if (name.includes('/')) {
    try { fs.accessSync(name, fs.constants.X_OK); return path.resolve(env.cwd, name); }
    catch (_) { return null; }
  }
  const PATH = (env.env.PATH || '').split(':').filter(Boolean);
  for (const dir of PATH) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) {}
  }
  return null;
}

module.exports = { Builtins, lookupOnPath };
