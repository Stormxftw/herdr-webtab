// End-to-end tests for the engine: a real headless Chromium, the mod's socket protocol, the HTTP
// API, agent detection and recovery. Skipped when no Chrome/Chromium is installed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { findChrome, ENGINE, loadConfig, stopEngine, closeChrome, portOpen } from "../mods/webtab/node/common.mjs";

const CHROME = findChrome({});
const FIXTURE = pathToFileURL(path.resolve("test/fixtures/page.html")).href;
const skip = CHROME ? false : "no Chrome or Chromium installed";

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let HOME, cfg, engine;

async function waitFor(fn, ms = 20000, what = "condition") {
  const until = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > until) throw new Error("timed out waiting for " + what); await sleep(150); }
}
const status = async () => (await fetch(`http://127.0.0.1:${cfg.httpPort}/status`)).json();
function rawHttp(port, { method = "GET", path: p = "/status", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end();
  });
}

// A test double for the mod: speaks the NDJSON protocol and collects messages.
function connectView(token) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(cfg.port, "127.0.0.1");
    const msgs = [], waiters = [];
    let buf = "";
    sock.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); msgs.push(m);
        for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
      }
    });
    const v = {
      sock, msgs, closed: false,
      send: (o) => sock.write(JSON.stringify(o) + "\n"),
      next: (pred, ms = 15000, what = "message") => {
        const hit = msgs.find(pred); if (hit) { msgs.splice(msgs.indexOf(hit), 1); return Promise.resolve(hit); }
        return new Promise((res, rej) => {
          const w = { pred, resolve: (m) => { clearTimeout(t); msgs.splice(msgs.indexOf(m), 1); res(m); } };
          const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error("timed out waiting for " + what)); }, ms);
          waiters.push(w);
        });
      },
      clear: () => { msgs.length = 0; },
    };
    sock.on("close", () => { v.closed = true; });
    sock.on("connect", () => { if (token !== undefined) v.send({ t: "hello", token }); resolve(v); });
    sock.on("error", reject);
  });
}
// An "agent": its own CDP connection to a page, like chrome-devtools-mcp or Playwright.
async function agentOn(target) {
  const ws = new WebSocket(`ws://127.0.0.1:${cfg.cdpPort}/devtools/page/${target}`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, eval: async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true }))?.result?.value, close: () => ws.close() };
}
const token = () => fs.readFileSync(path.join(HOME, "data", "webtab", "token"), "utf8").trim();

before(async () => {
  if (skip) return;
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), "webtab-engine-"));
  fs.mkdirSync(path.join(HOME, "mods"), { recursive: true });
  fs.mkdirSync(path.join(HOME, "data", "webtab"), { recursive: true });
  const conf = { port: await freePort(), httpPort: await freePort(), cdpPort: await freePort(), dpr: 1, home: "about:blank", chrome: CHROME,
    chromeArgs: process.env.CI && process.platform === "linux" ? ["--no-sandbox"] : [] };
  fs.writeFileSync(path.join(HOME, "data", "webtab", "config.json"), JSON.stringify(conf));
  cfg = loadConfig(HOME).cfg;
  engine = spawn(process.execPath, [ENGINE, "--app-home", HOME], { stdio: "ignore" });
  await waitFor(async () => (await status()).ready, 30000, "engine ready");
});

after(async () => {
  if (skip) return;
  await stopEngine(HOME, { closeBrowser: true }).catch(() => {});
  try { engine.kill(); } catch {}
  for (let i = 0; i < 10; i++) { try { fs.rmSync(HOME, { recursive: true, force: true }); break; } catch { await sleep(500); } }
});

test("status reports a ready engine and its browser", { skip }, async () => {
  const s = await status();
  assert.equal(s.engine, "webtabd");
  assert.equal(s.ready, true);
  assert.equal(s.cdp, `http://127.0.0.1:${cfg.cdpPort}`);
  assert.ok(Array.isArray(s.tabs));
});

test("the HTTP API refuses web pages and DNS rebinding", { skip }, async () => {
  assert.equal(await rawHttp(cfg.httpPort, { headers: { origin: "https://evil.example" } }), 403);
  assert.equal(await rawHttp(cfg.httpPort, { headers: { "sec-fetch-site": "cross-site" } }), 403);
  assert.equal(await rawHttp(cfg.httpPort, { headers: { host: "evil.example" } }), 403);
  assert.equal(await rawHttp(cfg.httpPort, { method: "GET", path: "/claim?name=x" }), 404); // claims are POST only
  assert.equal(await rawHttp(cfg.httpPort, { method: "POST", path: "/quit" }), 403);        // quitting needs the token
  assert.equal(await rawHttp(cfg.httpPort), 200);
});

test("the browser's DevTools socket refuses web page origins", { skip }, async () => {
  const ver = await (await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/version`)).json();
  const code = await new Promise((resolve) => {
    const u = new URL(ver.webSocketDebuggerUrl);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: {
      connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", origin: "https://evil.example" } });
    req.on("response", (res) => resolve(res.statusCode));
    req.on("upgrade", () => resolve(101));
    req.on("error", () => resolve(0));
    req.end();
  });
  assert.notEqual(code, 101, "a cross-origin page must not get a DevTools websocket");
});

test("the view socket needs the token: no token, a wrong one or an HTTP request gets dropped", { skip }, async () => {
  for (const first of ['{"t":"navigate","url":"https://example.com"}', '{"t":"hello","token":"nope"}', "POST / HTTP/1.1"]) {
    const v = await connectView();
    v.sock.write(first + "\n");
    await waitFor(async () => v.closed, 6000, "socket close");
  }
});

let view, target;
test("a view attaches, gets frames as real JPEG files under the app home", { skip }, async () => {
  view = await connectView(token());
  const hello = await view.next((m) => m.t === "hello");
  assert.equal(typeof hello.version, "string");
  view.send({ t: "resize", w: 640, h: 400 });
  view.send({ t: "attach", target: null, url: FIXTURE });
  const att = await view.next((m) => m.t === "attached");
  target = att.target;
  await view.next((m) => m.t === "nav" && m.url.startsWith("file:"), 15000, "nav to fixture");
  assert.equal((await status()).tabs.length, 1, "the blank tab the browser started with was reused");
  const frame = await view.next((m) => m.t === "frame", 15000, "a frame");
  assert.match(frame.file, /^data\/webtab\/frames\/v\d+-\d+\.jpg$/);
  const bytes = fs.readFileSync(path.join(HOME, frame.file));
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8); // JPEG
  assert.equal(frame.w, 640);
});

test("clicks and typing from the view reach the page", { skip }, async () => {
  const agent = await agentOn(target);
  await waitFor(async () => (await agent.eval("document.readyState")) === "complete", 10000, "page load");
  view.send({ t: "mouse", type: "mousePressed", x: 60, y: 40, button: "left", buttons: 1, clickCount: 1 });
  view.send({ t: "mouse", type: "mouseReleased", x: 60, y: 40, button: "left", buttons: 0, clickCount: 1 });
  await waitFor(async () => (await agent.eval("window.clicks")) === 1, 5000, "click counted");
  view.send({ t: "mouse", type: "mousePressed", x: 100, y: 94, button: "left", buttons: 1, clickCount: 1 });
  view.send({ t: "mouse", type: "mouseReleased", x: 100, y: 94, button: "left", buttons: 0, clickCount: 1 });
  await sleep(150);
  view.send({ t: "text", text: "hello ✓" });
  await waitFor(async () => (await agent.eval("document.querySelector('#box').value")) === "hello ✓", 5000, "typed text");
  agent.close();
});

test("a <select> click becomes a menu message, and picking sets the value", { skip }, async () => {
  view.send({ t: "mouse", type: "mousePressed", x: 80, y: 144, button: "left", buttons: 1, clickCount: 1 });
  view.send({ t: "mouse", type: "mouseReleased", x: 80, y: 144, button: "left", buttons: 0, clickCount: 1 });
  const sel = await view.next((m) => m.t === "select", 5000, "select message");
  assert.deepEqual(sel.options.map((o) => o.label), ["Human", "Dwarf", "Orc", "Tauren", "Goblin"]);
  assert.deepEqual(sel.options.map((o) => o.group), ["Alliance", "Alliance", "Horde", "Horde", "Horde"]);
  assert.equal(sel.options[4].disabled, true);
  assert.equal(sel.selected, 0);
  view.send({ t: "pick", id: sel.id, index: 3 });
  const agent = await agentOn(target);
  await waitFor(async () => (await agent.eval("window.changed")) === "Tauren", 5000, "change event");
  agent.close();
});

test("page-side strings only ever get numbers (no script injection through coordinates)", { skip }, async () => {
  view.send({ t: "cursor", x: "0, 0); window.pwned = 1; (0", y: 0 });
  await view.next((m) => m.t === "cursor", 5000, "cursor reply");
  const agent = await agentOn(target);
  assert.equal(await agent.eval("window.pwned"), undefined);
  agent.close();
});

test("an agent navigating the page shows as a driver; a claim names it", { skip }, async () => {
  await sleep(3200); // past the window in which navigation counts as the person's
  view.clear();
  const agent = await agentOn(target);
  await agent.send("Page.navigate", { url: FIXTURE + "?agent" });
  const d = await view.next((m) => m.t === "driver", 8000, "driver message");
  assert.equal(d.who, "agent");
  // A claim without a tab names the agent but shows nothing until it acts…
  view.clear();
  assert.equal((await fetch(`http://127.0.0.1:${cfg.httpPort}/claim?name=Test%20Agent`, { method: "POST" })).status, 200);
  await sleep(600);
  assert.equal(view.msgs.filter((m) => m.t === "driver").length, 0, "no badge on a tab the agent isn't touching");
  await sleep(3000);
  await agent.send("Page.navigate", { url: FIXTURE + "?named" });
  const named = await view.next((m) => m.t === "driver" && m.who === "Test Agent", 8000, "named driver");
  assert.equal(named.why, "navigated");
  // …and a claim for this tab shows at once.
  await fetch(`http://127.0.0.1:${cfg.httpPort}/claim?name=Other&target=${target}`, { method: "POST" });
  await view.next((m) => m.t === "driver" && m.who === "Other" && m.why === "claimed", 5000, "targeted claim");
  agent.close();
});

test("tabs: new tab, tab list, switch back, close", { skip }, async () => {
  view.clear();
  view.send({ t: "newtab", url: "about:blank#second" });
  const att = await view.next((m) => m.t === "attached" && m.target !== target, 10000, "attach to new tab");
  const list = await view.next((m) => m.t === "tabs" && m.tabs.some((t) => t.id === att.target) && m.tabs.some((t) => t.id === target), 5000, "tab list");
  assert.ok(list.tabs.length >= 2);
  view.send({ t: "switch", id: target });
  await view.next((m) => m.t === "attached" && m.target === target, 10000, "switch back");
  view.send({ t: "closetab", id: att.target });
  await waitFor(async () => !(await status()).tabs.some((t) => t.id === att.target), 5000, "tab closed");
});

test("two quick switches end on the second tab, and the first never navigates it", { skip }, async () => {
  const before = (await status()).tabs.length;
  view.clear();
  view.send({ t: "newtab", url: FIXTURE + "?first" });
  view.send({ t: "switch", id: target });
  await view.next((m) => m.t === "attached" && m.target === target, 10000, "attach to the switched-to tab");
  await sleep(1500);
  const s = await status();
  assert.equal(s.tabs.find((t) => t.id === target).url.includes("?first"), false, "the old tab wasn't navigated by the superseded attach");
  for (const t of s.tabs) if (t.url.includes("?first")) await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/close/${t.id}`);
  await waitFor(async () => (await status()).tabs.length === before, 5000, "cleanup");
});

test("a page's confirm() reaches the view as a dialog, and the answer reaches the page", { skip }, async () => {
  view.clear();
  view.send({ t: "navigate", url: "data:text/html," + encodeURIComponent("<title>d</title><script>setTimeout(() => { window.answer = confirm('Sure?'); }, 300)</script>") });
  const d = await view.next((m) => m.t === "dialog", 10000, "dialog");
  assert.equal(d.kind, "confirm"); assert.equal(d.message, "Sure?");
  view.send({ t: "dialog", accept: true });
  await view.next((m) => m.t === "dialog-closed", 5000, "dialog closed");
  const agent = await agentOn(target);
  assert.equal(await agent.eval("window.answer"), true);
  agent.close();
});

test("a window the person's click opens takes the view along", { skip }, async () => {
  view.clear();
  view.send({ t: "navigate", url: "data:text/html," + encodeURIComponent("<a href='about:blank#popup' target='_blank' style='position:absolute;left:0;top:0;width:200px;height:100px;display:block'>open</a>") });
  await view.next((m) => m.t === "loaded", 10000, "page loaded");
  view.send({ t: "mouse", type: "mousePressed", x: 50, y: 50, button: "left", buttons: 1, clickCount: 1 });
  view.send({ t: "mouse", type: "mouseReleased", x: 50, y: 50, button: "left", buttons: 0, clickCount: 1 });
  const att = await view.next((m) => m.t === "attached" && m.target !== target, 10000, "attach to the popup");
  view.send({ t: "switch", id: target });
  await view.next((m) => m.t === "attached" && m.target === target, 10000, "back");
  await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/close/${att.target}`);
  view.send({ t: "navigate", url: FIXTURE });
  await view.next((m) => m.t === "loaded", 10000, "fixture again");
});

test("the page on screen keeps updating when an agent opens a tab next to it", { skip }, async () => {
  const agentTab = await (await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/new?about:blank`, { method: "PUT" })).json();
  await sleep(800);
  const agent = await agentOn(target);
  view.clear();
  await agent.eval("document.body.style.background = 'rgb(0, 128, 255)'; 1");
  await view.next((m) => m.t === "frame", 5000, "a frame after the change");
  agent.close();
  await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/close/${agentTab.id}`);
});

test("a view that stops reading doesn't stall the others", { skip }, async () => {
  const anim = "data:text/html," + encodeURIComponent("<body style='margin:0'><div id=b style='width:80px;height:80px;background:red'></div>" +
    "<script>let x=0;setInterval(()=>{b.style.marginLeft=(x=(x+7)%400)+'px'},16)</script>");
  const slow = await connectView(token());
  await slow.next((m) => m.t === "hello");
  slow.send({ t: "resize", w: 800, h: 600 });
  slow.send({ t: "attach", target: null, url: anim });
  await slow.next((m) => m.t === "frame", 15000, "slow view frame");
  slow.sock.pause(); // stops reading, like a retired mod copy
  const fast = await connectView(token());
  await fast.next((m) => m.t === "hello");
  fast.send({ t: "resize", w: 400, h: 300 });
  fast.send({ t: "attach", target: null, url: anim });
  await fast.next((m) => m.t === "attached");
  fast.clear();
  await sleep(3000);
  assert.ok(fast.msgs.filter((m) => m.t === "frame").length >= 10, "the reading view kept getting frames");
  assert.equal((await status()).ready, true);
  slow.sock.destroy(); fast.sock.destroy();
});

test("a second engine leaves the first one alone", { skip }, async () => {
  const second = spawn(process.execPath, [ENGINE, "--app-home", HOME], { stdio: "ignore" });
  const code = await new Promise((r) => second.on("exit", r));
  assert.equal(code, 0);
  assert.equal((await status()).ready, true);
});

test("when the browser dies, the engine relaunches it and the view comes back", { skip }, async () => {
  view.clear();
  await closeChrome(cfg);
  await view.next((m) => m.t === "attached", 30000, "re-attach after browser restart");
  assert.equal((await status()).ready, true);
  await view.next((m) => m.t === "frame", 15000, "frames again");
});

test("--stop ends the engine and its browser", { skip }, async () => {
  view.sock.destroy();
  await stopEngine(HOME, { closeBrowser: true });
  assert.equal(await portOpen(cfg.port), false);
  await waitFor(async () => !(await portOpen(cfg.cdpPort)), 10000, "browser closed");
});
