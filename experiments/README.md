# Experiments

The scripts behind [docs/research.md](../docs/research.md) and [docs/testing.md](../docs/testing.md),
kept as they were run (with personal paths replaced by environment variables or relative paths).
They are **not** part of the installed mod. Most expect a Chromium; set `WEBTAB_CHROME` to its path
where a script asks for it. The `engine/` scripts find one the same way the engine does.

## Choosing the design ([research.md](../docs/research.md))

| Folder | What it is | Result |
|---|---|---|
| [`a-mod-direct-cdp/main.js`](a-mod-direct-cdp/main.js) | **Experiment A.** A Herdr mod that connects to Chromium's DevTools WebSocket itself and draws screencast frames with `image()`. Frames are written as SVG-wrapped base64, because mods can't write binary files. | Works, ~12 fps. Proved a browser can be drawn by GPUI. |
| [`b-kitty-graphics/kittyweb.mjs`](b-kitty-graphics/kittyweb.mjs) | **Experiment B.** Streams the page into a Herdr terminal pane with the Kitty graphics protocol; SGR mouse reports become CDP input. Run it in a pane: `node kittyweb.mjs [targetId]`. | Works, but it's a terminal, not a tab. |
| [`c-chromium-window/dock.py`](c-chromium-window/dock.py) | **Experiment C1** (Windows). A real Chromium window re-parented into Herdr's window with `SetParent`. | Flashes: Herdr repaints its DirectX surface every frame. |
| [`c-chromium-window/dock2.py`](c-chromium-window/dock2.py) | **Experiment C2** (Windows). A real Chromium window owned by Herdr's window, clipped with `SetWindowRgn`, following the pane, never activated. | Works, but rejected: a window on top, not native. |
| [`a2-first-engine/`](a2-first-engine/) | **Experiment A2.** The first engine (`webtabd.mjs`) and thin view (`main.js`): Node owns Chromium and writes real JPEGs, the mod only draws. | 21–26 fps, then the flicker fix. Became Herdr Web Tab. |

## Tools used for testing

| File | What it does |
|---|---|
| [`tools/agent.mjs`](tools/agent.mjs) | A stand-in agent: a second CDP client. `node agent.mjs list \| goto <url> \| eval <js> \| click <x> <y> \| type <text> \| shot <file>` (`TARGET=<id>` picks the tab). |
| [`tools/agent-turn.mjs`](tools/agent-turn.mjs) | Fills the test page's agent card through CDP while you watch: the first "agent drove it" check. |
| [`tools/winshot.py`](tools/winshot.py) | Captures a window by handle without focusing it (`PrintWindow`), for experiment C. |
| [`tools/grab.ps1`](tools/grab.ps1) | Copies a screen rectangle to a PNG. |
| [`tools/flick.py`](tools/flick.py), [`tools/flick2.py`](tools/flick2.py) | The flicker test: grab the pane 10 or 20 times and count blank grabs (or grabs with no purple from the moving square). `python flick2.py <x> <y> <w> <h>` |
| [`tools/orphans.ps1`](tools/orphans.ps1) | Lists, and with `kill` ends, Chromiums left behind by killed test runs. |
| [`tools/make-doc-images.py`](tools/make-doc-images.py) | How the screenshots in `docs/images` were cropped, scaled, and had local `file://` paths covered. (The raw screenshots aren't in the repo.) |

## Engine investigations ([testing.md](../docs/testing.md#3-measurements-and-experiments))

All start their own throwaway Chromium (or engine) on random ports, so they don't touch an installed
web tab. Run them from this folder: `node engine/<name>.mjs`.

| Script | Question | Answer |
|---|---|---|
| [`engine/vis-exp.mjs`](engine/vis-exp.mjs) | Does a tab behind another one still paint in headless Chromium? Does focus emulation or forcing the lifecycle help? Extra Chromium flags can be passed as arguments. | Front tab 20 fps, behind 0 fps; emulation 1–2 fps; a screenshot of a hidden tab takes ~4 s. |
| [`engine/vis-exp2.mjs`](engine/vis-exp2.mjs) | Do separate windows both paint? Where do new tabs go, and can `bringToFront` change it? | Both windows paint; new tabs go to the newest window; `bringToFront`/`activateTarget` don't change that. |
| [`engine/dbg-popup.mjs`](engine/dbg-popup.mjs) | Reproduces "click opens a popup, switch back, close the popup, an agent opens a tab, does the page still update?" with every engine message logged. | Passed alone, which showed the test failures came from state left by earlier tests. |
| [`engine/close-exp.mjs`](engine/close-exp.mjs) | After `Browser.close`, how long until the DevTools port closes, and until the process exits? `EXE=<path>` picks the browser. | Port: ~0.1 s. Process: 11–15 s (Playwright Chromium), over 30 s (Chrome stable). |
| [`engine/pid-exp.mjs`](engine/pid-exp.mjs) | Does `SystemInfo.getProcessInfo` give the real browser pid? | Yes, the same as the spawned process. |
| [`engine/dbg-recover.mjs`](engine/dbg-recover.mjs) | Kills the browser three times under a quiet engine and times how long the view takes to come back. | 15–17 s before the fix; 7–20 s after. |

Run the engine with `WEBTAB_DEBUG=1` to get the same timing and visibility log these investigations
used.
