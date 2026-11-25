<!-- herdr-webtab:start (written by herdr-webtab's install.mjs; edit outside these markers) -->
## Web tab: a browser the person and agents share

Herdr has a **web tab** (the `webtab` mod): a real Chromium page drawn inside the window. The person
watches and uses it while agents drive the same browser.

- **The browser:** headless Chromium with its DevTools protocol on `http://127.0.0.1:{{cdpPort}}`.
  It starts on demand: when a web tab opens, when the `webtab` MCP server starts, or with
  `node "{{engine}}" --detach`.
- **For agents:** the MCP server **`webtab`** (chrome-devtools-mcp attached to that browser) is set
  up for {{agents}}. Playwright or Puppeteer can `connectOverCDP("http://127.0.0.1:{{cdpPort}}")`.
- **Show the person a page:** open a web tab with a fresh `id` of your choosing:
  `herdr-app do tab.new '{"name":"🌐 Web","mod":"webtab","props":{"id":"<unique>","url":"https://example.com"}}'`
  (or `"target":"<CDP target id>"` instead of `url` to show a tab you already opened).
  Every browser tab is in the web tab's tab strip; 🤖 marks tabs an agent is driving.
- **Say who you are** before driving, so the badge names you instead of "An agent":
  `curl -s -X POST "http://127.0.0.1:{{httpPort}}/claim?name=Claude%20Code"` (add `&target=<id>` for one tab).
- **Status:** `curl -s http://127.0.0.1:{{httpPort}}/status` lists the tabs and which ones are on screen in Herdr.
- **Etiquette:** open your own tab (`new_page`) instead of navigating the one the person is viewing,
  unless they asked. Don't close tabs you didn't open. This browser profile is separate from the
  person's own browser; it is signed in only where they signed in here.
- **Observe-only:** a web tab opened with `"observe":true` in its props (or the person's 👁 button)
  drops the person's input, so they can watch you work without nudging the page.
{{guardNote}}
<!-- herdr-webtab:end -->
