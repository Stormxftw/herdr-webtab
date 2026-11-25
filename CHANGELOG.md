# Changelog

## Unreleased

- **Guard** ([docs/guard.md](docs/guard.md)), our take on StructuPath's herdr-guard for the desktop
  app: a `PreToolUse` hook for Claude Code (Bash, PowerShell) and Codex (Bash) that blocks commands
  that can't be undone and asks first about risky ones; a watcher that flags risky commands typed into
  Herdr's shell terminals as Herdr notifications; an audit log with secrets redacted; your own rules
  in `data/webtab/guard/rules.json`; `--test` and `--recent` from the command line. `--no-guard`
  skips it, and `uninstall.mjs` removes only its own hook entries.
- **Observe-only** (👁 in the toolbar, or `"observe":true` in props): the person watches an agent
  drive and their input never reaches the page. The engine enforces it, not just the view.
- **Console strip** (▤ in the toolbar): the page's console messages, uncaught errors and failed
  requests, live under the page, with error and warning counts on the button; capped at 100 messages
  a second so a page logging in a loop can't flood Herdr.
- Community files: a full [CONTRIBUTING.md](CONTRIBUTING.md) (repo layout, how we work and test,
  Guard rule guidelines, pull request checklist), a Code of Conduct (Contributor Covenant 2.1),
  SUPPORT.md, issue forms (bug, Guard rule, feature), a pull request template, and Dependabot for
  the CI actions. Testing docs updated with the new tests, a live Claude Code check of Guard, and
  five mutation checks.
- Tests: the installer test now always uses random ports (an earlier version could reach a real
  engine on the default ports).
- Fix: typing straight after a click could overtake the click (the engine checked the click for a
  `<select>` first, while keys and text went straight through), so the first characters landed
  outside the field just clicked. Keys and text now wait in the same line as the pointer. Found as a
  "flaky" test; the test now types with no pause and failed 4 of 4 runs before the fix.
- Fix: the engine called `killTree` without importing it when Chromium wouldn't open its DevTools port.
- Docs: the full R&D log ([docs/research.md](docs/research.md)), every test and why it exists with
  screenshots from testing in Herdr ([docs/testing.md](docs/testing.md)), a complete technical
  walkthrough ([docs/how-it-works.md](docs/how-it-works.md)), and the experiment scripts
  ([experiments/](experiments/README.md)).

## 0.2.0

The first public release.

- A browser tab drawn natively in Herdr: tab strip, toolbar, dropdown menus, dialogs, a "who's
  driving" badge, and frames at the display scale.
- The engine starts on demand (from the web tab or an agent's MCP server); `--autostart` is optional.
- One-command install for Claude Code, Codex and pi (chrome-devtools-mcp 1.14.0, pinned), with an
  agent note in `AGENTS.local.md`; `uninstall.mjs` reverses it.
- Security: a token on the mod socket, Origin and Host checks on the HTTP API, no
  `--remote-allow-origins`, and only numbers interpolated into page scripts.
- Fixes found while testing: web tabs with equal props shared their state; renaming the wrong Herdr
  tab; a reload leaving an old copy streaming; the engine not recovering when Chromium died; titles
  of tabs agents opened never showing; quick tab switches racing; Chromium's blank start tab lingering;
  the page on screen freezing when an agent opened a tab next to it (each web tab now gets its own
  browser window, and agents' tabs land in a separate "dock" window); a relaunch failing while the old
  Chromium still held the profile; CDP commands that never answered stalling a view; pages that never
  move showing no frame on some headless builds.
