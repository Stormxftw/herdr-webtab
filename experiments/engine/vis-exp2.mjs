// experiment 2: separate windows stay visible? and does bringToFront pick where new tabs go?
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
import { findChrome } from "../../mods/webtab/node/common.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9556 + Math.floor(Math.random() * 300), prof = fs.mkdtempSync(path.join(os.tmpdir(), "vis-"));
const ch = spawn(findChrome({}), ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const B = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (B.onopen = r));
let bn = 0; const bp = new Map(); B.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && bp.has(m.id)) { bp.get(m.id)(m.result ?? m.error); bp.delete(m.id); } };
const bsend = (method, params = {}) => new Promise((r) => { const i = ++bn; bp.set(i, r); B.send(JSON.stringify({ id: i, method, params })); });
async function session(id) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/devtools/page/${id}`); await new Promise((r) => (ws.onopen = r));
  let n = 0; const pend = new Map(); let frames = 0;
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } if (m.method === "Page.screencastFrame") { frames++; ws.send(JSON.stringify({ id: ++n, method: "Page.screencastFrameAck", params: { sessionId: m.params.sessionId } })); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.delete(i)) r("TIMEOUT"); }, 5000); });
  const s = { id, send, frames: () => frames, ev: async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true }))?.result?.value };
  await send("Page.enable");
  return s;
}
const anim = "data:text/html,<body><div id=b>x</div><script>let i=0;setInterval(()=>{b.textContent=++i},50)</script>";
const win = async (id) => (await bsend("Browser.getWindowForTarget", { targetId: id }))?.windowId;
const rate = async (s) => { const f0 = s.frames(); await sleep(1000); return s.frames() - f0; };

const dock = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())[0].id;
const a = (await bsend("Target.createTarget", { url: anim, newWindow: true })).targetId;
const b = (await bsend("Target.createTarget", { url: anim, newWindow: true })).targetId;
const A = await session(a), Bs = await session(b);
await A.send("Page.startScreencast", { format: "jpeg", quality: 40 }); await Bs.send("Page.startScreencast", { format: "jpeg", quality: 40 });
await sleep(700);
console.log("windows: dock", await win(dock), "A", await win(a), "B", await win(b));
console.log("(a) two windows at once: A", await A.ev("document.visibilityState"), await rate(A), "fps; B", await Bs.ev("document.visibilityState"), await rate(Bs), "fps");
const D = await session(dock); await D.send("Page.bringToFront"); await sleep(300);
console.log("after bringing the dock to front: A", await rate(A), "fps, B", await rate(Bs), "fps");
const c = (await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json()).id;
const c2 = (await bsend("Target.createTarget", { url: "about:blank" })).targetId;
console.log("(b) new tabs land in window:", await win(c), "and", await win(c2), "(dock is", await win(dock) + ")");
console.log("    A still", await A.ev("document.visibilityState"), await rate(A), "fps; B", await Bs.ev("document.visibilityState"), await rate(Bs), "fps");
console.log("activateTarget(dock):", JSON.stringify(await bsend("Target.activateTarget", { targetId: dock }))); await sleep(200);
const c4 = (await bsend("Target.createTarget", { url: "about:blank" })).targetId;
const c5 = (await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json()).id;
console.log("(c) after activateTarget(dock), new tabs land in", await win(c4), "and", await win(c5), "(dock is", await win(dock) + ")");
console.log("    A", await A.ev("document.visibilityState"), await rate(A), "fps; B", await Bs.ev("document.visibilityState"), await rate(Bs), "fps; dock tab", await D.ev("document.visibilityState"));
// a person clicks into A (bringToFront A): does A's window become where new tabs go?
await A.send("Page.bringToFront"); await sleep(200);
const c3 = (await bsend("Target.createTarget", { url: "about:blank" })).targetId;
console.log("after bringToFront(A), a new tab lands in", await win(c3), "(A is", await win(a) + ")", "A now", await A.ev("document.visibilityState"));
ch.kill(); process.exit(0);
