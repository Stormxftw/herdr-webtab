# Changelog

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
  of tabs agents opened never showing; quick tab switches racing; Chromium's blank start tab lingering.
