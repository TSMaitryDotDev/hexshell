'use strict';

/**
 * Environment, aliases, and string expansion for hexsh.
 *
 * One instance per HexShell. Holds:
 *   - cwd            (we maintain our own; node child_process uses it)
 *   - vars           (shell-scope variables; see export() to promote to env)
 *   - env            (real environment forwarded to child processes)
 *   - aliases        (string -> string substitution applied to argv[0])
 *   - lastExit       (used by prompt + the $? expansion)
 *
 * Expansion order (matches user expectations from bash/zsh):
 *   1. ~  -> $HOME            (only as the first character of a token)
 *   2. $? -> last exit status
 *   3. $VAR / ${VAR}          (vars first, then process env as fallback)
 *   4. quoted strings: single-quotes are literal; double-quotes expand vars
 *
 * Globbing happens in executor.js after expansion, because it needs fs.
 */

const os = require('os');
const path = require('path');

class Env {
  constructor() {
    this.cwd = process.env.HOME || os.homedir() || '/';
    this.vars = Object.create(null);
    this.env  = { ...process.env };
    this.aliases = Object.create(null);
    this.lastExit = 0;
    // Live terminal size, mirrored from HexShell on every resize so any
    // builtin (e.g. ls column packer) can read the current width.
    this.cols = 80;
    this.rows = 24;

    // Some sensible aliases by default. Users can override via `alias`.
    this.aliases.ll = 'ls -lh';
    this.aliases.la = 'ls -la';
    this.aliases.l  = 'ls';

    // Forwarded to children so colored output works everywhere.
    this.env.TERM      = 'xterm-256color';
    this.env.COLORTERM = 'truecolor';
    // Make `ls` color by default; harmless if the user doesn't have GNU ls.
    if (!this.env.LS_COLORS) this.env.CLICOLOR = '1';
  }

  // -------------------------------------------------------------------------
  // cwd / vars
  // -------------------------------------------------------------------------

  setCwd(p) {
    this.cwd = path.resolve(this.cwd, p);
  }

  setVar(name, value) {
    this.vars[name] = String(value);
  }

  unsetVar(name) {
    delete this.vars[name];
    delete this.env[name];
  }

  /** Promote a var to the child environment (export NAME=value). */
  exportVar(name, value) {
    if (value !== undefined) this.vars[name] = String(value);
    if (name in this.vars) this.env[name] = this.vars[name];
  }

  lookup(name) {
    if (name === '?') return String(this.lastExit);
    if (name in this.vars) return this.vars[name];
    if (name in this.env)  return this.env[name];
    return '';
  }

  // -------------------------------------------------------------------------
  // Aliases
  // -------------------------------------------------------------------------

  setAlias(name, value) { this.aliases[name] = value; }
  unsetAlias(name)      { delete this.aliases[name]; }

  /**
   * Apply alias substitution to the FIRST argv element. Returns the new
   * argv (does NOT recursively re-alias to keep things predictable).
   */
  applyAlias(argv) {
    if (!argv.length) return argv;
    const head = argv[0];
    const replacement = this.aliases[head];
    if (!replacement) return argv;
    // alias may itself contain spaces and quoted bits; reparse it crudely.
    const split = replacement.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    return [...split, ...argv.slice(1)];
  }

  // -------------------------------------------------------------------------
  // Expansion
  // -------------------------------------------------------------------------

  /**
   * Expand a parser token to its literal value(s). Most tokens produce
   * exactly one string. Variable expansion of an unset name yields ''.
   */
  expandToken(tk) {
    const T = require('./parser').T;
    switch (tk.type) {
      case T.WORD: {
        let s = tk.value;
        if (s.startsWith('~') && (s.length === 1 || s[1] === '/')) {
          s = (this.env.HOME || os.homedir()) + s.slice(1);
        }
        return [this._expandVarsInString(s)];
      }
      case T.VAR: {
        const name = tk.value.startsWith('${')
          ? tk.value.slice(2, -1)
          : tk.value.slice(1);
        return [this.lookup(name)];
      }
      case T.SQ_STRING:
        return [tk.value.slice(1, -1)];
      case T.DQ_STRING: {
        const inner = tk.value.slice(1, -1);
        return [this._expandVarsInString(this._unescapeDouble(inner))];
      }
      default:
        return [tk.value];
    }
  }

  _expandVarsInString(s) {
    return s.replace(/\$\{([A-Za-z_?][A-Za-z0-9_]*)\}|\$([A-Za-z_?][A-Za-z0-9_]*)/g,
      (_m, a, b) => this.lookup(a || b));
  }

  _unescapeDouble(s) {
    return s.replace(/\\([\\"$`])/g, '$1');
  }

  // -------------------------------------------------------------------------
  // Prompt rendering
  // -------------------------------------------------------------------------

  /**
   * Render the prompt string. Uses raw ANSI; xterm.js renders it. We keep
   * it short so it doesn't fight long commands. Format:
   *
   *   ┌─[<icon> ~/projects/hexshell]
   *   └─❯
   *
   * On non-zero last exit the arrow turns red. The path is shortened with
   * ~ if it sits inside $HOME.
   */
  renderPrompt() {
    const home = this.env.HOME || os.homedir();
    let display = this.cwd;
    if (home && (display === home || display.startsWith(home + path.sep))) {
      display = '~' + display.slice(home.length);
    }
    // Folder icon: pick the glyph for the current directory's basename so
    // ~/Downloads gets the download arrow, ~/.config the gear, etc. We
    // require icons lazily so this module stays standalone-loadable.
    let icon = '';
    try {
      const I = require('./icons');
      const baseName = path.basename(this.cwd) || '/';
      icon = I.iconForDirectory(baseName).glyph + ' ';
    } catch (_) { /* icons module optional */ }

    const ok = this.lastExit === 0;
    const C = ANSI;
    const line1 =
      `${C.dim}┌─[${C.reset}${C.cyan}${icon}${display}${C.reset}${C.dim}]${C.reset}`;
    const arrow = ok ? `${C.green}❯${C.reset}` : `${C.red}❯${C.reset}`;
    const line2 = `${C.dim}└─${C.reset}${arrow} `;
    return line1 + '\r\n' + line2;
  }
}

const ANSI = Object.freeze({
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
  red:    '\x1b[38;5;203m',
  green:  '\x1b[38;5;120m',
  yellow: '\x1b[38;5;228m',
  blue:   '\x1b[38;5;75m',
  magenta:'\x1b[38;5;177m',
  cyan:   '\x1b[38;5;87m',
  gray:   '\x1b[38;5;240m',
  fg:     '\x1b[38;5;156m'
});

module.exports = { Env, ANSI };
