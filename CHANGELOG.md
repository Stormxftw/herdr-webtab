# Changelog

## Unreleased

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
