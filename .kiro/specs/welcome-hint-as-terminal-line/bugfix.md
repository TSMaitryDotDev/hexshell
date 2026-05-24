# Bugfix Requirements Document

## Introduction

On session start, Hexshell shows the hint "type help for keybindings + builtins" twice: once as a floating HUD overlay (`#hud-hint`) anchored under the titlebar and once as a real terminal-output line emitted by the shell's welcome banner in `sysinfo.js`. The overlay is `position: fixed`, lands on top of the first shell prompt, fades in after the boot animation, and auto-dismisses after 8 seconds or on the first keystroke — leaving no trace in the terminal scrollback. The user wants the hint to be a plain terminal line that sits on its own line directly above the first prompt and persists in scrollback as ordinary output. The fix is to remove the floating HUD hint entirely so only the shell-printed line remains.

## Bug Analysis

### Current Behavior (Defect)

The hint is rendered as a transient floating overlay that obscures the terminal and is also emitted by the shell, so it appears twice and the overlay covers the first prompt.

1.1 WHEN a new Hexshell session starts THEN the system renders the hint "type help for keybindings + builtins" as a floating HUD overlay element (`#hud-hint`) positioned `fixed` over the terminal area
1.2 WHEN the HUD hint overlay is rendered THEN the system places it on top of the first shell prompt, visually overlapping terminal output rather than sitting on its own line above the prompt
1.3 WHEN 8 seconds elapse after the overlay appears OR the user presses any key THEN the system fades out and removes the HUD hint overlay, leaving no record of the hint in the terminal scrollback
1.4 WHEN a new session starts THEN the system emits the hint text twice — once via the HUD overlay (`#hud-hint` / `installHint()` IIFE) and once via the shell welcome banner in `sysinfo.js`

### Expected Behavior (Correct)

The hint comes from the shell as a single, persistent terminal line that lives in scrollback above the first prompt — never as a floating overlay.

2.1 WHEN a new Hexshell session starts THEN the system SHALL render the hint "type help for keybindings + builtins" only as a real terminal-output line printed by the shell, with no HUD overlay rendered
2.2 WHEN the shell prints the hint THEN the system SHALL place it on its own line directly above the first shell prompt as ordinary terminal output
2.3 WHEN time elapses OR the user presses keys after the hint is printed THEN the system SHALL leave the hint in the terminal scrollback unchanged (no auto-fade, no auto-removal)
2.4 WHEN a new session starts THEN the system SHALL emit the hint text exactly once

### Unchanged Behavior (Regression Prevention)

The rest of the welcome banner, terminal input handling, and other HUD chrome must keep working as before.

3.1 WHEN a new session starts THEN the system SHALL CONTINUE TO render the remainder of the `sysinfo.js` welcome banner (header bar, OS info, emblem, palette block, footer rule) unchanged
3.2 WHEN the user presses keys after session start THEN the system SHALL CONTINUE TO route those keys to the terminal/shell as input
3.3 WHEN the application boots THEN the system SHALL CONTINUE TO display all other HUD elements (titlebar, `hud-grid`, `hud-scan`, `hud-flicker`, clock, screenshot notice, etc.) unchanged
3.4 WHEN the first shell prompt is drawn THEN the system SHALL CONTINUE TO render it correctly with no other element overlapping it
3.5 WHEN a user has `prefers-reduced-motion` set THEN the system SHALL CONTINUE TO honor reduced-motion behavior for all remaining HUD animations
