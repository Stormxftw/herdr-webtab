#!/usr/bin/env node
// webtabd: the engine behind Herdr's native web tab.
//
// Owns a headless Chromium over CDP. For every web tab view in Herdr it streams the page as JPEG
// files (drawn by the mod with GPUI image()), takes mouse, keys and navigation back over a local
// NDJSON socket, lists the browser's tabs, turns <select> clicks into Herdr-drawn menus, and
// notices when something other than the person (an agent on CDP) is driving.
//
//   NDJSON  127.0.0.1:<port>      mod <-> engine; the first line must be {"t":"hello","token":…}
//   HTTP    127.0.0.1:<httpPort>  GET /status, POST /claim?name=<agent>[&target=<id>], POST /quit (token)
//   CDP     127.0.0.1:<cdpPort>   agents: chrome-devtools-mcp --browserUrl, Playwright connectOverCDP, …
//
// usage: node webtabd.mjs [--app-home <dir>]   run in the foreground
//        node webtabd.mjs --detach            start in the background (no-op if running), print status
//        node webtabd.mjs --stop              stop the engine and close its browser
//        node webtabd.mjs --status            print the running engine's status
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  VERSION, appHome, loadConfig, findChrome, systemDpr, ensureEngine, stopEngine, engineStatus, newToken, fwd,
} from "./common.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const HOME = appHome(opt("app-home"));

if (flag("detach")) {
  const r = await ensureEngine(HOME);
  console.log(JSON.stringify(r.ok ? { ok: true, started: r.started, cdp: r.status.cdp } : r));
  process.exit(r.ok ? 0 : 1);
}
if (flag("stop")) { console.log(JSON.stringify(await stopEngine(HOME, { closeBrowser: !flag("keep-browser") }))); process.exit(0); }
if (flag("status")) { const s = await engineStatus(loadConfig(HOME).cfg); console.log(JSON.stringify(s || { running: false }, null, 2)); process.exit(s ? 0 : 1); }

// ---------- setup ----------
const { cfg, paths: P } = loadConfig(HOME);
const CDP = `http://127.0.0.1:${cfg.cdpPort}`;
fs.mkdirSync(P.frames, { recursive: true });
try { if (fs.statSync(P.log).size > 2e6) fs.renameSync(P.log, P.log + ".old"); } catch {}
const log = (...a) => {
  const line = [new Date().toISOString().replace("T", " ").slice(0, 23), ...a].join(" ");
  if (process.stdout.isTTY) console.log(line);
  try { fs.appendFileSync(P.log, line + "\n"); } catch {}
};
process.on("uncaughtException", (e) => { log("fatal:", e.stack || e); process.exit(1); });
process.on("unhandledRejection", (e) => log("unhandled:", e?.stack || e));
for (const f of fs.readdirSync(P.frames)) if (/\.jpg$/.test(f)) fs.unlink(path.join(P.frames, f), () => {});
const TOKEN = newToken();
const DPR = systemDpr(cfg);
let ready = false, quitting = false;

// ---------- servers first: a second engine finds the ports taken and leaves ----------
const listen = (server, port) => new Promise((resolve) => {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE") { log(`port ${port} is in use: another engine is running; exiting`); process.exit(0); }
    throw e;
  });
  server.listen(port, "127.0.0.1", resolve);
});

// ---------- Chromium ----------
async function cdpUp() { try { return (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } }
let launching = null;
const spare = new Set(); // the blank tab a browser we launched starts with: the first page reuses it
function ensureChrome() {
  return launching ||= (async () => {
    if (await cdpUp()) return;
    const exe = findChrome(cfg);
    if (!exe) throw new Error("no Chrome or Chromium found: install one, or set \"chrome\" in " + fwd(P.config));
    log("launching", exe);
    fs.mkdirSync(cfg.profile, { recursive: true });
    // No --remote-allow-origins: web pages must never reach this browser's DevTools socket.
    spawn(exe, ["--headless=new", `--remote-debugging-port=${cfg.cdpPort}`, "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${cfg.profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync",
      "--disable-features=Translate,MediaRouter", ...(Array.isArray(cfg.chromeArgs) ? cfg.chromeArgs.map(String) : []), "about:blank"],
      { detached: true, stdio: "ignore", windowsHide: true }).unref();
    for (let i = 0; i < 100 && !(await cdpUp()); i++) await new Promise((r) => setTimeout(r, 150));
    if (!(await cdpUp())) throw new Error("Chromium did not open its DevTools port " + cfg.cdpPort);
    try { for (const t of await (await fetch(`${CDP}/json/list`)).json()) if (t.type === "page" && t.url === "about:blank") spare.add(t.id); } catch {}
  })().finally(() => { launching = null; });
}

// ---------- browser-wide: tabs and agent activity ----------
const views = new Set();
const tabs = new Map();          // targetId -> { id, url, title }
let claim = null;                // { name, target, at }: an agent said who it is
let browserWs = null, bid = 0;
const broadcast = (o) => { for (const v of views) v.emit(o); };
let tabsTimer = null;
const sendTabs = () => { clearTimeout(tabsTimer); tabsTimer = setTimeout(() => broadcast({ t: "tabs", tabs: [...tabs.values()] }), 60); };
// Input or navigation from any web tab showing this target counts as the person's.
const lastLocal = (target, kind) => Math.max(0, ...[...views].filter((v) => v.target === target).map((v) => v[kind]));
const anyLocalNav = () => Math.max(0, ...[...views].map((v) => v.lastLocalNav));

function agentActive(target, why) {
  const who = claim && Date.now() - claim.at < 10 * 60e3 && (!claim.target || claim.target === target) ? claim.name : null;
  for (const v of views) if (v.target === target) v.emit({ t: "driver", who: who || "agent", why, target });
  broadcast({ t: "activity", target, at: Date.now() });
}

const browserPending = new Map();
function browserSend(method, params = {}) {
  if (!browserWs || browserWs.readyState !== 1) return Promise.resolve(null);
  return new Promise((r) => { const i = ++bid; browserPending.set(i, r); browserWs.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (browserPending.delete(i)) r(null); }, 5000); });
}

async function watchBrowser() {
  const ver = await (await fetch(`${CDP}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("browser websocket failed")); });
  browserWs = ws;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data), p = m.params;
    if (m.id && browserPending.has(m.id)) { browserPending.get(m.id)(m.result ?? null); browserPending.delete(m.id); return; }
    if (m.method === "Target.targetDestroyed") {
      if (tabs.delete(p.targetId)) sendTabs();
      for (const v of views) if (v.target === p.targetId) v.targetGone();
      return;
    }
    const i = p?.targetInfo;
    if (!i || i.type !== "page") return;
    if (m.method === "Target.targetCreated" || m.method === "Target.targetInfoChanged") {
      const prev = tabs.get(i.targetId);
      tabs.set(i.targetId, { id: i.targetId, url: i.url, title: i.title || i.url });
      const now = Date.now();
      // A tab nobody in Herdr touched just navigated: an agent did it.
      if (prev && prev.url !== i.url && now - lastLocal(i.targetId, "lastLocalNav") > 3000 && now - lastLocal(i.targetId, "lastLocalInput") > 1500 && i.url !== "about:blank") agentActive(i.targetId, "navigated");
      // A new tab with no opener page, while nobody in Herdr asked for one: an agent opened it.
      if (!prev && m.method === "Target.targetCreated" && !i.openerId && now - anyLocalNav() > 3000) agentActive(i.targetId, "opened");
      // A link or button the person just clicked opened a window: take them to it, like a browser does.
      if (!prev && m.method === "Target.targetCreated" && i.openerId) {
        for (const v of views) if (v.target === i.openerId && now - v.lastLocalInput < 2000) { v.lastLocalNav = now; v.attach(i.targetId, null).catch(() => {}); }
      }
      sendTabs();
    }
  };
  ws.onclose = () => {
    if (browserWs !== ws || quitting) return;
    browserWs = null;
    log("browser connection lost; reconnecting");
    reconnectBrowser();
  };
  ws.send(JSON.stringify({ id: ++bid, method: "Target.setDiscoverTargets", params: { discover: true } }));
  tabs.clear();
  for (const t of await (await fetch(`${CDP}/json/list`)).json()) if (t.type === "page") tabs.set(t.id, { id: t.id, url: t.url, title: t.title || t.url });
}

// Chrome reports a target's title only when its URL changes, so titles set later (most pages, and
// anything an agent opens) are read from the tab list while someone is looking.
let refreshing = false;
async function refreshTitles(force = false) {
  if (refreshing || !browserWs || (!views.size && !force)) return;
  refreshing = true;
  try {
    let changed = false;
    for (const t of await (await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(2000) })).json()) {
      const cur = tabs.get(t.id);
      if (t.type === "page" && cur && t.title && cur.title !== t.title) { cur.title = t.title; changed = true; }
    }
    if (changed) sendTabs();
  } catch {} finally { refreshing = false; }
}
setInterval(refreshTitles, 2000).unref();

async function reconnectBrowser() {
  for (let attempt = 0; !quitting; attempt++) {
    await new Promise((r) => setTimeout(r, Math.min(5000, 500 * (attempt + 1))));
    try {
      await ensureChrome(); // relaunches Chromium if it crashed or was closed
      await watchBrowser();
      log("browser reconnected");
      for (const v of views) v.reattach();
      return;
    } catch (e) { log("reconnect failed:", e.message); }
  }
}

// ---------- page-side helpers (numbers only ever go into these strings) ----------
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// Tells the engine about real input the page receives, so input that didn't come from Herdr (an agent) shows up.
// It also reports visibility: a background tab gets no screencast frames.
const PROBE = `(() => { if (window.__webtabProbe) return; window.__webtabProbe = 1;
  for (const t of ["pointerdown", "keydown", "input"]) addEventListener(t, (e) => { try { __webtabSeen(e.type); } catch {} }, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => { try { __webtabVis(document.visibilityState); } catch {} }); })()`;
const SELECT_AT = (x, y) => `(() => { const e = document.elementFromPoint(${num(x)}, ${num(y)}); const s = e && e.closest && e.closest("select");
  if (!s || s.disabled || s.multiple || s.size > 1) return null;
  window.__webtabSel = (window.__webtabSel || 0) + 1; s.setAttribute("data-webtab-sel", window.__webtabSel); s.focus();
  const r = s.getBoundingClientRect();
  return { id: String(window.__webtabSel), selected: s.selectedIndex, rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    options: [...s.options].map((o) => ({ label: o.label || o.text, disabled: o.disabled || (o.parentElement.tagName === "OPTGROUP" && o.parentElement.disabled),
      group: o.parentElement.tagName === "OPTGROUP" ? o.parentElement.label : null })) }; })()`;
const CURSOR_AT = (x, y) => `(() => { const e = document.elementFromPoint(${num(x)}, ${num(y)}); if (!e) return "";
  const s = getComputedStyle(e).cursor; if (s !== "auto") return s;
  if (e.closest("a[href],button,[role=button],summary,label,select")) return "pointer";
  return e.closest("input,textarea,[contenteditable]") || (e.childNodes[0] && e.childNodes[0].nodeType === 3) ? "text" : "default"; })()`;

// ---------- one view = one web tab in Herdr showing one browser tab ----------
let viewSeq = 0;
class View {
  constructor(sock) {
    this.sock = sock; this.vid = ++viewSeq; this.id = 0; this.pending = new Map(); this.n = 0; this.files = [];
    this.size = { w: 800, h: 600 }; this.stats = { frames: 0, t0: Date.now(), fps: 0 };
    this.lastLocalInput = 0; this.lastLocalNav = 0; this.pq = []; this.seq = 0; this.lastData = "";
    views.add(this);
    // Keeps the mod's socket read from idling out.
    this.heartbeat = setInterval(() => this.emit({ t: "ping" }), 10000);
  }
  emit(o) {
    if (this.sock.destroyed) return;
    // A reader that stopped reading (a mod copy Herdr retired without closing it) must not grow our memory.
    if (this.sock.writableLength > 8e6) { log(`view ${this.vid} stopped reading; dropping it`); this.sock.destroy(); return; }
    this.sock.write(JSON.stringify(o) + "\n");
  }
  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.resolve(null);
    return new Promise((r) => { const i = ++this.id; this.pending.set(i, r); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async evalv(expression) { const r = await this.send("Runtime.evaluate", { expression, returnByValue: true }); return r?.result?.value; }

  // Resolves to [tab id, address still to open in it].
  async newTab(url) {
    this.lastLocalNav = Date.now();
    for (const id of spare) {
      spare.delete(id);
      if (tabs.get(id)?.url === "about:blank" && ![...views].some((v) => v.target === id)) return [id, url || cfg.home];
    }
    // Each tab Herdr opens gets its own browser window: a window paints only its front tab, and a
    // tab an agent opens next to it would otherwise put the one on screen in the background.
    const want = url || cfg.home;
    const r = await browserSend("Target.createTarget", { url: want, newWindow: true });
    let id = r?.targetId;
    if (!id) id = (await (await fetch(`${CDP}/json/new?${encodeURIComponent(want)}`, { method: "PUT" })).json()).id;
    if (!tabs.has(id)) tabs.set(id, { id, url: want, title: want });
    return [id, null];
  }
  async attach(targetId, url) {
    // Two quick switches: only the newest attach may go on (an older one must not navigate the new page).
    const seq = this.attachSeq = (this.attachSeq || 0) + 1;
    const stale = () => seq !== this.attachSeq || this.closed;
    let id = targetId && tabs.has(targetId) ? targetId : null;
    if (!id) [id, url] = await this.newTab(url);
    if (stale()) return;
    const old = this.ws; this.ws = null; try { old?.close(); } catch {}
    for (const r of this.pending.values()) r(null); this.pending.clear();
    this.target = id; this.lastData = "";
    const ws = new WebSocket(`ws://127.0.0.1:${cfg.cdpPort}/devtools/page/${id}`);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("page websocket failed")); });
    if (stale()) { ws.close(); return; }
    this.ws = ws;
    ws.onmessage = (e) => this.onCdp(JSON.parse(e.data));
    ws.onclose = () => {
      if (this.ws !== ws || this.closed) return;
      this.ws = null;
      this.emit({ t: "status", status: "reconnecting to page…" });
      setTimeout(() => this.reattach(), 600);
    };
    await this.send("Page.enable"); await this.send("Runtime.enable");
    await this.send("Runtime.addBinding", { name: "__webtabSeen" });
    await this.send("Runtime.addBinding", { name: "__webtabVis" });
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
    await this.evalv(PROBE);
    if (stale()) return;
    const info = tabs.get(id) || { url: "", title: "" };
    this.emit({ t: "attached", target: id, url: info.url, title: info.title || "", cdp: CDP, dpr: DPR });
    this.emit({ t: "tabs", tabs: [...tabs.values()] });
    await this.applySize();
    if (stale()) return;
    await this.send("Page.bringToFront");
    this.setHidden((await this.evalv("document.visibilityState")) === "hidden");
    if (url) { this.lastLocalNav = Date.now(); await this.send("Page.navigate", { url }); return; }
    // The page may have loaded before we attached (a tab opened with a URL, or switched to): its
    // load events are gone, so send its address and title now.
    const href = await this.evalv("location.href");
    if (href) this.emit({ t: "nav", url: href });
    await this.title();
  }
  reattach() {
    if (this.closed || this.reattaching) return;
    this.reattaching = true;
    const want = this.target && tabs.has(this.target) ? this.target : [...tabs.keys()][0] || null;
    this.attach(want, null).catch((e) => this.emit({ t: "status", status: "error: " + e.message })).finally(() => { this.reattaching = false; });
  }
  async targetGone() {
    const next = [...tabs.values()].find((t) => t.id !== this.target);
    this.emit({ t: "status", status: "tab closed" });
    this.target = null;
    await this.attach(next?.id || null, next ? null : cfg.home).catch((e) => this.emit({ t: "status", status: "error: " + e.message }));
  }
  // A background tab gets no screencast frames. Screenshots still render, so poll those until
  // the tab is in front again (the person clicking it brings it to the front).
  setHidden(hidden) {
    if (hidden === !!this.hidden) return;
    this.hidden = hidden;
    clearInterval(this.pollTimer);
    if (hidden) {
      this.pollTimer = setInterval(async () => {
        if (this.polling || this.closed) return;
        this.polling = true;
        try {
          const r = await this.send("Page.captureScreenshot", { format: "jpeg", quality: cfg.quality });
          if (r?.data && r.data !== this.lastData) { this.lastData = r.data; this.countFrame(); this.writeFrame(r.data, this.size.w, this.size.h, false); }
        } finally { this.polling = false; }
      }, 250);
    } else this.applySize().catch(() => {}); // restart the screencast
  }
  countFrame() { const s = this.stats; s.frames++; const dt = Date.now() - s.t0; if (dt > 1000) { s.fps = +(s.frames * 1000 / dt).toFixed(1); s.frames = 0; s.t0 = Date.now(); } }
  // A window being resized sends many sizes; restart the screencast once it settles.
  resize({ w, h }) {
    this.size = { w: Math.max(200, Math.round(num(w))), h: Math.max(150, Math.round(num(h))) };
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.applySize().catch(() => {}), 120);
  }
  async applySize() {
    await this.send("Emulation.setDeviceMetricsOverride", { width: this.size.w, height: this.size.h, deviceScaleFactor: DPR, mobile: false });
    await this.send("Page.stopScreencast");
    this.lastData = "";
    await this.send("Page.startScreencast", { format: "jpeg", quality: cfg.quality, maxWidth: Math.round(this.size.w * DPR), maxHeight: Math.round(this.size.h * DPR), everyNthFrame: 1 });
  }
  writeFrame(b64, w, h, hq) {
    if (this.closed) return;
    // Behind already: skip this frame rather than queue it (the settled sharp frame still comes).
    if (!hq && this.sock.writableLength > 256e3) return;
    const name = `v${this.vid}-${this.n++}.jpg`;
    fs.writeFileSync(path.join(P.frames, name), Buffer.from(b64, "base64"));
    // image() loads files asynchronously; the mod keeps a few drawn frames under the newest, so keep them on disk too.
    this.files.push(name); while (this.files.length > 12) fs.unlink(path.join(P.frames, this.files.shift()), () => {});
    this.emit({ t: "frame", file: `${P.framesRel}/${name}`, w, h, fps: this.stats.fps, hq: !!hq });
  }
  onCdp(m) {
    if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m.result ?? null); this.pending.delete(m.id); return; }
    const p = m.params;
    if (m.method === "Page.screencastFrame") {
      this.ws?.send(JSON.stringify({ id: ++this.id, method: "Page.screencastFrameAck", params: { sessionId: p.sessionId } }));
      if (p.data === this.lastData) return; // identical frame: nothing to draw
      this.lastData = p.data; const seq = ++this.seq;
      this.countFrame();
      this.writeFrame(p.data, p.metadata.deviceWidth, p.metadata.deviceHeight, false);
      // Once the page settles, replace the stream frame with a sharper one.
      clearTimeout(this.hqTimer);
      this.hqTimer = setTimeout(async () => {
        if (seq !== this.seq) return;
        const r = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
        if (r?.data && seq === this.seq) this.writeFrame(r.data, this.size.w, this.size.h, true);
      }, 280);
    } else if (m.method === "Page.frameNavigated" && !p.frame.parentId) this.emit({ t: "nav", url: p.frame.url });
    else if (m.method === "Page.loadEventFired") { this.emit({ t: "loaded" }); this.title(); }
    else if (m.method === "Page.frameStartedLoading") this.emit({ t: "loading" });
    else if (m.method === "Page.domContentEventFired") this.title();
    // Headless Chromium draws no alert/confirm/prompt/beforeunload: the page waits until someone answers.
    else if (m.method === "Page.javascriptDialogOpening") this.emit({ t: "dialog", kind: p.type, message: String(p.message || "").slice(0, 2000), value: p.defaultPrompt || "", url: p.url });
    else if (m.method === "Page.javascriptDialogClosed") this.emit({ t: "dialog-closed" });
    else if (m.method === "Runtime.bindingCalled" && p.name === "__webtabSeen") {
      if (Date.now() - lastLocal(this.target, "lastLocalInput") > 600) agentActive(this.target, "input");
    } else if (m.method === "Runtime.bindingCalled" && p.name === "__webtabVis") this.setHidden(p.payload === "hidden");
  }
  async title() {
    const title = (await this.evalv("document.title")) || "";
    this.emit({ t: "title", title });
    const cur = this.target && tabs.get(this.target);
    if (cur && title && cur.title !== title) { cur.title = title; sendTabs(); }
  }

  // Pointer events: one in flight at a time. Moves coalesce to the newest, wheel deltas add up,
  // presses and releases keep their order. Chrome acks each input, so without this a fast drag
  // queues hundreds of moves and the page trails behind the hand.
  pointer(ev) {
    this.lastLocalInput = Date.now();
    if (this.hidden && ev.type === "mousePressed") this.send("Page.bringToFront");
    const last = this.pq[this.pq.length - 1];
    if (ev.type === "mouseMoved" && last?.type === "mouseMoved") this.pq[this.pq.length - 1] = ev;
    else if (ev.type === "mouseWheel" && last?.type === "mouseWheel") { last.deltaX += ev.deltaX; last.deltaY += ev.deltaY; last.x = ev.x; last.y = ev.y; }
    else this.pq.push(ev);
    this.pumpPointer();
  }
  async pumpPointer() {
    if (this.pBusy) return; this.pBusy = true;
    try {
      while (this.pq.length) {
        const ev = this.pq.shift();
        if (ev.type === "mousePressed" && ev.button === "left") {
          // Headless Chromium draws no <select> popup: Herdr draws the menu instead.
          const sel = await this.evalv(SELECT_AT(ev.x, ev.y));
          if (sel) { this.swallowRelease = true; this.emit({ t: "select", ...sel }); continue; }
        }
        if (ev.type === "mouseReleased" && this.swallowRelease) { this.swallowRelease = false; continue; }
        this.lastLocalInput = Date.now();
        await this.send("Input.dispatchMouseEvent", ev);
      }
    } finally { this.pBusy = false; }
  }
  async cmd(c) {
    switch (c.t) {
      case "attach": return this.attach(typeof c.target === "string" ? c.target : null, typeof c.url === "string" ? c.url : null);
      case "resize": return this.resize(c);
      case "navigate": {
        let u = String(c.url || "").trim(); if (!u) return;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = (/\s/.test(u) || !/\./.test(u)) ? cfg.search.replace("%s", encodeURIComponent(u)) : `https://${u}`;
        this.lastLocalNav = Date.now(); return this.send("Page.navigate", { url: u });
      }
      case "back": this.lastLocalNav = Date.now(); return this.evalv("history.back()");
      case "forward": this.lastLocalNav = Date.now(); return this.evalv("history.forward()");
      case "reload": this.lastLocalNav = Date.now(); return this.send("Page.reload");
      case "newtab": return this.attach(null, typeof c.url === "string" ? c.url : null); // attach opens the tab, in command order
      case "closetab": this.lastLocalNav = Date.now(); return fetch(`${CDP}/json/close/${encodeURIComponent(String(c.id))}`);
      case "switch": return this.attach(String(c.id), null);
      case "mouse": return this.pointer({ type: ["mousePressed", "mouseReleased", "mouseMoved"].includes(c.type) ? c.type : "mouseMoved", x: num(c.x), y: num(c.y),
        button: ["left", "right", "middle", "none"].includes(c.button) ? c.button : "none", buttons: num(c.buttons), clickCount: num(c.clickCount), modifiers: num(c.modifiers) });
      case "wheel": return this.pointer({ type: "mouseWheel", x: num(c.x), y: num(c.y), deltaX: num(c.dx), deltaY: num(c.dy), modifiers: num(c.modifiers) });
      case "key": this.lastLocalInput = Date.now(); return this.send("Input.dispatchKeyEvent", c.event || {});
      case "text": this.lastLocalInput = Date.now(); return this.send("Input.insertText", { text: String(c.text || "") });
      case "pick": this.lastLocalInput = Date.now(); return this.evalv(`(() => { const s = document.querySelector('[data-webtab-sel="${String(c.id).replace(/\D/g, "")}"]'); if (!s) return;
        s.selectedIndex = ${num(c.index) | 0}; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      case "dialog": this.lastLocalInput = Date.now(); return this.send("Page.handleJavaScriptDialog", { accept: !!c.accept, ...(typeof c.text === "string" ? { promptText: c.text } : {}) });
      case "copy": return this.emit({ t: "copied", text: (await this.evalv("String(getSelection())")) || "" });
      case "cursor": return this.emit({ t: "cursor", cursor: (await this.evalv(CURSOR_AT(c.x, c.y))) || "default" });
    }
  }
  close() {
    this.closed = true; clearInterval(this.heartbeat); clearInterval(this.pollTimer); clearTimeout(this.resizeTimer); clearTimeout(this.hqTimer); views.delete(this);
    try { this.send("Page.stopScreencast"); this.ws?.close(); } catch {}
    for (const f of this.files) fs.unlink(path.join(P.frames, f), () => {});
  }
}

// ---------- the mod socket ----------
const viewServer = net.createServer((sock) => {
  let buf = "", view = null;
  sock.setNoDelay(true);
  const helloTimer = setTimeout(() => { if (!view) sock.destroy(); }, 5000);
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    if (!view && buf.length > 4096) return sock.destroy();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      let c; try { c = JSON.parse(line); } catch { if (!view) return sock.destroy(); continue; }
      if (!view) {
        // Only Herdr (which can read the token file) may drive the browser through this socket.
        if (c?.t !== "hello" || c.token !== TOKEN) { log("rejected a connection without the token"); return sock.destroy(); }
        clearTimeout(helloTimer);
        view = new View(sock); log(`view ${view.vid} connected`);
        view.emit({ t: "hello", version: VERSION, dpr: DPR });
        continue;
      }
      view.cmd(c).catch((e) => view.emit({ t: "status", status: "error: " + e.message }));
    }
  });
  sock.on("close", () => { clearTimeout(helloTimer); if (view) { log(`view ${view.vid} disconnected`); view.close(); } });
  sock.on("error", () => {});
});

// ---------- HTTP for agents and tools ----------
const ALLOWED_HOSTS = new Set([`127.0.0.1:${cfg.httpPort}`, `localhost:${cfg.httpPort}`]);
const httpServer = http.createServer((req, res) => {
  const json = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  // Web pages may not use this API: browsers always send Origin or Sec-Fetch-Site; curl and agents don't.
  // The Host check stops DNS rebinding.
  const site = req.headers["sec-fetch-site"];
  if (req.headers.origin || (site && site !== "none") || !ALLOWED_HOSTS.has(req.headers.host || "")) return json(403, { error: "forbidden" });
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/status" && req.method === "GET") {
    refreshTitles(true).finally(() => json(200, { engine: "webtabd", version: VERSION, ready, pid: process.pid, cdp: CDP, dpr: DPR,
      tabs: [...tabs.values()], viewing: [...views].map((v) => v.target).filter(Boolean), claim }));
    return;
  }
  if (u.pathname === "/claim" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => { body += d; if (body.length > 8192) req.destroy(); });
    req.on("end", () => {
      let b = {}; try { b = body ? JSON.parse(body) : {}; } catch {}
      const name = String(u.searchParams.get("name") || b.name || "agent").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32) || "agent";
      const target = u.searchParams.get("target") || b.target || null;
      claim = { name, target: target ? String(target) : null, at: Date.now() }; log("claim", name, target || "");
      // A claim names the agent; the badge shows where it acts. Only a claim for one tab shows there at once.
      if (target) for (const v of views) if (v.target === target) v.emit({ t: "driver", who: name, why: "claimed", target: v.target });
      json(200, { ok: true, claim });
    });
    return;
  }
  if (u.pathname === "/quit" && req.method === "POST") {
    if (req.headers["x-webtab-token"] !== TOKEN) return json(403, { error: "token required" });
    json(200, { ok: true });
    quit(u.searchParams.get("browser") === "1");
    return;
  }
  json(404, { error: "not found" });
});

async function quit(closeBrowser) {
  quitting = true; log("quitting", closeBrowser ? "(closing the browser)" : "");
  for (const v of views) { try { v.sock.destroy(); } catch {} }
  if (closeBrowser && browserWs) { try { browserWs.send(JSON.stringify({ id: ++bid, method: "Browser.close" })); } catch {} }
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGTERM", () => quit(false));
process.on("SIGINT", () => quit(false));

await listen(viewServer, cfg.port);
await listen(httpServer, cfg.httpPort);
fs.writeFileSync(P.token, TOKEN, { mode: 0o600 });
log(`webtabd ${VERSION}: views 127.0.0.1:${cfg.port}, http ${cfg.httpPort}, CDP ${CDP}, dpr ${DPR}, pid ${process.pid}`);
try { await ensureChrome(); await watchBrowser(); }
catch (e) { log("browser failed:", e.message); process.exit(1); }
ready = true;
log("ready");
