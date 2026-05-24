'use strict';

/**
 * Executor: runs external commands.
 *
 * Strategy:
 *   - Each external command (or pipeline) gets a fresh node-pty session, so
 *     full-screen apps (vim, htop, less, btop) work with full color and
 *     resize support.
 *   - The PTY is allocated only for the duration of the command; on exit
 *     it's disposed. There's no long-lived shell process in Hexshell.
 *   - For the common case of "one foreground command" we spawn the program
 *     directly with node-pty (no /bin/sh in the middle) so signals route
 *     correctly and the prompt comes back instantly.
 *   - For pipelines and redirections we shell out to /bin/sh -c with a
 *     reconstructed command string. This is a deliberate trade-off: writing
 *     a hand-rolled pipeline runner inside node-pty adds a lot of code for
 *     features users already get from sh. We only do this when the parsed
 *     pipeline actually contains those features.
 *
 * The Executor exposes a single async method run() that:
 *   - prints the program's output to the renderer
 *   - resolves with the exit code
 *   - listens for resize events while the command is alive
 *   - kills the child if cancel() is called (Ctrl+C while running)
 */

const pty = require('node-pty');
const { unquote } = require('./parser');
const { lookupOnPath } = require('./builtins');

class Executor {
  /**
   * @param {import('./env').Env} env
   * @param {(s:string)=>void} emit            send bytes to renderer
   * @param {()=>{cols:number,rows:number}} getSize  current terminal size
   */
  constructor(env, emit, getSize) {
    this._env = env;
    this._emit = emit;
    this._getSize = getSize;
    /** @type {import('node-pty').IPty | null} */
    this._proc = null;
    /** @type {((data:string)=>void) | null} */
    this._tap = null;
  }

  /**
   * Install (or remove with `null`) a callback that observes EVERY chunk
   * coming back from the running PTY. Used by HexShell to detect when an
   * install/download actually starts producing output (i.e. past any sudo
   * password prompt). The tap MUST be cheap and never throw.
   */
  setTap(fn) {
    this._tap = (typeof fn === 'function') ? fn : null;
  }

  /**
   * @param {Array} stmts  output of parser.parse()
   * @returns {Promise<number>} final exit code
   */
  async runStatements(stmts) {
    let lastExit = 0;
    for (const s of stmts) {
      if (s.op === '&&' && lastExit !== 0) continue;
      if (s.op === '||' && lastExit === 0) continue;
      lastExit = await this._runStatement(s);
    }
    return lastExit;
  }

  async _runStatement(stmt) {
    const { pipeline, background } = stmt;
    if (!pipeline.length) return 0;

    const needsShell =
      pipeline.length > 1 ||
      pipeline.some((c) => c.redir.in || c.redir.out || c.redir.err) ||
      background;

    if (needsShell) {
      return this._runViaSh(pipeline, background);
    }
    return this._runDirect(pipeline[0]);
  }

  // -------------------------------------------------------------------------
  // Direct exec (single command, no redir, no pipe)
  // -------------------------------------------------------------------------

  async _runDirect(cmd) {
    let argv = this._expandArgv(cmd.argv);
    if (!argv.length) return 0;

    argv = this._env.applyAlias(argv);

    const exe = argv[0];
    const args = argv.slice(1);
    const resolved = exe.includes('/') ? exe : lookupOnPath(this._env, exe);
    if (!resolved) {
      this._emit(`\x1b[38;5;203mhexsh: command not found: ${exe}\x1b[0m\r\n`);
      return 127;
    }

    return this._spawnAndPipe(resolved, args, /*viaShell*/ false);
  }

  // -------------------------------------------------------------------------
  // sh -c (pipelines, redirections, background)
  // -------------------------------------------------------------------------

  async _runViaSh(pipeline, background) {
    // Reconstruct a shell-safe string. We re-quote each token so spaces and
    // special chars survive. Variables were already expanded; for anything
    // we couldn't expand we fall back to the raw token text.
    const parts = [];
    for (let i = 0; i < pipeline.length; i++) {
      const cmd = pipeline[i];
      const argv = this._expandArgv(cmd.argv);
      const aliased = this._env.applyAlias(argv);
      const quoted = aliased.map(shQuote);
      let str = quoted.join(' ');
      if (cmd.redir.in)  str += ` < ${shQuote(cmd.redir.in)}`;
      if (cmd.redir.out) str += ` ${cmd.redir.append ? '>>' : '>'} ${shQuote(cmd.redir.out)}`;
      if (cmd.redir.err) str += ` 2> ${shQuote(cmd.redir.err)}`;
      parts.push(str);
    }
    let cmdline = parts.join(' | ');
    if (background) cmdline += ' &';

    return this._spawnAndPipe('/bin/sh', ['-c', cmdline], /*viaShell*/ true);
  }

  // -------------------------------------------------------------------------
  // Common spawn path
  // -------------------------------------------------------------------------

  _spawnAndPipe(file, args, viaShell) {
    return new Promise((resolve) => {
      const { cols, rows } = this._getSize();
      let proc;
      try {
        proc = pty.spawn(file, args, {
          name: 'xterm-256color',
          cols: clamp(cols, 80),
          rows: clamp(rows, 24),
          cwd:  this._env.cwd,
          env:  this._env.env,
          encoding: 'utf8'
        });
      } catch (err) {
        this._emit(`\x1b[38;5;203mhexsh: ${err.message}\x1b[0m\r\n`);
        return resolve(126);
      }

      this._proc = proc;
      const onData = proc.onData((data) => {
        // Tap first — runs in the same tick so HexShell sees activity
        // before the renderer has even painted it. Failures are swallowed
        // so a bug in the tap can never break command execution.
        if (this._tap) {
          try { this._tap(data); } catch (_) {}
        }
        this._emit(data);
      });
      const onExit = proc.onExit(({ exitCode, signal }) => {
        try { onData.dispose(); } catch (_) {}
        try { onExit.dispose(); } catch (_) {}
        this._proc = null;
        // Some programs exit without trailing newline; ensure we're at col 0
        // before the next prompt is drawn.
        this._emit('\r');
        const code = signal ? 128 + signal : exitCode;
        resolve(Number.isFinite(code) ? code : 0);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Forward keystrokes to the running child (foreground only). */
  write(data) {
    if (this._proc) this._proc.write(data);
  }

  /** Resize the running child's PTY. */
  resize(cols, rows) {
    if (!this._proc) return;
    try { this._proc.resize(clamp(cols, 80), clamp(rows, 24)); } catch (_) {}
  }

  /** Send SIGINT (Ctrl+C). The child decides whether to die. */
  cancel() {
    if (!this._proc) return;
    try { this._proc.kill('SIGINT'); } catch (_) {}
  }

  /** Hard kill on shutdown. */
  dispose() {
    if (!this._proc) return;
    try { this._proc.kill('SIGHUP'); } catch (_) {}
    this._proc = null;
  }

  isRunning() { return !!this._proc; }

  // -------------------------------------------------------------------------
  // argv expansion (parser tokens -> string[])
  // -------------------------------------------------------------------------

  _expandArgv(tokens) {
    const out = [];
    for (const tk of tokens) {
      const expanded = this._env.expandToken(tk);
      for (const v of expanded) out.push(v);
    }
    return out;
  }
}

function clamp(n, fallback) {
  const v = Number.isFinite(n) ? Math.floor(n) : fallback;
  if (v < 1) return fallback;
  if (v > 1000) return 1000;
  return v;
}

function shQuote(s) {
  if (s === '') return "''";
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

module.exports = { Executor };
