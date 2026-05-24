'use strict';

/**
 * HexShell iconography.
 * ──────────────────────────────────────────────────────────────────────────
 * Custom Nerd-Font-based icon system designed for the HexShell HUD aesthetic:
 * monochrome geometric glyphs, military terminal feel, no emoji, no color
 * brand logos. Renders cleanly in green phosphor.
 *
 * Source families (all bundled with MesloLGL Nerd Font Mono):
 *   - Codicons      U+EA60–U+EC1E   most generic file/folder/system glyphs
 *   - Material      U+F0001–U+F1FFF largest coverage; pick angular shapes
 *   - Font Awesome  U+F000–U+F2FF   media, archives, generic categories
 *   - Devicons      U+E700–U+E7FF   programming languages
 *   - Seti UI       U+E5FA–U+E6B4   niche file types (yaml, lua, etc.)
 *   - Octicons      U+F400–U+F4FF   git
 *   - linux         U+F300–U+F33B   distro logos (arch, debian, fedora, …)
 *
 * Glyphs are addressed by their canonical Nerd Fonts name (e.g. `dev-rust`,
 * `cod-folder`, `md-folder_download`). Codepoints come from
 * `glyphnames.generated.json`, produced by `scripts/fetch-glyphnames.mjs`
 * from the upstream `ryanoasis/nerd-fonts/glyphnames.json` cheat sheet.
 *
 * Why decouple names from codepoints:
 *   - the upstream cheat sheet IS the canonical source of truth
 *   - new contributors add glyphs by typing a NAME, not a codepoint
 *   - if upstream renames a glyph we get a clear runtime warning instead
 *     of a silently wrong shape
 *
 * Public API:
 *   const I = require('./icons');
 *   I.iconFor('foo.rs')              -> { glyph, name, kind, cell: 1 }
 *   I.iconFor('package.json')        -> { glyph, name: 'pkg.npm', ... }
 *   I.iconFor('Downloads', { dir })  -> { glyph, kind: 'xdg.downloads', ... }
 *   I.iconForCached(name, opts)      -> bounded LRU wrapper for big lists
 *   I.render('foo.rs')               -> '<glyph> foo.rs'
 *   I.glyph('dev-rust')              -> '\ue7a8'  (raw lookup)
 */

const path = require('path');

// ───────────────────────────────────────────────────────────────────────────
// Glyphnames table
// ───────────────────────────────────────────────────────────────────────────
// Loaded from a JSON file produced at install time. We tolerate it being
// absent — every G entry below has a literal codepoint fallback so the
// shell still launches if the file got corrupted or was never generated.
let GLYPH_TABLE = Object.create(null);
try {
  // eslint-disable-next-line global-require
  GLYPH_TABLE = require('./glyphnames.generated.json').glyphs || {};
} catch (_) {
  GLYPH_TABLE = Object.create(null);
}

const _missing = new Set();

/**
 * Public lookup: name → glyph (the actual character to print).
 * Logs each missing name once so contributors notice when a name no longer
 * exists upstream; never throws.
 */
function glyph(name, fallback) {
  const ch = GLYPH_TABLE[name];
  if (ch) return ch;
  if (!_missing.has(name)) {
    _missing.add(name);
    if (process.env.HEXSHELL_DEBUG) {
      // eslint-disable-next-line no-console
      console.warn(`[icons] missing nerd-font glyph: ${name}`);
    }
  }
  return fallback || '\ueb32'; // cod-question
}

/**
 * Resolve once, fall back to a literal codepoint if upstream changed names.
 * Use this in the G catalog so every glyph has a guaranteed value.
 */
function nf(name, literalFallback) { return glyph(name, literalFallback); }

// ───────────────────────────────────────────────────────────────────────────
// Glyph catalog
// ───────────────────────────────────────────────────────────────────────────
// Named so swapping a single glyph is a 1-line change. Each entry pairs
// the canonical Nerd Fonts name with the literal codepoint as a safety net
// in case the JSON file is missing.
const G = Object.freeze({
  // ── generic file/folder ───────────────────────────────────────────────
  file:           nf('cod-file',                '\uea7b'),
  folder:         nf('cod-folder',              '\uea83'),
  folderOpen:     nf('cod-folder_opened',       '\ueaf7'),
  symlink:        nf('md-link_variant',         '\uf0337'),
  binary:         nf('md-cube_outline',         '\uf01a7'),
  executable:     nf('cod-debug_start',         '\ueab2'),
  hidden:         nf('cod-eye_closed',          '\ueb52'),
  text:           nf('md-text_box',             '\uf021a'),
  unknown:        nf('cod-question',            '\ueb32'),

  // ── languages ─────────────────────────────────────────────────────────
  js:             nf('dev-javascript',          '\ue74e'),
  ts:             nf('dev-typescript',          '\ue628'),
  jsx:            nf('dev-react',               '\ue7ba'),
  py:             nf('dev-python',              '\ue73c'),
  rs:             nf('dev-rust',                '\ue7a8'),
  go:             nf('dev-go',                  '\ue724'),
  c:              nf('dev-c',                   '\ue61e'),
  cpp:            nf('dev-cplusplus',           '\ue61d'),
  java:           nf('dev-java',                '\ue738'),
  kotlin:         nf('md-language_kotlin',      '\uf0634'),
  swift:          nf('dev-swift',               '\ue755'),
  php:            nf('dev-php',                 '\ue73d'),
  ruby:           nf('dev-ruby',                '\ue739'),
  lua:            nf('seti-lua',                '\ue620'),
  zig:            nf('seti-zig',                '\ue6a9'),
  shell:          nf('dev-terminal',            '\ue795'),
  ps1:            nf('cod-terminal_powershell', '\uebc7'),
  dart:           nf('dev-dart',                '\ue798'),
  scala:          nf('dev-scala',               '\ue737'),
  r:              nf('md-language_r',           '\uf07d4'),
  haskell:        nf('dev-haskell',             '\ue777'),
  elixir:         nf('dev-elixir',              '\ue62d'),
  clojure:        nf('dev-clojure',             '\ue768'),
  perl:           nf('dev-perl',                '\ue769'),
  ocaml:          nf('seti-ocaml',              '\ue67a'),

  // ── web ───────────────────────────────────────────────────────────────
  html:           nf('dev-html5',               '\ue736'),
  css:            nf('dev-css3',                '\ue749'),
  scss:           nf('dev-sass',                '\ue74b'),
  less:           nf('dev-less',                '\ue758'),
  vue:            nf('md-vuejs',                '\uf0844'),
  svelte:         nf('dev-svelte',              '\uf09b9'),
  angular:        nf('dev-angular',             '\ue753'),

  // ── data / config ─────────────────────────────────────────────────────
  json:           nf('seti-json',               '\ue60b'),
  yaml:           nf('seti-yml',                '\ue6a8'),
  toml:           nf('md-cog',                  '\uf013'),
  xml:            nf('seti-xml',                '\ue619'),
  ini:            nf('cod-settings_gear',       '\ueb51'),
  env:            nf('md-key',                  '\uf0306'),
  gear:           nf('cod-settings_gear',       '\ueb51'),
  key:            nf('cod-key',                 '\uea75'),
  lock:           nf('fa-lock',                 '\uf023'),

  // ── version control ───────────────────────────────────────────────────
  git:            nf('md-git',                  '\uf02a2'),
  gitBranch:      nf('dev-git_branch',          '\ue725'),
  github:         nf('dev-github',              '\ue709'),
  gitlab:         nf('fa-gitlab',               '\uf296'),
  gitignore:      nf('fa-git_square',           '\uf1d3'),

  // ── builds / packagers ────────────────────────────────────────────────
  npm:            nf('dev-npm',                 '\ue71e'),
  yarn:           nf('seti-yarn',               '\ue6a7'),
  pnpm:           nf('md-package_variant',      '\uf0487'),
  bun:            nf('md-egg',                  '\uf0339'),
  cargo:          nf('dev-rust',                '\ue7a8'),
  pip:            nf('md-package_variant_closed','\uf0488'),
  make:           nf('cod-tools',               '\uea7c'),
  cmake:          nf('dev-cmake',               '\ue794'),
  docker:         nf('fa-docker',               '\uf308'),
  kubernetes:     nf('md-kubernetes',           '\uf10fe'),
  terraform:      nf('md-cube_send',            '\uf0d50'),
  ansible:        nf('md-cog_play',             '\uf109a'),

  // ── docs ──────────────────────────────────────────────────────────────
  markdown:       nf('seti-markdown',           '\ue609'),
  pdf:            nf('fa-file_pdf_o',           '\uf1c1'),
  word:           nf('fa-file_word_o',          '\uf1c2'),
  excel:          nf('fa-file_excel_o',         '\uf1c3'),
  csv:            nf('md-text_box',             '\uf021a'),
  ppt:            nf('fa-file_powerpoint_o',    '\uf1c4'),
  txt:            nf('fa-file_text_o',          '\uf0f6'),
  rtf:            nf('fa-file_text_o',          '\uf0f6'),
  license:        nf('cod-shield',              '\ueb44'),
  book:           nf('cod-book',                '\ueb6f'),

  // ── media / image ─────────────────────────────────────────────────────
  image:          nf('fa-image',                '\uf03e'),
  svg:            nf('cod-symbol_color',        '\ueae8'),
  vector:         nf('cod-symbol_color',        '\ueae8'),
  font:           nf('fa-font',                 '\uf031'),
  audio:          nf('fa-music',                '\uf001'),
  video:          nf('fa-video_camera',         '\uf03d'),
  movie:          nf('fa-video_camera',         '\uf03d'),

  // ── archive / package ─────────────────────────────────────────────────
  archive:        nf('fa-file_archive_o',       '\uf1c6'),
  zip:            nf('fa-file_archive_o',       '\uf1c6'),
  iso:            nf('cod-file_binary',         '\ueb39'),
  pkg:            nf('md-package_variant',      '\uf0487'),
  appImage:       nf('linux-archlinux',         '\uf303'),

  // ── system / OS ───────────────────────────────────────────────────────
  // Use the `linux-*` family — proper distro logos, monochrome, single cell.
  linux:          nf('fa-linux',                '\uf17c'),
  arch:           nf('linux-archlinux',         '\uf303'),
  debian:         nf('linux-debian',            '\uf306'),
  ubuntu:         nf('linux-ubuntu',            '\uf31b'),
  fedora:         nf('linux-fedora',            '\uf30a'),
  redhat:         nf('linux-redhat',            '\uf316'),
  manjaro:        nf('linux-manjaro',           '\uf312'),
  alpine:         nf('linux-alpine',            '\uf300'),

  // ── HUD / military / network ──────────────────────────────────────────
  network:        nf('md-network',              '\uf06f3'),
  server:         nf('cod-server',              '\ueb05'),
  database:       nf('cod-database',            '\ueb12'),
  chip:           nf('fa-microchip',            '\uf2db'),
  shield:         nf('fa-shield',               '\uf132'),
  radar:          nf('cod-pulse',               '\uebbe'),
  signal:         nf('fa-signal',               '\uf012'),
  beacon:         nf('cod-broadcast',           '\ueae6'),

  // ── folders (specialized) ─────────────────────────────────────────────
  folderHome:     nf('md-home',                 '\uf02dc'),
  folderConfig:   nf('cod-settings_gear',       '\ueb51'),
  folderDownload: nf('md-folder_download',      '\uf024d'),
  folderImage:    nf('md-folder_image',         '\uf024f'),
  folderMusic:    nf('md-folder_music',         '\uf0330'),
  folderMovie:    nf('md-folder_play',          '\uf0331'),
  folderDocument: nf('md-folder_text',          '\uf0334'),
  folderDesktop:  nf('md-monitor',              '\uf0379'),
  folderProject:  nf('cod-folder',              '\uea83'),
  folderGit:      nf('seti-git',                '\ue5fb'),
  folderNode:     nf('md-nodejs',               '\uf0399'),
  folderRust:     nf('dev-rust',                '\ue7a8'),
  folderPython:   nf('dev-python',              '\ue73c'),
  folderGo:       nf('dev-go',                  '\ue724'),
  folderJava:     nf('dev-java',                '\ue738'),
  folderHidden:   nf('cod-eye_closed',          '\ueb52'),
  folderTrash:    nf('cod-trash',               '\uea81'),
  folderLock:     nf('md-folder_lock',          '\uf0250'),
});

// ───────────────────────────────────────────────────────────────────────────
// Mapping tables
// ───────────────────────────────────────────────────────────────────────────
// Each entry: [glyph, kind]. `kind` is a stable string the renderer can use
// to colorize / categorize — currently we render everything in the foreground
// color, but a future "category palette" can group these into hot/warm/cold.

const ENTRY = (glyph, kind) => ({ glyph, kind });

// Exact filename matches — highest priority, beats extension lookup.
// Lowercased on insert; we lowercase the basename at lookup time.
const NAMES_RAW = {
  // package manifests
  'package.json':         ENTRY(G.npm,            'pkg.npm'),
  'package-lock.json':    ENTRY(G.npm,            'pkg.npm.lock'),
  'yarn.lock':            ENTRY(G.yarn,           'pkg.yarn.lock'),
  'pnpm-lock.yaml':       ENTRY(G.pnpm,           'pkg.pnpm.lock'),
  'bun.lock':             ENTRY(G.bun,            'pkg.bun.lock'),
  'bun.lockb':            ENTRY(G.bun,            'pkg.bun.lock'),
  'cargo.toml':           ENTRY(G.cargo,          'pkg.cargo'),
  'cargo.lock':           ENTRY(G.cargo,          'pkg.cargo.lock'),
  'go.mod':               ENTRY(G.go,             'pkg.go'),
  'go.sum':               ENTRY(G.go,             'pkg.go.lock'),
  'gemfile':              ENTRY(G.ruby,           'pkg.ruby'),
  'gemfile.lock':         ENTRY(G.ruby,           'pkg.ruby.lock'),
  'requirements.txt':     ENTRY(G.pip,            'pkg.pip'),
  'pipfile':              ENTRY(G.pip,            'pkg.pip'),
  'pipfile.lock':         ENTRY(G.pip,            'pkg.pip.lock'),
  'pyproject.toml':       ENTRY(G.py,             'pkg.python'),
  'composer.json':        ENTRY(G.php,            'pkg.php'),
  'composer.lock':        ENTRY(G.php,            'pkg.php.lock'),
  'pkgbuild':             ENTRY(G.arch,           'pkg.arch'),
  '.srcinfo':             ENTRY(G.arch,           'pkg.arch'),

  // build / infra
  'makefile':             ENTRY(G.make,           'build.make'),
  'gnumakefile':          ENTRY(G.make,           'build.make'),
  'cmakelists.txt':       ENTRY(G.cmake,          'build.cmake'),
  'meson.build':          ENTRY(G.cmake,          'build.meson'),
  'dockerfile':           ENTRY(G.docker,         'infra.docker'),
  'docker-compose.yml':   ENTRY(G.docker,         'infra.docker'),
  'docker-compose.yaml':  ENTRY(G.docker,         'infra.docker'),
  '.dockerignore':        ENTRY(G.docker,         'infra.docker'),
  'kubernetes.yaml':      ENTRY(G.kubernetes,     'infra.k8s'),
  'kustomization.yaml':   ENTRY(G.kubernetes,     'infra.k8s'),
  'main.tf':              ENTRY(G.terraform,      'infra.terraform'),
  'ansible.cfg':          ENTRY(G.ansible,        'infra.ansible'),

  // git
  '.gitignore':           ENTRY(G.gitignore,      'vcs.git.ignore'),
  '.gitattributes':       ENTRY(G.git,            'vcs.git'),
  '.gitmodules':          ENTRY(G.git,            'vcs.git'),
  '.gitconfig':           ENTRY(G.git,            'vcs.git'),
  '.gitkeep':             ENTRY(G.git,            'vcs.git'),

  // docs
  'readme':               ENTRY(G.book,           'doc.readme'),
  'readme.md':            ENTRY(G.book,           'doc.readme'),
  'readme.txt':           ENTRY(G.book,           'doc.readme'),
  'changelog':            ENTRY(G.markdown,       'doc.changelog'),
  'changelog.md':         ENTRY(G.markdown,       'doc.changelog'),
  'license':              ENTRY(G.license,        'doc.license'),
  'license.md':           ENTRY(G.license,        'doc.license'),
  'license.txt':          ENTRY(G.license,        'doc.license'),
  'copying':              ENTRY(G.license,        'doc.license'),
  'authors':              ENTRY(G.license,        'doc.authors'),
  'contributors':         ENTRY(G.license,        'doc.authors'),
  'contributing.md':      ENTRY(G.markdown,       'doc.contrib'),
  'code_of_conduct.md':   ENTRY(G.markdown,       'doc.coc'),

  // shell rc
  '.bashrc':              ENTRY(G.shell,          'rc.bash'),
  '.bash_profile':        ENTRY(G.shell,          'rc.bash'),
  '.bash_logout':         ENTRY(G.shell,          'rc.bash'),
  '.bash_history':        ENTRY(G.shell,          'rc.bash'),
  '.zshrc':               ENTRY(G.shell,          'rc.zsh'),
  '.zsh_history':         ENTRY(G.shell,          'rc.zsh'),
  '.zprofile':            ENTRY(G.shell,          'rc.zsh'),
  '.profile':             ENTRY(G.shell,          'rc.shell'),
  '.inputrc':             ENTRY(G.shell,          'rc.readline'),

  // editor rc
  '.vimrc':               ENTRY(G.gear,           'rc.vim'),
  '.gvimrc':              ENTRY(G.gear,           'rc.vim'),
  '.editorconfig':        ENTRY(G.gear,           'rc.editor'),

  // tool rc
  '.prettierrc':          ENTRY(G.gear,           'rc.prettier'),
  '.prettierrc.json':     ENTRY(G.gear,           'rc.prettier'),
  '.eslintrc':            ENTRY(G.gear,           'rc.eslint'),
  '.eslintrc.json':       ENTRY(G.gear,           'rc.eslint'),
  '.eslintrc.js':         ENTRY(G.gear,           'rc.eslint'),
  '.babelrc':             ENTRY(G.gear,           'rc.babel'),
  '.npmrc':               ENTRY(G.gear,           'rc.npm'),
  '.nvmrc':               ENTRY(G.gear,           'rc.nvm'),
  '.swcrc':               ENTRY(G.gear,           'rc.swc'),

  // env / secrets
  '.env':                 ENTRY(G.env,            'env'),
  '.env.local':           ENTRY(G.env,            'env'),
  '.env.example':         ENTRY(G.env,            'env'),
  '.env.development':     ENTRY(G.env,            'env'),
  '.env.production':      ENTRY(G.env,            'env'),
};
const NAMES = new Map(Object.entries(NAMES_RAW).map(([k, v]) => [k.toLowerCase(), v]));

// Compound extensions — checked BEFORE single-extension lookup. Ordered
// from most specific to least so .pkg.tar.zst beats .tar.zst beats .zst.
const COMPOUND_EXT = [
  ['.pkg.tar.zst',  ENTRY(G.arch,    'pkg.arch')],
  ['.pkg.tar.xz',   ENTRY(G.arch,    'pkg.arch')],
  ['.tar.gz',       ENTRY(G.archive, 'archive')],
  ['.tar.xz',       ENTRY(G.archive, 'archive')],
  ['.tar.bz2',      ENTRY(G.archive, 'archive')],
  ['.tar.zst',      ENTRY(G.archive, 'archive')],
  ['.tar.lz',       ENTRY(G.archive, 'archive')],
  ['.tar.lzma',     ENTRY(G.archive, 'archive')],
  ['.d.ts',         ENTRY(G.ts,      'lang.ts.decl')],
];

// Single extension table.
const EXT_RAW = {
  // ── languages ────
  '.js':            ENTRY(G.js,         'lang.javascript'),
  '.mjs':           ENTRY(G.js,         'lang.javascript'),
  '.cjs':           ENTRY(G.js,         'lang.javascript'),
  '.ts':            ENTRY(G.ts,         'lang.typescript'),
  '.mts':           ENTRY(G.ts,         'lang.typescript'),
  '.cts':           ENTRY(G.ts,         'lang.typescript'),
  '.jsx':           ENTRY(G.jsx,        'lang.react'),
  '.tsx':           ENTRY(G.jsx,        'lang.react'),
  '.py':            ENTRY(G.py,         'lang.python'),
  '.pyc':           ENTRY(G.py,         'lang.python.bytecode'),
  '.pyi':           ENTRY(G.py,         'lang.python.stub'),
  '.rs':            ENTRY(G.rs,         'lang.rust'),
  '.go':            ENTRY(G.go,         'lang.go'),
  '.c':             ENTRY(G.c,          'lang.c'),
  '.h':             ENTRY(G.c,          'lang.c.header'),
  '.cpp':           ENTRY(G.cpp,        'lang.cpp'),
  '.cc':            ENTRY(G.cpp,        'lang.cpp'),
  '.cxx':           ENTRY(G.cpp,        'lang.cpp'),
  '.hpp':           ENTRY(G.cpp,        'lang.cpp.header'),
  '.hh':            ENTRY(G.cpp,        'lang.cpp.header'),
  '.java':          ENTRY(G.java,       'lang.java'),
  '.class':         ENTRY(G.java,       'lang.java.class'),
  '.jar':           ENTRY(G.java,       'lang.java.archive'),
  '.kt':            ENTRY(G.kotlin,     'lang.kotlin'),
  '.kts':           ENTRY(G.kotlin,     'lang.kotlin.script'),
  '.swift':         ENTRY(G.swift,      'lang.swift'),
  '.php':           ENTRY(G.php,        'lang.php'),
  '.rb':            ENTRY(G.ruby,       'lang.ruby'),
  '.lua':           ENTRY(G.lua,        'lang.lua'),
  '.zig':           ENTRY(G.zig,        'lang.zig'),
  '.sh':            ENTRY(G.shell,      'lang.shell'),
  '.bash':          ENTRY(G.shell,      'lang.bash'),
  '.zsh':           ENTRY(G.shell,      'lang.zsh'),
  '.fish':          ENTRY(G.shell,      'lang.fish'),
  '.ps1':           ENTRY(G.ps1,        'lang.powershell'),
  '.psm1':          ENTRY(G.ps1,        'lang.powershell'),
  '.dart':          ENTRY(G.dart,       'lang.dart'),
  '.scala':         ENTRY(G.scala,      'lang.scala'),
  '.sbt':           ENTRY(G.scala,      'lang.scala.build'),
  '.r':             ENTRY(G.r,          'lang.r'),
  '.rmd':           ENTRY(G.r,          'lang.rmarkdown'),
  '.hs':            ENTRY(G.haskell,    'lang.haskell'),
  '.lhs':           ENTRY(G.haskell,    'lang.haskell'),
  '.ex':            ENTRY(G.elixir,     'lang.elixir'),
  '.exs':           ENTRY(G.elixir,     'lang.elixir'),
  '.erl':           ENTRY(G.elixir,     'lang.erlang'),
  '.clj':           ENTRY(G.clojure,    'lang.clojure'),
  '.cljs':          ENTRY(G.clojure,    'lang.clojurescript'),
  '.pl':            ENTRY(G.perl,       'lang.perl'),
  '.pm':            ENTRY(G.perl,       'lang.perl'),
  '.ml':            ENTRY(G.ocaml,      'lang.ocaml'),
  '.mli':           ENTRY(G.ocaml,      'lang.ocaml'),

  // ── web ────
  '.html':          ENTRY(G.html,       'web.html'),
  '.htm':           ENTRY(G.html,       'web.html'),
  '.xhtml':         ENTRY(G.html,       'web.html'),
  '.css':           ENTRY(G.css,        'web.css'),
  '.scss':          ENTRY(G.scss,       'web.scss'),
  '.sass':          ENTRY(G.scss,       'web.sass'),
  '.less':          ENTRY(G.less,       'web.less'),
  '.styl':          ENTRY(G.less,       'web.stylus'),
  '.vue':           ENTRY(G.vue,        'web.vue'),
  '.svelte':        ENTRY(G.svelte,     'web.svelte'),
  '.astro':         ENTRY(G.svelte,     'web.astro'),

  // ── data / config ────
  '.json':          ENTRY(G.json,       'data.json'),
  '.json5':         ENTRY(G.json,       'data.json'),
  '.jsonc':         ENTRY(G.json,       'data.json'),
  '.yaml':          ENTRY(G.yaml,       'data.yaml'),
  '.yml':           ENTRY(G.yaml,       'data.yaml'),
  '.toml':          ENTRY(G.toml,       'data.toml'),
  '.xml':           ENTRY(G.xml,        'data.xml'),
  '.plist':         ENTRY(G.xml,        'data.plist'),
  '.ini':           ENTRY(G.ini,        'config.ini'),
  '.cfg':           ENTRY(G.ini,        'config.ini'),
  '.conf':          ENTRY(G.ini,        'config.conf'),
  '.properties':    ENTRY(G.ini,        'config.properties'),
  '.env':           ENTRY(G.env,        'env'),
  '.lock':          ENTRY(G.lock,       'lock.generic'),

  // ── docs ────
  '.md':            ENTRY(G.markdown,   'doc.markdown'),
  '.markdown':      ENTRY(G.markdown,   'doc.markdown'),
  '.mdx':           ENTRY(G.markdown,   'doc.mdx'),
  '.rst':           ENTRY(G.markdown,   'doc.rst'),
  '.adoc':          ENTRY(G.markdown,   'doc.asciidoc'),
  '.tex':           ENTRY(G.text,       'doc.tex'),
  '.txt':           ENTRY(G.txt,        'doc.text'),
  '.rtf':           ENTRY(G.rtf,        'doc.rtf'),
  '.pdf':           ENTRY(G.pdf,        'doc.pdf'),
  '.doc':           ENTRY(G.word,       'doc.word'),
  '.docx':          ENTRY(G.word,       'doc.word'),
  '.odt':           ENTRY(G.word,       'doc.opendoc'),
  '.xls':           ENTRY(G.excel,      'doc.excel'),
  '.xlsx':          ENTRY(G.excel,      'doc.excel'),
  '.ods':           ENTRY(G.excel,      'doc.opendoc'),
  '.csv':           ENTRY(G.csv,        'doc.csv'),
  '.tsv':           ENTRY(G.csv,        'doc.csv'),
  '.ppt':           ENTRY(G.ppt,        'doc.ppt'),
  '.pptx':          ENTRY(G.ppt,        'doc.ppt'),
  '.epub':          ENTRY(G.book,       'doc.epub'),
  '.mobi':          ENTRY(G.book,       'doc.book'),
  '.djvu':          ENTRY(G.book,       'doc.book'),

  // ── images ────
  '.png':           ENTRY(G.image,      'media.image'),
  '.jpg':           ENTRY(G.image,      'media.image'),
  '.jpeg':          ENTRY(G.image,      'media.image'),
  '.webp':          ENTRY(G.image,      'media.image'),
  '.gif':           ENTRY(G.image,      'media.image'),
  '.bmp':           ENTRY(G.image,      'media.image'),
  '.tif':           ENTRY(G.image,      'media.image'),
  '.tiff':          ENTRY(G.image,      'media.image'),
  '.ico':           ENTRY(G.image,      'media.image'),
  '.heic':          ENTRY(G.image,      'media.image'),
  '.avif':          ENTRY(G.image,      'media.image'),
  '.svg':           ENTRY(G.svg,        'media.vector'),
  '.svgz':          ENTRY(G.svg,        'media.vector'),
  '.eps':           ENTRY(G.vector,     'media.vector'),
  '.ai':            ENTRY(G.vector,     'media.vector'),
  '.psd':           ENTRY(G.image,      'media.raster'),
  '.xcf':           ENTRY(G.image,      'media.raster'),

  // ── audio ────
  '.mp3':           ENTRY(G.audio,      'media.audio'),
  '.wav':           ENTRY(G.audio,      'media.audio'),
  '.flac':          ENTRY(G.audio,      'media.audio'),
  '.ogg':           ENTRY(G.audio,      'media.audio'),
  '.opus':          ENTRY(G.audio,      'media.audio'),
  '.m4a':           ENTRY(G.audio,      'media.audio'),
  '.aac':           ENTRY(G.audio,      'media.audio'),
  '.alac':          ENTRY(G.audio,      'media.audio'),
  '.aiff':          ENTRY(G.audio,      'media.audio'),
  '.mid':           ENTRY(G.audio,      'media.midi'),
  '.midi':          ENTRY(G.audio,      'media.midi'),

  // ── video ────
  '.mp4':           ENTRY(G.video,      'media.video'),
  '.mkv':           ENTRY(G.video,      'media.video'),
  '.avi':           ENTRY(G.video,      'media.video'),
  '.mov':           ENTRY(G.video,      'media.video'),
  '.webm':          ENTRY(G.video,      'media.video'),
  '.m4v':           ENTRY(G.video,      'media.video'),
  '.flv':           ENTRY(G.video,      'media.video'),
  '.wmv':           ENTRY(G.video,      'media.video'),

  // ── fonts ────
  '.ttf':           ENTRY(G.font,       'media.font'),
  '.otf':           ENTRY(G.font,       'media.font'),
  '.woff':          ENTRY(G.font,       'media.font'),
  '.woff2':         ENTRY(G.font,       'media.font'),

  // ── archives ────
  '.zip':           ENTRY(G.zip,        'archive'),
  '.7z':            ENTRY(G.archive,    'archive'),
  '.rar':           ENTRY(G.archive,    'archive'),
  '.tar':           ENTRY(G.archive,    'archive'),
  '.gz':            ENTRY(G.archive,    'archive'),
  '.bz2':           ENTRY(G.archive,    'archive'),
  '.xz':            ENTRY(G.archive,    'archive'),
  '.zst':           ENTRY(G.archive,    'archive'),
  '.lz':            ENTRY(G.archive,    'archive'),
  '.lzma':          ENTRY(G.archive,    'archive'),
  '.cab':           ENTRY(G.archive,    'archive'),

  // ── system / packages ────
  '.iso':           ENTRY(G.iso,        'system.iso'),
  '.img':           ENTRY(G.iso,        'system.image'),
  '.vmdk':          ENTRY(G.iso,        'system.vm'),
  '.qcow2':         ENTRY(G.iso,        'system.vm'),
  '.appimage':      ENTRY(G.appImage,   'pkg.appimage'),
  '.deb':           ENTRY(G.debian,     'pkg.deb'),
  '.rpm':           ENTRY(G.redhat,     'pkg.rpm'),
  '.flatpak':       ENTRY(G.linux,      'pkg.flatpak'),
  '.snap':          ENTRY(G.linux,      'pkg.snap'),

  // ── binary / executable ────
  '.so':            ENTRY(G.binary,     'bin.shared'),
  '.dll':           ENTRY(G.binary,     'bin.shared'),
  '.dylib':         ENTRY(G.binary,     'bin.shared'),
  '.a':             ENTRY(G.binary,     'bin.static'),
  '.o':             ENTRY(G.binary,     'bin.object'),
  '.exe':           ENTRY(G.executable, 'bin.exe'),
  '.bin':           ENTRY(G.binary,     'bin'),
  '.elf':           ENTRY(G.binary,     'bin'),

  // ── git ────
  '.patch':         ENTRY(G.git,        'vcs.patch'),
  '.diff':          ENTRY(G.git,        'vcs.diff'),

  // ── data / db ────
  '.sql':           ENTRY(G.database,   'data.sql'),
  '.sqlite':        ENTRY(G.database,   'data.sqlite'),
  '.sqlite3':       ENTRY(G.database,   'data.sqlite'),
  '.db':            ENTRY(G.database,   'data.db'),
  '.parquet':       ENTRY(G.database,   'data.parquet'),
};
const EXT = new Map(Object.entries(EXT_RAW).map(([k, v]) => [k.toLowerCase(), v]));

// Special directory names. Lowercased. Matched on basename.
const DIRS_RAW = {
  // language ecosystems
  'node_modules':   ENTRY(G.folderNode,    'dir.node_modules'),
  '.cargo':         ENTRY(G.folderRust,    'dir.cargo'),
  'target':         ENTRY(G.folderRust,    'dir.rust.target'),
  '__pycache__':    ENTRY(G.folderPython,  'dir.pycache'),
  '.venv':          ENTRY(G.folderPython,  'dir.venv'),
  'venv':           ENTRY(G.folderPython,  'dir.venv'),
  'site-packages':  ENTRY(G.folderPython,  'dir.site-packages'),
  'vendor':         ENTRY(G.folderGo,      'dir.vendor'),
  '.gradle':        ENTRY(G.folderJava,    'dir.gradle'),
  '.m2':            ENTRY(G.folderJava,    'dir.maven'),

  // git / vcs
  '.git':           ENTRY(G.folderGit,     'dir.git'),
  '.github':        ENTRY(G.github,        'dir.github'),
  '.gitlab':        ENTRY(G.gitlab,        'dir.gitlab'),

  // build outputs
  'dist':           ENTRY(G.folderProject, 'dir.dist'),
  'build':          ENTRY(G.folderProject, 'dir.build'),
  'out':            ENTRY(G.folderProject, 'dir.out'),
  'output':         ENTRY(G.folderProject, 'dir.out'),
  'public':         ENTRY(G.folderProject, 'dir.public'),
  'static':         ENTRY(G.folderProject, 'dir.static'),
  'assets':         ENTRY(G.folderImage,   'dir.assets'),
  'src':            ENTRY(G.folderProject, 'dir.src'),
  'lib':            ENTRY(G.folderProject, 'dir.lib'),
  'tests':          ENTRY(G.folderProject, 'dir.tests'),
  'test':           ENTRY(G.folderProject, 'dir.tests'),
  '__tests__':      ENTRY(G.folderProject, 'dir.tests'),
  'spec':           ENTRY(G.folderProject, 'dir.spec'),
  'docs':           ENTRY(G.folderDocument,'dir.docs'),
  'doc':            ENTRY(G.folderDocument,'dir.docs'),
  'scripts':        ENTRY(G.shell,         'dir.scripts'),
  'bin':            ENTRY(G.binary,        'dir.bin'),

  // cache / temp
  '.cache':         ENTRY(G.folderHidden,  'dir.cache'),
  'cache':          ENTRY(G.folderHidden,  'dir.cache'),
  '.tmp':           ENTRY(G.folderHidden,  'dir.tmp'),
  'tmp':            ENTRY(G.folderHidden,  'dir.tmp'),
  'temp':           ENTRY(G.folderHidden,  'dir.tmp'),
  'logs':           ENTRY(G.folderHidden,  'dir.logs'),
  'log':            ENTRY(G.folderHidden,  'dir.logs'),
  '.next':          ENTRY(G.folderProject, 'dir.next'),
  '.nuxt':          ENTRY(G.folderProject, 'dir.nuxt'),
  '.svelte-kit':    ENTRY(G.folderProject, 'dir.sveltekit'),
  '.parcel-cache':  ENTRY(G.folderHidden,  'dir.parcel'),
  'coverage':       ENTRY(G.folderHidden,  'dir.coverage'),

  // user / xdg
  'desktop':        ENTRY(G.folderDesktop, 'xdg.desktop'),
  'documents':      ENTRY(G.folderDocument,'xdg.documents'),
  'downloads':      ENTRY(G.folderDownload,'xdg.downloads'),
  'pictures':       ENTRY(G.folderImage,   'xdg.pictures'),
  'music':          ENTRY(G.folderMusic,   'xdg.music'),
  'videos':         ENTRY(G.folderMovie,   'xdg.videos'),
  'movies':         ENTRY(G.folderMovie,   'xdg.videos'),
  'projects':       ENTRY(G.folderProject, 'xdg.projects'),
  'public':         ENTRY(G.folderProject, 'xdg.public'),
  'templates':      ENTRY(G.folderProject, 'xdg.templates'),
  'trash':          ENTRY(G.folderTrash,   'xdg.trash'),
  '.trash':         ENTRY(G.folderTrash,   'xdg.trash'),

  // dotfile homes
  '.config':        ENTRY(G.folderConfig,  'dir.config'),
  '.local':         ENTRY(G.folderConfig,  'dir.local'),
  '.ssh':           ENTRY(G.folderLock,    'dir.ssh'),
  '.gnupg':         ENTRY(G.folderLock,    'dir.gnupg'),
  '.aws':           ENTRY(G.folderLock,    'dir.aws'),
  '.kube':          ENTRY(G.kubernetes,    'dir.kube'),
  '.docker':        ENTRY(G.docker,        'dir.docker'),
  '.vscode':        ENTRY(G.gear,          'dir.vscode'),
  '.idea':          ENTRY(G.gear,          'dir.idea'),
  '.vim':           ENTRY(G.gear,          'dir.vim'),
  '.bun':           ENTRY(G.bun,           'dir.bun'),
  '.npm':           ENTRY(G.npm,           'dir.npm'),
  '.yarn':          ENTRY(G.yarn,          'dir.yarn'),

  // system
  'etc':            ENTRY(G.gear,          'sys.etc'),
  'usr':            ENTRY(G.linux,         'sys.usr'),
  'var':            ENTRY(G.database,      'sys.var'),
  'home':           ENTRY(G.folderHome,    'sys.home'),
  'root':           ENTRY(G.shield,        'sys.root'),
  'opt':            ENTRY(G.pkg,           'sys.opt'),
  'tmp/':           ENTRY(G.folderHidden,  'sys.tmp'),
};
const DIRS = new Map(Object.entries(DIRS_RAW).map(([k, v]) => [k.toLowerCase(), v]));

// ───────────────────────────────────────────────────────────────────────────
// Detection
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resolve an icon for a single name.
 *
 * @param {string}  name           file/dir basename (or path; we strip dir)
 * @param {object}  [opts]
 * @param {boolean} [opts.dir]     true if known to be a directory
 * @param {boolean} [opts.exec]    true if executable bit set
 * @param {boolean} [opts.symlink] true if symlink
 * @returns {{ glyph:string, kind:string, name:string, cell:1 }}
 */
function iconFor(name, opts) {
  if (typeof name !== 'string' || name.length === 0) return mk(G.unknown, 'unknown', 'unknown');
  const o = opts || {};
  const base = path.basename(name).replace(/\/+$/, '');
  const lower = base.toLowerCase();

  // 1. Symlink overlay — single arrow glyph regardless of target type.
  if (o.symlink) return mk(G.symlink, 'symlink', 'symlink');

  // 2. Directories.
  if (o.dir) {
    const hit = DIRS.get(lower);
    if (hit) return mk(hit.glyph, hit.kind, lower);
    if (lower.startsWith('.')) return mk(G.folderHidden, 'dir.hidden', 'hidden');
    return mk(G.folder, 'dir.generic', 'folder');
  }

  // 3. Exact filename.
  const exact = NAMES.get(lower);
  if (exact) return mk(exact.glyph, exact.kind, lower);

  // 4. Compound extensions (.tar.gz etc.).
  for (const [ext, entry] of COMPOUND_EXT) {
    if (lower.endsWith(ext)) return mk(entry.glyph, entry.kind, ext);
  }

  // 5. Single extension.
  const ext = path.extname(lower);
  if (ext && ext.length > 1) {
    const entry = EXT.get(ext);
    if (entry) return mk(entry.glyph, entry.kind, ext);
  }

  // 6. Hidden file fallback.
  if (lower.startsWith('.') && !ext) return mk(G.hidden, 'file.hidden', 'hidden');

  // 7. Executable but no extension (./run, /usr/bin/foo).
  if (o.exec) return mk(G.executable, 'bin.exec', 'executable');

  // 8. Final fallback.
  return mk(G.file, 'file.generic', 'file');
}

function mk(glyph, kind, name) { return { glyph, kind, name, cell: 1 }; }

/**
 * Convenience wrappers — slimmer call sites in editors / completers.
 */
function iconForFile(name, opts)      { return iconFor(name, { ...opts, dir: false }); }
function iconForDirectory(name)        { return iconFor(name, { dir: true }); }

/**
 * Render `<glyph>SP<name>` ready to drop into a terminal listing.
 *
 * Why a single trailing space, not two:
 *   In MesloLGL Nerd Font Mono every NF glyph is one cell wide, and the
 *   monospace baseline gives glyphs natural side-bearing. One space is
 *   enough to keep the name from kissing the icon. If you want columnar
 *   alignment across rows, prefer `pad(name)` callers control instead.
 */
function render(name, opts) {
  const i = iconFor(name, opts);
  return `${i.glyph} ${name}`;
}

/**
 * Cached lookup. Many directory listings repeat the same extension; we
 * memoize by `${dirFlag}|${lower}` so re-rendering 10k entries doesn't
 * re-hit the maps. Cache is bounded by simple LRU-via-recreate.
 */
const _cache = new Map();
const CACHE_MAX = 4096;
function iconForCached(name, opts) {
  const o = opts || {};
  const key = `${o.dir ? 'D' : 'F'}${o.exec ? 'X' : ''}${o.symlink ? 'L' : ''}|${name}`;
  let hit = _cache.get(key);
  if (hit) return hit;
  hit = iconFor(name, opts);
  if (_cache.size >= CACHE_MAX) _cache.clear();
  _cache.set(key, hit);
  return hit;
}

module.exports = {
  iconFor,
  iconForFile,
  iconForDirectory,
  iconForCached,
  render,
  glyph,                 // raw lookup by Nerd Fonts canonical name
  glyphs: G,
  // Exposed for tests / extension by users.
  _maps: { NAMES, EXT, COMPOUND_EXT, DIRS }
};
