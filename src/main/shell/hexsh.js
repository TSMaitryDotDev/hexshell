'use strict';

/**
 * HexShell — the orchestrator.
 *
 * State machine:
 *
 *           ┌────────────────────────────┐
 *           │      EDITING (LineEditor)  │
 *           └────────┬───────────────────┘
 *           submit   │
 *                    ▼
 *           ┌────────────────────────────┐
 *           │   PARSING + EXEC builtin   │
 *           └────────┬───────────────────┘
 *                    │
 *                    ▼ (external command)
 *           ┌────────────────────────────┐
 *           │     RUNNING (Executor)     │
 *           │  keystrokes -> child PTY   │
 *           └────────┬───────────────────┘
 *               exit│ / Ctrl+C
 *                    ▼
 *           back to EDITING
 *
 * Public API (used by main.js):
 *   start()                    print banner + first prompt
 *   feed(data)                 forward keystrokes
 *   resize(cols, rows)         forward to running child if any; redraw line
 *   shutdown()                 dispose history flush + child kill
 */

const os = require('os');
const { Env, ANSI } = require('./env');
const { History } = require('./history');
const { Builtins } = require('./builtins');
const { Completer } = require('./completer');
const { Highlighter } = require('./highlighter');
const { LineEditor } = require('./editor');
const { Executor } = require('./executor');
const { parse } = require('./parser');

class HexShell {
  /**
   * @param {(s:string)=>void} emit          send bytes to renderer
   * @param {()=>{cols:number,rows:number}} getSize
   * @param {(kind:string)=>void} [bell]     fire a UI sound on the renderer
   */
  constructor(emit, getSize, bell) {
    this._emit = emit;
    this._getSize = getSize;
    this._bell = typeof bell === 'function' ? bell : () => {};

    this._env = new Env();
    // Seed from the renderer-provided size if available so the first
    // prompt and any pre-resize builtin see correct cols/rows.
    try {
      const sz = getSize();
      if (sz && Number.isFinite(sz.cols) && sz.cols > 0) this._env.cols = sz.cols;
      if (sz && Number.isFinite(sz.rows) && sz.rows > 0) this._env.rows = sz.rows;
    } catch (_) {}
    this._history = new History();
    this._builtins = new Builtins(this._env, this._history);
    this._completer = new Completer(this._env, this._builtins);
    this._highlighter = new Highlighter(this._env, this._completer, this._builtins);

    this._editor = new LineEditor({
      emit, getSize,
      env: this._env,
      highlighter: this._highlighter,
      completer: this._completer,
      history: this._history
    });

    this._executor = new Executor(this._env, emit, getSize);
    this._mode = 'editing'; // 'editing' | 'running'
    this._pendingContinuation = '';

    this._editor.on('submit', (line) => this._onSubmit(line));
    this._editor.on('cancel', () => this._onCancel());
    this._editor.on('eof',    () => this._onEof());
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start() {
    this._editor.begin();
  }

  feed(data) {
    if (this._mode === 'running') {
      // Intercept Ctrl+C so we can also reset highlighting if the child
      // doesn't die on SIGINT (we still forward the byte too).
      this._executor.write(data);
      return;
    }
    this._editor.feed(data);
  }

  resize(cols, rows) {
    // Mirror the live size onto Env so builtins (ls column packer, etc.)
    // always have the current width without needing the getSize closure.
    if (Number.isFinite(cols) && cols > 0) this._env.cols = cols;
    if (Number.isFinite(rows) && rows > 0) this._env.rows = rows;
    if (this._mode === 'running') {
      this._executor.resize(cols, rows);
      return;
    }
    this._editor.refresh();
  }

  shutdown() {
    try { this._executor.dispose(); } catch (_) {}
  }

  // -------------------------------------------------------------------------
  // Submit handling
  // -------------------------------------------------------------------------

  async _onSubmit(line) {
    const full = (this._pendingContinuation + line);
    // Trailing backslash = continuation. Re-prompt with PS2.
    if (full.endsWith('\\')) {
      this._pendingContinuation = full.slice(0, -1) + '\n';
      this._emit(`${ANSI.dim}…${ANSI.reset} `);
      this._editor.begin();
      return;
    }
    this._pendingContinuation = '';

    const trimmed = full.trim();
    if (!trimmed) {
      this._editor.begin();
      return;
    }

    this._history.add(full);

    let stmts;
    try {
      stmts = parse(full);
    } catch (err) {
      this._emit(`${ANSI.red}hexsh: parse error: ${err.message}${ANSI.reset}\r\n`);
      this._env.lastExit = 2;
      this._editor.begin();
      return;
    }

    // Run statements sequentially. For each statement we choose builtin vs
    // external per-pipeline. Builtins can only be the SOLE element of a
    // pipeline; if a user pipes a builtin we let sh handle it (it won't
    // know about our builtins, but practical cases like `cd | foo` are
    // nonsensical anyway).
    let exit = 0;
    for (const stmt of stmts) {
      if (stmt.op === '&&' && exit !== 0) continue;
      if (stmt.op === '||' && exit === 0) continue;

      if (stmt.pipeline.length === 1 &&
          !stmt.pipeline[0].redir.in &&
          !stmt.pipeline[0].redir.out &&
          !stmt.pipeline[0].redir.err &&
          !stmt.background) {
        const cmd = stmt.pipeline[0];
        const argv = this._env.applyAlias(this._expandArgv(cmd.argv));
        if (argv.length && this._builtins.has(argv[0])) {
          exit = await this._runBuiltin(argv);
          continue;
        }
      }
      this._mode = 'running';
      const processArmed = this._isLongRunningCommand(stmt);
      // 3-state machine driven by the executor's output tap.
      //   idle    : no install activity seen yet (e.g. still on a sudo prompt)
      //   active  : install/download is producing output → loop playing
      //   paused  : program is waiting on user input → loop stopped
      // Transitions happen in the tap callback below; both bells are
      // idempotent on the renderer side, so re-firing the same one is safe.
      let procState = 'idle';
      let outputTail = '';

      try {
        if (processArmed) {
          this._executor.setTap((data) => {
            const clean = String(data).replace(ANSI_STRIP_RE, '');
            // Keep only the trailing slice. Prompt detection cares about
            // what's at the end, and 256 chars is plenty for any real
            // single-line prompt while staying cheap to regex on every
            // PTY chunk (which can fire dozens of times per second).
            outputTail = (outputTail + clean).slice(-256);

            if (looksLikePrompt(outputTail)) {
              if (procState === 'active') {
                procState = 'paused';
                try { this._bell('process-stop'); } catch (_) {}
              }
              // From idle: stay idle. Don't start a sound just to stop it.
              return;
            }

            if (looksLikeInstallActivity(clean)) {
              if (procState !== 'active') {
                procState = 'active';
                try { this._bell('process-start'); } catch (_) {}
              }
            }
            // No match either way → keep current state. This is what makes
            // the loop steady: silence in the stream doesn't flap audio.
          });
        }

        exit = await this._executor.runStatements([stmt]);
      } catch (err) {
        this._emit(`${ANSI.red}hexsh: ${err.message}${ANSI.reset}\r\n`);
        exit = 1;
      } finally {
        // Always remove the tap and ensure the loop is stopped, regardless
        // of how we got here (normal exit, error, Ctrl+C). process-stop is
        // a no-op on the renderer if nothing is playing.
        try { this._executor.setTap(null); } catch (_) {}
        if (procState === 'active') {
          try { this._bell('process-stop'); } catch (_) {}
        }
        this._mode = 'editing';
      }
    }

    this._env.lastExit = exit;
    // Fire the error chime if the command failed — but not for user-driven
    // SIGINT cancels (exit 130). 127 (not found) and arbitrary failures
    // both qualify.
    if (exit !== 0 && exit !== 130) {
      try { this._bell('error'); } catch (_) {}
    }
    this._editor.begin();
  }

  _expandArgv(tokens) {
    const out = [];
    for (const tk of tokens) {
      const expanded = this._env.expandToken(tk);
      for (const v of expanded) out.push(v);
    }
    return out;
  }

  /**
   * Return true if the parsed statement looks like a long-running install
   * or download. We check every command in the pipeline so things like
   * `curl ... | tar xz` are also recognised.
   *
   * The rules are deliberately conservative — better to MISS a process
   * cue than to play one for a quick `pacman -Q` lookup.
   */
  _isLongRunningCommand(stmt) {
    if (!stmt || !stmt.pipeline) return false;
    for (const cmd of stmt.pipeline) {
      const argv = this._expandArgv(cmd.argv);
      const aliased = this._env.applyAlias(argv);
      const peeled = peelPrivilegeWrapper(aliased);
      if (!peeled.length) continue;
      const head = basename(peeled[0]);
      const rest = peeled.slice(1);
      if (LONG_RUN_RULES.some((rule) => rule(head, rest))) return true;
    }
    return false;
  }

  async _runBuiltin(argv) {
    const fn = this._builtins.get(argv[0]);
    if (!fn) return 127;
    const ctx = {
      emit:    (s) => this._emit(s),
      emitErr: (s) => this._emit(`${ANSI.red}${s}${ANSI.reset}`)
    };
    try {
      const code = await fn(argv, this._env, ctx);
      return Number.isFinite(code) ? code : 0;
    } catch (err) {
      this._emit(`${ANSI.red}${argv[0]}: ${err.message}${ANSI.reset}\r\n`);
      return 1;
    }
  }

  // -------------------------------------------------------------------------
  // Editor signals
  // -------------------------------------------------------------------------

  _onCancel() {
    this._pendingContinuation = '';
    this._env.lastExit = 130; // 128 + SIGINT
    this._editor.begin();
  }

  _onEof() {
    this._emit(`${ANSI.dim}exit${ANSI.reset}\r\n`);
    const { app } = require('electron');
    app.exit(0);
  }

  // -------------------------------------------------------------------------
  // Banner
  // -------------------------------------------------------------------------

  _banner() {
    const sysinfo = require('./sysinfo');
    this._emit('\r\n');
    sysinfo.render(this._emit, this._env);
    this._emit('\r\n');
  }
}

// ---------------------------------------------------------------------------
// Long-running command rules
// ---------------------------------------------------------------------------
// Each rule is `(head, args) => boolean`. `head` is the program name with
// directory stripped (so `/usr/bin/pacman` matches the same as `pacman`).
// `args` is the remaining argv. Order doesn't matter; the first match wins.
//
// Add new rules by appending to this array. The goal is to recognise long
// downloads / installs / builds while NOT triggering on quick lookup
// commands (`pacman -Q`, `npm ls`, `pip show`, etc.).
const LONG_RUN_RULES = [
  // ── Arch Linux package managers ─────────────────────────────────────────
  // pacman -S, -Sy, -Syu, -U all install packages. -R removes (still slow).
  // -Q is fast lookup; ignore it.
  (head, args) => head === 'pacman' && args.some((a) => /^-(?!.*Q)[A-Za-z]*[SUR]/.test(a)),
  // AUR helpers — assume any invocation is an install/build.
  (head) => head === 'paru' || head === 'yay' || head === 'pikaur' || head === 'trizen',
  (head, args) => head === 'makepkg' || (head === 'pkgctl' && args[0] === 'build'),

  // ── Debian / Ubuntu ─────────────────────────────────────────────────────
  (head, args) => head === 'apt'      && /^(install|update|upgrade|full-upgrade|build-dep|source|dist-upgrade|remove|purge)$/.test(args[0] || ''),
  (head, args) => head === 'apt-get'  && /^(install|update|upgrade|dist-upgrade|build-dep|source|remove|purge)$/.test(args[0] || ''),
  (head)       => head === 'aptitude',

  // ── Fedora / RHEL ───────────────────────────────────────────────────────
  (head, args) => (head === 'dnf' || head === 'yum') &&
                  /^(install|upgrade|update|reinstall|downgrade|remove|distro-sync|group)/.test(args[0] || ''),

  // ── openSUSE ────────────────────────────────────────────────────────────
  (head, args) => head === 'zypper' && /^(in|install|up|update|dup|patch|rm|remove|si)/.test(args[0] || ''),

  // ── Alpine ──────────────────────────────────────────────────────────────
  (head, args) => head === 'apk' && /^(add|upgrade|del|fetch)$/.test(args[0] || ''),

  // ── Cross-distro / language ecosystems ──────────────────────────────────
  (head)       => head === 'flatpak' || head === 'snap',
  (head, args) => head === 'nix-env' && /^(-i|--install|-u|--upgrade)/.test(args[0] || ''),
  (head, args) => head === 'nix' && /^(profile|build|develop|shell|flake)/.test(args[0] || ''),

  // ── Language package managers ───────────────────────────────────────────
  (head, args) => head === 'npm'  && /^(install|i|update|ci|rebuild)$/.test(args[0] || ''),
  (head, args) => head === 'yarn' && (args.length === 0 || /^(install|add|upgrade)$/.test(args[0])),
  (head, args) => head === 'pnpm' && /^(install|i|add|update|up|fetch)$/.test(args[0] || ''),
  (head, args) => head === 'bun'  && /^(install|i|add|update|upgrade)$/.test(args[0] || ''),
  (head, args) => head === 'pip'  && /^(install|download|wheel)$/.test(args[0] || ''),
  (head, args) => head === 'pip3' && /^(install|download|wheel)$/.test(args[0] || ''),
  (head, args) => head === 'pipx' && /^(install|upgrade|reinstall)$/.test(args[0] || ''),
  (head, args) => head === 'uv'   && /^(pip|sync|add|tool)$/.test(args[0] || ''),
  (head, args) => head === 'cargo'&& /^(install|build|update|fetch|publish|run)$/.test(args[0] || ''),
  (head, args) => head === 'go'   && /^(get|install|build|mod)$/.test(args[0] || ''),
  (head, args) => head === 'gem'  && /^(install|update|build)$/.test(args[0] || ''),
  (head)       => head === 'bundle' || head === 'bundler',
  (head, args) => head === 'composer' && /^(install|update|require|create-project)$/.test(args[0] || ''),

  // ── Generic build tools (often slow) ────────────────────────────────────
  (head)       => head === 'make' || head === 'cmake' || head === 'ninja' || head === 'meson',
  (head, args) => head === 'docker' && /^(build|pull|push|run|compose)$/.test(args[0] || ''),
  (head)       => head === 'docker-compose' || head === 'podman-compose',

  // ── Plain downloaders ───────────────────────────────────────────────────
  (head)       => head === 'wget' || head === 'aria2c' || head === 'rsync',
  // curl is downloads only when actually saving (-O, -o, --output).
  (head, args) => head === 'curl' && args.some((a) => a === '-O' || a === '-o' || a === '--output' || a === '--remote-name'),
  (head)       => head === 'git-lfs',
  (head, args) => head === 'git'  && /^(clone|pull|fetch|push)$/.test(args[0] || ''),
];

function basename(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * Strip leading `sudo` / `doas` / `pkexec` (and any of their flags) so the
 * underlying command's name reaches the rule table. We stop as soon as we
 * see a non-flag argument, which is the wrapped command.
 */
function peelPrivilegeWrapper(argv) {
  if (!argv || !argv.length) return argv;
  const head = basename(argv[0]);
  if (head !== 'sudo' && head !== 'doas' && head !== 'pkexec') return argv;
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (!a.startsWith('-')) break;
    // `sudo -u user` / `sudo -E` etc. consume the next arg if the flag
    // takes a value. We don't model every flag; the safe move is to skip
    // ones we know take values.
    if (a === '-u' || a === '--user' ||
        a === '-g' || a === '--group' ||
        a === '-h' || a === '--host' ||
        a === '-p' || a === '--prompt') {
      i += 2;
    } else {
      i += 1;
    }
  }
  return argv.slice(i);
}

// ---------------------------------------------------------------------------
// "Install actually started" detection
// ---------------------------------------------------------------------------
// Strip ANSI/CSI/OSC sequences and carriage-return overwrites, then look
// for substrings that strongly indicate real install/download progress
// across the package managers we recognise. The whitelist is conservative
// — we'd rather miss a niche tool than play the loop while sudo is still
// asking for a password.
//
// Why patterns + ANSI strip instead of "first non-prompt byte":
//   sudo's prompt itself is real bytes, so "first byte" would always
//   match. We need to wait for content that is unmistakably the wrapped
//   command's own output.
const ANSI_STRIP_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>78]|[\x00-\x08\x0b-\x1f]/g;

const INSTALL_ACTIVITY_RE = new RegExp([
  // pacman / paru / yay
  ':: Synchronizing package databases',
  ':: Starting full system upgrade',
  ':: Retrieving packages',
  ':: Proceed with installation',
  'downloading ',
  'installing ',
  'upgrading ',
  'reinstalling ',
  'checking keys in keyring',
  'checking package integrity',
  'loading packages',
  'resolving dependencies',
  'looking for conflicting',

  // apt / apt-get
  '\\bGet:\\d+',         // Get:1 http://...
  'Reading package lists',
  'Building dependency tree',
  'Need to get \\d',
  'Fetched \\d',
  'Setting up ',
  'Unpacking ',
  'Preparing to unpack',

  // dnf / yum
  'Downloading Packages',
  'Running transaction',
  'Installing  *:',
  'Upgrading  *:',

  // zypper
  'Retrieving repository',
  'Retrieving package',

  // npm / yarn / pnpm / bun
  'added \\d+ package',
  'changed \\d+ package',
  'removed \\d+ package',
  'audited \\d+ package',
  'Downloading\\b',
  'Resolving packages',
  '\\bFetching\\b',
  '\\bLinking\\b',
  'idealTree:',
  'reify:',

  // pip / uv
  'Collecting ',
  'Downloading ',
  'Installing collected packages',
  'Successfully installed',

  // cargo
  '\\bDownloading\\b',
  '\\bDownloaded\\b',
  '\\bCompiling\\b',
  '\\bBuilding\\b',
  '\\bInstalling\\b',

  // go
  'go: downloading',
  'go: finding',

  // docker
  'Pulling fs layer',
  'Downloading\\b',
  'Extracting\\b',
  'Pull complete',
  'Status: Downloaded',
  'Step \\d+/\\d+',

  // git
  'Cloning into',
  'remote: Counting',
  'remote: Compressing',
  'Receiving objects',
  'Resolving deltas',

  // curl / wget — they print to stderr by default; their progress headers
  // are reliable signatures.
  '%\\s*Total\\s+%\\s*Received',     // curl progress header
  '\\bDload\\s+Upload',              // curl progress sub-header
  'Length:\\s*\\d+',                 // wget Length: 12345 (gzip) [text/html]
  '--\\d{4}-\\d{2}-\\d{2}',          // wget timestamp banner
  'saved \\[\\d+',                   // wget "[1234/1234]" save line
  'Receiving objects:',
  'Resolving deltas:',
].join('|'), 'i');

function looksLikeInstallActivity(chunk) {
  if (!chunk) return false;
  // Strip ANSI/CSI and most control bytes so anchored patterns work.
  const clean = String(chunk).replace(ANSI_STRIP_RE, '');
  if (!clean.trim()) return false;
  return INSTALL_ACTIVITY_RE.test(clean);
}

// ---------------------------------------------------------------------------
// "Program is waiting for user input" detection
// ---------------------------------------------------------------------------
// Heuristic: a prompt is the LAST line of output that does NOT end in a
// newline AND ends with a recognisable prompt suffix (e.g. ": ", "? ",
// "[Y/n] ", "> "). Both conditions matter:
//   - "no newline" rules out streaming logs that happen to contain a "?".
//   - the suffix list keeps random end-of-stream slices from matching.
//
// We accept a small whitelist of common shapes used by package managers,
// authentication prompts, and pkg-build scripts. False negatives just keep
// the loop playing; false positives would make the loop stutter.
const PROMPT_RE = new RegExp(
  '(' + [
    // pacman / paru: "==> Proceed with installation? [Y/n] " or "[y/N]"
    '\\[(?:y/n|Y/n|y/N|Y/N)\\]\\s*[:?]?\\s*',
    // apt / dpkg: "Do you want to continue? [Y/n] "
    '\\?\\s+\\[(?:y|Y)[/n]?(?:N)?\\]\\s*',
    // dnf / zypper: "Is this ok [y/N]: " / "Continue? [y/n/...?]"
    '\\[[a-zA-Z/]+\\]\\s*[:?]\\s*',
    // generic "(default=N)" trailing prompt
    '\\([^)]*\\)\\s*[:?]\\s*',
    // sudo / ssh / git / authentication
    "[Pp]assword(?:\\s+for[^:]+)?\\s*:\\s*",
    "passphrase[^:]*:\\s*",
    "Username for [^:]+:\\s*",
    "Are you sure you want to continue connecting \\(.*\\)\\?\\s*",
    // pacman keyring prompts
    'Import PGP key [^?]*\\?\\s*\\[Y/n\\]\\s*',
    // npm / yarn questionnaires (some prompts use ":")
    '\\?\\s+[A-Za-z][^?]*\\?\\s*',
    // generic "press enter to continue"
    '[Pp]ress\\s+(?:any\\s+key|enter|return)[^\\n]*',
    // catch-all: a line that ends with ": " or "? " after some prompt-y
    // text. Kept last + narrow so it only matches short prompty endings,
    // not long log lines. Includes quotes so things like git's
    // `Username for 'https://...':` match.
    "[A-Za-z][A-Za-z0-9 _\\-/(),.:'\"\\?\\[\\]]{0,80}[?:]\\s+",
  ].join('|') + ')$'
);

function looksLikePrompt(tail) {
  if (!tail) return false;
  // Strip trailing CSI cursor moves that some TUI installers append after
  // the prompt text but before reading input.
  const clean = tail.replace(/\x1b\[[0-?]*[ -/]*[@-~]+$/g, '');
  // Must NOT end with a newline — newline implies the program moved on.
  if (/[\r\n]$/.test(clean)) return false;
  // Must have visible content; whitespace-only is not a prompt.
  if (!clean.trim()) return false;
  return PROMPT_RE.test(clean);
}

module.exports = { HexShell };
