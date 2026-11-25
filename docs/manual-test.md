# Testing inside Herdr

`npm test` covers the engine, installer and MCP server against a real headless Chrome. What it can't
cover is the mod inside Herdr. Before a release, on each OS you can:

1. `node install.mjs --menu`, then `herdr-app status` shows no errors.
2. Command palette → "New web tab": a tab opens on the home page and is renamed after it.
3. Open a second one: it shows a different browser tab. Edit any file in `mods/webtab` (Herdr
   reloads the mod): both come back, and `curl -s 127.0.0.1:9441/status` lists two `viewing`.
4. Open `test/fixtures/manual-test.html` (paste its `file://` URL into the address bar) and work
   through its checklist: click, double-click, typing, Backspace, Enter, wheel, copy, paste,
   right-click, drag, Tab, arrows, hover, dropdown.
5. Paste `data:text/html,<script>confirm("ok?")</script>` into the address bar: the card shows,
   and OK and Cancel answer it.
6. From a Herdr pane, ask Claude Code (or Codex/pi): "use the webtab tools to open example.com, then
   show it to me in a web tab and click its link". The badge names the agent; its tab gets a 🤖.
7. `node mods/webtab/node/webtabd.mjs --stop` (or close Chromium): the tab says the engine stopped,
   then comes back by itself.
8. On a high-resolution screen, text is as sharp as in a normal browser.
9. **Console strip:** click ▤. Open `data:text/html,<script>console.log("hi");console.warn("w");console.error("e");throw new Error("boom")</script>`:
   the button turns red with counts, the strip lists all four (newest first) with colours, Clear
   empties it, and loading another page starts a fresh list.
10. **Observe-only:** click 👁 (it turns into "Observe-only"). Clicks, scrolling, typing, the address
    bar and Ctrl+W do nothing to the page; a `confirm()` card shows no buttons. Ask an agent to click
    something: it still can. Close and reopen the Herdr tab: still on. Click 👁 again: input works.
11. **Guard:** in a Herdr PowerShell or bash terminal, type `git push --force origin nosuchbranch`
    (it fails harmlessly): within a few seconds a "Guard flagged a command from Terminal …"
    notification appears. Ask Claude Code in Herdr to run `git push --force origin main` in a scratch
    repo: it refuses with Guard's reason and a "Guard blocked a command from Claude Code" notification
    appears. `node ~/.config/herdr-app/mods/webtab/node/guard-hook.mjs --recent 5` shows both.
12. `node uninstall.mjs`: the tab bars, `keys.json`, `AGENTS.local.md` and agent configs (including
    the Guard entries in `~/.claude/settings.json` and `~/.codex/hooks.json`) are as before.
