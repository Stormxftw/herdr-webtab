// experiment: what keeps a background tab painting in headless Chrome?
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
import { findChrome } from "../../mods/webtab/node/common.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9555, prof = fs.mkdtempSync(path.join(os.tmpdir(), "vis-"));
const ch = spawn(findChrome({}), ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "--no-first-run", ...process.argv.slice(2), "about:blank"], { stdio: "ignore" });
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
async function session(id) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/devtools/page/${id}`); await new Promise((r) => (ws.onopen = r));
  let n = 0; const pend = new Map(); let frames = 0;
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } if (m.method === "Page.screencastFrame") { frames++; ws.send(JSON.stringify({ id: ++n, method: "Page.screencastFrameAck", params: { sessionId: m.params.sessionId } })); } };
  const send = (method, params = {}, ms = 4000) => new Promise((r) => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.delete(i)) r("TIMEOUT"); }, ms); });
  return { send, frames: () => frames, ev: async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true }))?.result?.value };
}
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const A = await session(list[0].id);
await A.send("Page.enable");
await A.send("Page.navigate", { url: "data:text/html,<body><div id=b>x</div><script>let i=0;setInterval(()=>{b.textContent=++i},50)</script>" });
await sleep(500);
await A.send("Page.startScreencast", { format: "jpeg", quality: 50 });
await sleep(1000); console.log("A front: vis", await A.ev("document.visibilityState"), "frames/1s", A.frames());
await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }); // another tab takes the front
await sleep(800);
let f0 = A.frames(); await sleep(1000); console.log("A behind: vis", await A.ev("document.visibilityState"), "frames/1s", A.frames() - f0);
const t0 = Date.now(); const shot = await A.send("Page.captureScreenshot", { format: "jpeg" }); console.log("screenshot behind:", shot === "TIMEOUT" ? "TIMEOUT" : "ok", Date.now() - t0, "ms");
console.log("focus emulation:", JSON.stringify(await A.send("Emulation.setFocusEmulationEnabled", { enabled: true })));
f0 = A.frames(); await sleep(1000); console.log("  -> vis", await A.ev("document.visibilityState"), "frames/1s", A.frames() - f0);
console.log("lifecycle active:", JSON.stringify(await A.send("Page.setWebLifecycleState", { state: "active" })));
f0 = A.frames(); await sleep(1000); console.log("  -> vis", await A.ev("document.visibilityState"), "frames/1s", A.frames() - f0);
const t1 = Date.now(); const click = await A.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 }); console.log("input behind:", click === "TIMEOUT" ? "TIMEOUT" : "ok", Date.now() - t1, "ms");
ch.kill(); process.exit(0);
