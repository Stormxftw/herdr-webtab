# Architecture

## Pieces

| Piece | Where it runs | Job |
|---|---|---|
| `mods/webtab/main.js` | inside Herdr (GPUI) | draws frames, the tab strip, toolbar, menus and dialogs; sends input |
| `mods/webtab/node/webtabd.mjs` | Node, background | owns Chromium; streams frames; input, tabs, agent detection, HTTP API |
| `mods/webtab/node/mcp.mjs` | Node, per agent | starts the engine if needed, then runs chrome-devtools-mcp on its browser |
| `mods/webtab-new` | inside Herdr | opens a web tab with fresh props (the palette's "New web tab") |
| `mods/new-menu-web` | inside Herdr | Herdr's + menu plus a "Web tab" row (optional) |
| `install.mjs` / `uninstall.mjs` | Node, once | put everything in place, register agents, undo it |

## Frames

Herdr mods draw images only from files (`image(path)`), and can't write binary files themselves.
So the engine runs `Page.startScreencast` (JPEG, quality 72, at the display scale), writes each
changed frame to `<appHome>/data/webtab/frames/v<view>-<n>.jpg`, keeps the last 12 per view, and
sends `{t: "frame", file, w, h}` to the mod. `w`/`h` are CSS pixels; at a display scale of 2 the
JPEG has twice the pixels, which is what makes it sharp.

`image()` loads a file asynchronously and draws nothing until it has. The mod therefore draws the
incoming frame **underneath** the frames already shown and promotes it to the top on the next frame
or after 35 ms. Only the newest frame of each socket read joins the stack. Once the page has been
still for 280 ms, the engine sends a quality-92 screenshot in place of the last stream frame.

If the mod falls behind (more than 256 KB unread on its socket), stream frames are skipped; a reader
with more than 8 MB unread is disconnected.

## Input

Mouse and wheel events are queued per view with one in flight at a time: moves coalesce to the
newest, wheel deltas add up, presses and releases keep their order. Without this a fast drag queues
hundreds of moves and the page trails the hand.

Keys become `Input.dispatchKeyEvent` (with editing commands for Ctrl+A/C/X/Z/Y) or
`Input.insertText`. Copy reads `getSelection()` and puts it on Herdr's clipboard.

## Things headless Chromium doesn't draw

- **`<select>`:** on a left press the engine checks `elementFromPoint` for a select; if there is
  one it sends its options and box to the mod, which draws the menu. Picking sets `selectedIndex` and
  fires `input` and `change`.
- **Dialogs:** `Page.javascriptDialogOpening` → `{t: "dialog"}` → the mod's card →
  `Page.handleJavaScriptDialog`.
- **New windows** opened by the person's click: the view follows the new target.

## Who is driving

The engine adds a page binding and a capture-phase listener for `pointerdown`, `keydown` and
`input`. Input the page sees within 600 ms of input from a Herdr view is the person's; anything else
is an agent's. Navigation of a tab no view navigated in the last 3 s, and new tabs without an opener
page while nobody in Herdr asked for one, are agents' too. An agent can name itself with
`POST /claim?name=…` (optionally `&target=<id>`); the claim lasts ten minutes.

## Protocol (mod ↔ engine)

Newline-delimited JSON over TCP on 127.0.0.1:`port`. The first line must be
`{"t": "hello", "token": "<contents of data/webtab/token>"}`; anything else closes the connection.

Mod → engine: `attach {target?, url?}`, `resize {w, h}`, `navigate {url}`, `back`, `forward`,
`reload`, `newtab {url?}`, `closetab {id}`, `switch {id}`, `mouse {type, x, y, button, buttons,
clickCount, modifiers}`, `wheel {x, y, dx, dy, modifiers}`, `key {event}`, `text {text}`,
`pick {id, index}`, `dialog {accept, text?}`, `copy`, `cursor {x, y}`.

Engine → mod: `hello`, `attached {target, url, title}`, `frame {file, w, h, fps, hq}`, `tabs {tabs}`,
`nav {url}`, `loading`, `loaded`, `title {title}`, `cursor {cursor}`, `copied {text}`,
`select {id, selected, rect, options}`, `dialog {kind, message, value, url}`, `dialog-closed`,
`driver {who, why, target}`, `activity {target, at}`, `status {status}`, `ping` (every 10 s).

## Lifecycle

`node webtabd.mjs --detach` starts the engine unless `/status` already answers, and waits until it
reports `ready`. The mod runs that through `exec` when it can't connect; `mcp.mjs` runs it alongside
chrome-devtools-mcp. The engine binds its ports first (a second engine exits quietly), then attaches
to a Chromium already on `cdpPort` or launches one. If Chromium dies, the engine relaunches it and
every view re-attaches. `--stop` asks the engine to quit (token required) and closes its browser.
