# What Herdr could add

Herdr's [CONTRIBUTING](https://github.com/herdrdev/herdr-app/blob/master/CONTRIBUTING.md) asks for
features as mods, and for issues about bugs and "things a mod cannot do yet". Building this mod
turned up one bug and a few missing APIs. These are drafts for issues on herdrdev/herdr-app, each
with what was observed on Herdr 0.1.18 (Windows 11).

---

## Bug: `fs.writeFile` with bytes writes an empty file

**Observed:** in a mod, `await fs.writeFile(path, new Uint8Array([0xff, 0xd8, …]))` (from
`fs/promises`) resolves without error and leaves a **0-byte** file. `Buffer.from(bytes)` does the
same. Strings are written correctly.

**Repro:** a mod that runs, in `init`,
```js
import * as fs from "fs/promises";
await fs.writeFile(appHome() + "/data/probe/u8.bin", new Uint8Array([1, 2, 3]));
```
then `ls -l` shows `u8.bin` with size 0.

**Expected:** the bytes are written, or the call rejects if binary writes aren't supported.

**Why it matters:** a mod that makes images (thumbnails, charts, frames) can't write them and needs
a helper process, or has to wrap base64 in an SVG.

---

## Missing API: draw an image from bytes

**Today:** `image(path)` only draws files, loads asynchronously, and draws nothing until loaded.
Streaming anything (a browser, a simulator, a camera) means writing a file per frame, about 20–45
files a second, and drawing each new frame under the previous ones so the pane doesn't flash.

**Ask:** `image()` accepting bytes or a `data:` URL (or a small frame-stream handle a mod can push
frames into), drawn once decoded, with the previous image kept until then.

**Gain:** lower latency (no disk round trip), no disk writes per frame, no flicker workaround.
[herdr-sim](https://github.com/wobsoriano/herdr-sim) notes the same ~0.2 s delay.

---

## Missing API: the window's scale factor

**Today:** mods get logical pixels but no device pixel ratio, so a mod that renders images can't
tell whether to render them at 1×, 1.5× or 2×. This mod reads the OS setting from outside Herdr
(registry, `system_profiler`, `GDK_SCALE`), which is wrong on mixed-DPI setups.

**Ask:** `window().scale` (and a re-render when it changes, e.g. moving to another monitor).

---

## Missing API: a mod pane's own pane id

**Today:** `props().pane` is set for pane header mods only. A mod opened with
`tab.new {mod, props}` can't tell which pane (and so which tab) it is, so it can't rename its own
tab reliably. This mod guesses from `focused()` when it starts.

**Ask:** give every mod copy shown in a pane its `pane` (in `props()` or a `self()` call).

---

## Missing API: adding a row to the + menu

**Today:** the + menu (`new-menu`) can't be extended. A mod that adds "Web tab" there has to copy
the shipped menu (cross-mod imports are refused) and patch the person's tab bars to open the copy,
which goes stale with each Herdr update.

**Ask:** a `mod.json` key like `palette` for the + menu, e.g.
`"new": [{ "title": "Web tab", "hint": "browser", "command": "mod.open", "args": { "name": "webtab-new" } }]`.

---

## Docs: retired copies after a reload

**Observed:** after editing a mod's `main.js`, a copy from the old build kept its `net` socket open
(its read loop was waiting on `read()`), so the other side kept sending to it. The manual says loops
end at their next `cx` use; it doesn't say whether `close()` runs for retired copies.

**Ask:** call `close()` on copies a reload retires, or document that it isn't called.
