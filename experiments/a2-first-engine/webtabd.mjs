// webtabd: the engine behind Herdr's native webtab mod.
// Owns a headless Chromium over CDP, writes screencast frames as real JPEG files that the
// mod draws with GPUI's image(), and takes input/navigation from the mod over a local
// NDJSON socket. Agents attach to the same Chromium on its CDP port.
//
// usage: node webtabd.mjs            (socket 127.0.0.1:9440, CDP 127.0.0.1:9333)
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const SOCK_PORT = +(process.env.WEBTAB_PORT || 9440);
const CDP_PORT = +(process.env.WEBTAB_CDP || 9333);
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const FRAMES = path.join(os.homedir(), ".config", "herdr-app", "data", "webtab");
const CHROME = process.env.WEBTAB_CHROME || "chrome";
const PROFILE = process.env.WEBTAB_PROFILE || path.join(os.tmpdir(), "webtab-experiment-profile");
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
fs.mkdirSync(FRAMES, { recursive: true });

async function cdpUp() { try { return (await fetch(`${CDP}/json/version`)).ok; } catch { return false; } }
async function ensureChrome() {
  if (await cdpUp()) return log("attached to running Chromium on", CDP_PORT);
  log("launching Chromium");
  spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1", "--remote-allow-origins=*",
    `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "about:blank"], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 50 && !(await cdpUp()); i++) await new Promise((r) => setTimeout(r, 200));
}

// One view = one mod copy watching one page target.
class View {
  constructor(sock) {
    this.sock = sock; this.id = 0; this.pending = new Map(); this.n = 0; this.files = [];
    this.size = { w: 800, h: 600, dpr: 1 }; this.stats = { frames: 0, t0: Date.now(), fps: 0 };
  }
  emit(o) { if (!this.sock.destroyed) this.sock.write(JSON.stringify(o) + "\n"); }
  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.resolve(null);
    return new Promise((r) => { const i = ++this.id; this.pending.set(i, r); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async attach(targetId, url) {
    const list = await (await fetch(`${CDP}/json/list`)).json();
    let page = list.find((t) => t.id === targetId && t.type === "page");
    if (!page) page = await (await fetch(`${CDP}/json/new?${url || "about:blank"}`, { method: "PUT" })).json();
    else if (url) url = url; // keep existing page; navigate only if asked
    this.target = page.id; this.ws?.close();
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (e) => this.onCdp(JSON.parse(e.data));
    this.ws.onclose = () => this.emit({ t: "status", status: "browser connection closed" });
    await this.send("Page.enable"); await this.send("Runtime.enable");
    this.emit({ t: "attached", target: page.id, url: page.url, title: page.title, cdp: CDP });
    await this.resize(this.size);
    if (url && page.url !== url && targetId) await this.send("Page.navigate", { url });
  }
  async resize({ w, h, dpr = 1 }) {
    this.size = { w: Math.max(200, Math.round(w)), h: Math.max(150, Math.round(h)), dpr };
    await this.send("Emulation.setDeviceMetricsOverride", { width: this.size.w, height: this.size.h, deviceScaleFactor: dpr, mobile: false });
    await this.send("Page.stopScreencast");
    await this.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: Math.round(this.size.w * dpr), maxHeight: Math.round(this.size.h * dpr), everyNthFrame: 1 });
  }
  onCdp(m) {
    if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m.result ?? m.error); this.pending.delete(m.id); return; }
    const p = m.params;
    if (m.method === "Page.screencastFrame") {
      this.ws.send(JSON.stringify({ id: ++this.id, method: "Page.screencastFrameAck", params: { sessionId: p.sessionId } }));
      const name = `v${this.target.slice(0, 6)}-${this.n++}.jpg`;
      const t0 = performance.now();
      fs.writeFileSync(path.join(FRAMES, name), Buffer.from(p.data, "base64"));
      this.files.push(name); while (this.files.length > 12) fs.unlink(path.join(FRAMES, this.files.shift()), () => {});
      const s = this.stats; s.frames++; const dt = Date.now() - s.t0; if (dt > 1000) { s.fps = +(s.frames * 1000 / dt).toFixed(1); s.frames = 0; s.t0 = Date.now(); }
      this.emit({ t: "frame", file: `data/webtab/${name}`, w: p.metadata.deviceWidth, h: p.metadata.deviceHeight, fps: s.fps, write: +(performance.now() - t0).toFixed(1) });
    } else if (m.method === "Page.frameNavigated" && !p.frame.parentId) this.emit({ t: "nav", url: p.frame.url });
    else if (m.method === "Page.loadEventFired") this.emit({ t: "loaded" });
    else if (m.method === "Page.frameStartedLoading") this.emit({ t: "loading" });
    else if (m.method === "Page.domContentEventFired") this.title();
  }
  // Pointer events: one in flight at a time. Moves coalesce to the newest, wheel deltas add up,
  // and presses/releases keep their order. Chrome acks each input, so without this a fast drag
  // queues hundreds of moves and the page trails behind the hand.
  pointer(ev) {
    this.pq ||= [];
    const last = this.pq[this.pq.length - 1];
    if (ev.type === "mouseMoved" && last?.type === "mouseMoved") this.pq[this.pq.length - 1] = ev;
    else if (ev.type === "mouseWheel" && last?.type === "mouseWheel") { last.deltaX += ev.deltaX; last.deltaY += ev.deltaY; last.x = ev.x; last.y = ev.y; }
    else this.pq.push(ev);
    this.pumpPointer();
  }
  async pumpPointer() {
    if (this.pBusy) return; this.pBusy = true;
    try { while (this.pq.length) { const ev = this.pq.shift(); await this.send("Input.dispatchMouseEvent", ev); } }
    finally { this.pBusy = false; }
  }
  async title() { const r = await this.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }); this.emit({ t: "title", title: r?.result?.value || "" }); }
  async cmd(c) {
    switch (c.t) {
      case "attach": return this.attach(c.target, c.url);
      case "resize": return this.resize(c);
      case "navigate": { let u = c.url.trim(); if (!/^[a-z]+:/i.test(u)) u = (/\s/.test(u) || !/\./.test(u)) ? `https://duckduckgo.com/?q=${encodeURIComponent(u)}` : `https://${u}`; return this.send("Page.navigate", { url: u }); }
      case "back": return this.send("Runtime.evaluate", { expression: "history.back()" });
      case "forward": return this.send("Runtime.evaluate", { expression: "history.forward()" });
      case "reload": return this.send("Page.reload");
      case "mouse": return this.pointer({ type: c.type, x: c.x, y: c.y, button: c.button || "none", buttons: c.buttons ?? 0, clickCount: c.clickCount || 0, modifiers: c.modifiers || 0 });
      case "wheel": return this.pointer({ type: "mouseWheel", x: c.x, y: c.y, deltaX: c.dx, deltaY: c.dy, modifiers: c.modifiers || 0 });
      case "key": return this.send("Input.dispatchKeyEvent", c.event);
      case "text": return this.send("Input.insertText", { text: c.text });
      case "copy": { const r = await this.send("Runtime.evaluate", { expression: "String(getSelection())", returnByValue: true }); return this.emit({ t: "copied", text: r?.result?.value || "" }); }
      case "cursor": { // what's under the pointer, for the mod's cursor style
        const r = await this.send("Runtime.evaluate", { expression: `(()=>{const e=document.elementFromPoint(${c.x},${c.y});if(!e)return"";const s=getComputedStyle(e).cursor;return s!=="auto"?s:(e.closest("a[href],button,[role=button],summary,label")?"pointer":(e.closest("input,textarea,[contenteditable]")||(e.childNodes[0]&&e.childNodes[0].nodeType===3)?"text":"default"))})()`, returnByValue: true });
        return this.emit({ t: "cursor", cursor: r?.result?.value || "default" });
      }
    }
  }
  close() { try { this.send("Page.stopScreencast"); this.ws?.close(); } catch {} for (const f of this.files) fs.unlink(path.join(FRAMES, f), () => {}); }
}

await ensureChrome();
net.createServer((sock) => {
  const v = new View(sock); let buf = "";
  log("mod connected");
  sock.on("data", (d) => {
    buf += d.toString("utf8"); let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let c; try { c = JSON.parse(line); } catch { continue; }
      v.cmd(c).catch((e) => v.emit({ t: "status", status: "error: " + e.message }));
    }
  });
  sock.on("close", () => { log("mod disconnected"); v.close(); });
  sock.on("error", () => {});
}).listen(SOCK_PORT, "127.0.0.1", () => log(`webtabd on 127.0.0.1:${SOCK_PORT}, CDP ${CDP}, frames ${FRAMES}`));
