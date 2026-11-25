// webtab (experiment A): a browser tab drawn natively by Herdr.
// Edge/Chrome runs headless with a CDP port; this mod streams its screencast
// frames into image() and forwards mouse/keys/scroll back over CDP.
// Agents attach to the same CDP endpoint and drive the same page.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, appHome, props, panes, focused } from "herdr";
import * as fs from "fs/promises";
import { WebSocket } from "websocket";
import { Buffer } from "buffer";

const HEADLESS = "http://127.0.0.1:9333", DOCKED = "http://127.0.0.1:9334";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LUT = new Uint8Array(256); for (let i = 0; i < 64; i++) LUT[B64.charCodeAt(i)] = i;
function b64decode(s) {
  let len = s.length; while (len && s[len - 1] === "=") len--;
  const out = new Uint8Array((len * 3) >> 2); let o = 0, i = 0;
  for (; i + 4 <= len; i += 4) {
    const n = (LUT[s.charCodeAt(i)] << 18) | (LUT[s.charCodeAt(i + 1)] << 12) | (LUT[s.charCodeAt(i + 2)] << 6) | LUT[s.charCodeAt(i + 3)];
    out[o++] = n >> 16; out[o++] = (n >> 8) & 255; out[o++] = n & 255;
  }
  const r = len - i;
  if (r >= 2) { const n = (LUT[s.charCodeAt(i)] << 18) | (LUT[s.charCodeAt(i + 1)] << 12) | (r === 3 ? LUT[s.charCodeAt(i + 2)] << 6 : 0); out[o++] = n >> 16; if (r === 3) out[o++] = (n >> 8) & 255; }
  return o === out.length ? out : out.slice(0, o);
}
const VK = { enter: [13, "Enter", "\r"], backspace: [8, "Backspace"], tab: [9, "Tab"], escape: [27, "Escape"], delete: [46, "Delete"],
  left: [37, "ArrowLeft"], up: [38, "ArrowUp"], right: [39, "ArrowRight"], down: [40, "ArrowDown"], home: [36, "Home"], end: [35, "End"],
  pageup: [33, "PageUp"], pagedown: [34, "PageDown"], space: [32, " ", " "] };

export default class WebTab extends View {
  init(p, cx) {
    this.dir = `${appHome()}/data/webtab`.replace(/\\/g, "/");
    this.rel = "data/webtab";
    this.frame = null; this.n = 0; this.status = "connecting…"; this.url = ""; this.title = "";
    this.size = { width: 800, height: 600 }; this.id = 1; this.pending = new Map();
    this.stats = { frames: 0, t0: Date.now(), fps: 0, decode: 0, write: 0, bytes: 0 };
    this.focus = cx.focus_handle();
    this.addr = InputState.new({ placeholder: "Address" });
    this.addr.on("submit", (_e, cx) => { let u = this.addr.value().trim(); if (!/^[a-z]+:/i.test(u)) u = "https://" + u; this.send("Page.navigate", { url: u }); this.focus.focus(); });
    cx.spawn(async (cx) => this.connect(cx, p?.url));
  }

  send(method, params = {}) {
    if (!this.ws) return Promise.resolve(null);
    const id = this.id++;
    return new Promise((res) => { this.pending.set(id, res); this.ws.write(JSON.stringify({ id, method, params })).catch(() => {}); });
  }

  async connect(cx, url) {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      this.docked = false;
      try { this.docked = (await fetch(`${DOCKED}/json/version`)).ok; } catch {}
      const CDP = this.docked ? DOCKED : HEADLESS;
      const list = await (await fetch(`${CDP}/json/list`)).json();
      let page;
      if (this.docked) {
        // The visible Chromium window that dock2.py placed over this view: drive it, don't stream it.
        page = list.find((t) => t.type === "page" && !t.url.startsWith("chrome://"));
        if (!page) throw new Error("docked browser has no page");
        this.url = page.url; this.addr.set_value(page.url);
      } else {
        const want = localStorage.getItem("target");
        page = list.find((t) => t.id === want && t.type === "page");
        if (!page) { page = await (await fetch(`${CDP}/json/new?${url || "https://example.com"}`, { method: "PUT" })).json(); url = null; }
        localStorage.setItem("target", page.id);
      }
      this.target = page.id;
      this.ws = await WebSocket.connect(page.webSocketDebuggerUrl);
      this.status = (this.docked ? "docked" : "live") + (this.drops ? ` (reconnected ${this.drops}x)` : ""); cx.notify();
      cx.spawn(async (cx) => this.readLoop(cx));
      await this.send("Page.enable");
      await this.applySize();
      if (url) await this.send("Page.navigate", { url });
    } catch (e) { this.status = "error: " + e; cx.notify(); await cx.sleep(2000); return this.connect(cx, null); }
  }

  async applySize() {
    if (this.docked) return;
    const w = Math.max(200, Math.round(this.size.width)), h = Math.max(150, Math.round(this.size.height));
    await this.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await this.send("Page.stopScreencast");
    await this.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: w, maxHeight: h, everyNthFrame: 1 });
  }

  async readLoop(cx) {
    for (;;) {
      let msg;
      try { msg = await this.ws.read(); }
      catch (e) {
        this.ws = null; this.drops = (this.drops || 0) + 1; this.status = `reconnecting (${this.drops})`; cx.notify();
        for (const r of this.pending.values()) r(null); this.pending.clear();
        await cx.sleep(800); return this.connect(cx, null);
      }
      const m = JSON.parse(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m.result); this.pending.delete(m.id); continue; }
      if (m.method === "Page.screencastFrame") {
        this.ws.write(JSON.stringify({ id: this.id++, method: "Page.screencastFrameAck", params: { sessionId: m.params.sessionId } })).catch(() => {});
        const t1 = Date.now(); const meta = m.params.metadata; const w = Math.round(meta.deviceWidth), h = Math.round(meta.deviceHeight); this.fw = w; this.fh = h;
        if (this.binaryOk === undefined) this.binaryOk = await this.probeBinary();
        let body, ext;
        if (this.binaryOk) { body = Buffer.from(m.params.data, "base64"); ext = "jpg"; }
        else { body = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" xlink:href="data:image/jpeg;base64,${m.params.data}"/></svg>`; ext = "svg"; }
        const bytes = { length: m.params.data.length * 3 / 4 }; const t2 = Date.now();
        const name = `f${this.n++ % 6}-${Date.now()}.${ext}`;
        await fs.writeFile(`${this.dir}/${name}`, body); const t3 = Date.now();
        const old = this.frame; this.frame = name;
        if (old) fs.unlink(`${this.dir}/${old}`).catch(() => {});
        const s = this.stats; s.frames++; s.decode = t2 - t1; s.write = t3 - t2; s.bytes = bytes.length;
        const dt = Date.now() - s.t0; if (dt > 2000) { s.fps = (s.frames * 1000 / dt).toFixed(1); s.frames = 0; s.t0 = Date.now(); }
        cx.notify();
      } else if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) {
        this.url = m.params.frame.url; this.addr.set_value(this.url); cx.notify();
      }
    }
  }

  async probeBinary() {
    try {
      const f = `${this.dir}/probe.bin`; await fs.writeFile(f, Buffer.from("/9j/AA==", "base64"));
      const back = await fs.readFile(f); this.probe = `buffer write ${back.length}B`; return back.length === 4 && back[0] === 0xff;
    } catch (e) { this.probe = "buffer write err " + e; return false; }
  }

  mouse(type, e, extra = {}) {
    const p = e.local_position; if (!p || this.docked) return;
    this.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: e.click_count || 1, ...extra });
  }

  key(e) {
    const k = VK[e.key];
    const mods = (e.modifiers.alt ? 1 : 0) | (e.modifiers.control ? 2 : 0) | (e.modifiers.platform ? 4 : 0) | (e.modifiers.shift ? 8 : 0);
    if (k) {
      this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: k[0], key: k[1], modifiers: mods });
      if (k[2]) this.send("Input.dispatchKeyEvent", { type: "char", text: k[2], modifiers: mods });
      this.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: k[0], key: k[1], modifiers: mods });
    } else if (e.key_char && !e.modifiers.control) {
      this.send("Input.insertText", { text: e.key_char });
    }
  }

  // Experiment C: tell the docking helper where the view is and whether its tab is showing.
  publish() {
    const me = panes().find((p) => p.pane === props()?.pane) || panes().find((p) => p.mod === "webtab");
    const shown = !!me && focused()?.tab === me.tab;
    const o = this.origin || { x: 316, y: 127 };
    const msg = JSON.stringify({ x: o.x, y: o.y, width: this.size.width, height: this.size.height, shown });
    if (msg !== this.lastPublished) { this.lastPublished = msg; try { fs.writeFile(`${this.dir}/bounds.json`, msg).catch(() => {}); } catch {} }
  }

  render(cx) {
    this.publish();
    const t = theme(), s = this.stats;
    const btn = (id, label, fn) => div().id(id).px(8).py(3).rounded(4).text_color(t.muted).hover((x) => x.bg(t.hover)).on_click(fn).child(label);
    const bar = h_flex().h(34).px(6).gap(4).items_center().bg(t.chrome).border_b(1).border_color(t.border).text_size(13)
      .child(btn("back", "‹", () => this.send("Runtime.evaluate", { expression: "history.back()" })))
      .child(btn("fwd", "›", () => this.send("Runtime.evaluate", { expression: "history.forward()" })))
      .child(btn("reload", "⟳", () => this.send("Page.reload")))
      .child(Input.new(this.addr).flex_1().h(24).px(8).rounded(5).border_1().border_color(t.border).bg(t.surface).text_size(12).text_color(t.foreground))
      .child(div().text_size(11).text_color(t.dim).child(`${this.status} · ${s.fps} fps · dec ${s.decode}ms · wr ${s.write}ms · ${(s.bytes / 1024) | 0}KB · keys ${this.keys || 0} ${this.lastKey || ""} · ${this.binaryOk ? "jpg" : "svg"} ${this.probe || ""}`));
    const view = div().id("view").flex_1().w_full().overflow_hidden().bg(t.background)
      .on_size_change((size, cx) => { this.size = size; this.applySize(); this.publish(); })
      .track_focus(this.focus)
      .on_mouse_down("left", (e, cx) => { this.focus.focus(); this.mouse("mousePressed", e); })
      .on_mouse_up("left", (e) => this.mouse("mouseReleased", e))
      .on_mouse_move((e) => { this.mouse("mouseMoved", e, { button: "none" }); if (e.bounds) { this.origin = { x: e.bounds.x, y: e.bounds.y }; this.publish(); } })
      .on_scroll_wheel((e) => { const p = e.local_position; if (p) this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: -e.delta.x, deltaY: -e.delta.y }); })
      .on_key_down((e, cx) => { this.keys = (this.keys || 0) + 1; this.lastKey = e.keystroke; this.key(e); cx.stop_propagation(); cx.notify(); })
      .child(this.frame ? image(`${this.rel}/${this.frame}`).w(this.fw || this.size.width).h(this.fh || this.size.height) : div().p(20).text_color(t.muted).child(this.status));
    return v_flex().id("root").size_full().child(bar).child(view);
  }

  async close() { try { await this.send("Page.stopScreencast"); this.ws?.close(); } catch {} }
}
