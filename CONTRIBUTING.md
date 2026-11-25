# Contributing

Thanks for helping. Bug reports, fixes and reports from macOS and Linux are especially welcome.

- **Run the tests:** `npm test` (Node 22+, Chrome or Chromium installed). The MCP test fetches
  chrome-devtools-mcp with npx unless `WEBTAB_MCP_DIR` points at an installed copy; set
  `WEBTAB_SKIP_MCP_TEST=1` to skip it offline.
- **Test in Herdr:** follow [docs/manual-test.md](docs/manual-test.md) for anything that touches
  `mods/`. Run `herdr-app check mods/<name>` after each edit, and keep `"place": "none"` in every
  `mod.json`.
- **Keep it dependency-free.** The engine and installer use only Node's standard library;
  chrome-devtools-mcp is the one download, and it's pinned.
- **Security:** anything new that reaches the page or the browser goes through the token-gated
  socket or the HTTP API's Origin/Host checks; only numbers go into page scripts.
- **Herdr itself:** if something needs a Herdr change, add it to [docs/upstream.md](docs/upstream.md)
  rather than working around Herdr's shipped mods.

Keep pull requests small and say how you tested them.
