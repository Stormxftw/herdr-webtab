// webtab: a browser tab drawn by Herdr itself (GPUI), not a window on top.
// The engine is webtabd (webtabd.mjs next to this file): it owns a headless
// Chromium, writes each screencast frame as a JPEG, and this mod draws it with image().
// Mouse, wheel, keys and navigation go back over a local socket. Agents drive the same
// Chromium over CDP (127.0.0.1:9333), so you see what they do and they see what you do.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, hc, run, panes, props } from "herdr";
import net from "net";

const PORT = 9440;
const NODE = "node"; // path to node if it isn't on PATH
const DAEMON = "/path/to/webtabd.mjs"; // where you put the engine
// Frames stay stacked so the previous one shows while GPUI loads the next (no flicker).
const STACK = 3;

// keyboard: GPUI key name -> [DOM key, DOM code, Windows VK]
const KEYS = {
  enter: ["Enter", "Enter", 13], backspace: ["Backspace", "Backspace", 8], tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27],
  delete: ["Delete", "Delete", 46], left: ["ArrowLeft", "ArrowLeft", 37], up: ["ArrowUp", "ArrowUp", 38], right: ["ArrowRight", "ArrowRight", 39],
  down: ["ArrowDown", "ArrowDown", 40], home: ["Home", "Home", 36], end: ["End", "End", 35], pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34], space: [" ", "Space", 32], insert: ["Insert", "Insert", 45],
  f1: ["F1", "F1", 112], f5: ["F5", "F5", 116], f12: ["F12", "F12", 123],
};
// Keys GPUI/Herdr bind globally (focus navigation): claim them in our own key context.
const CLAIMED = ["tab", "shift-tab", "up", "down", "left", "right", "shift-up", "shift-down", "shift-left", "shift-right",
  "ctrl-left", "ctrl-right", "ctrl-shift-left", "ctrl-shift-right", "home", "end", "pageup", "pagedown", "escape"];
const EDIT = { a: "selectAll", c: "copy", x: "cut", z: "undo", y: "redo" };
const utf8 = (bytes) => { try { return new TextDecoder().decode(bytes); } catch { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return decodeURIComponent(escape(s)); } };
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export default class WebTab extends View {
  init(p, cx) {
    this.frames = []; this.status = "starting engine…"; this.url = ""; this.title = ""; this.loading = false;
    this.size = { width: 800, height: 600 }; this.cursor = "default"; this.fps = 0; this.buttons = 0;
    this.focus = cx.focus_handle();
    try { cx.bind_keys(CLAIMED.map((k) => ({ keystroke: k, action: "webtab::" + k, context: "WebTab" }))); } catch {}
    this.addr = InputState.new({ placeholder: "Search or enter address" });
    this.addr.on("submit", (_e, cx) => { this.cmd({ t: "navigate", url: this.addr.value() }); this.focus.focus(); });
    this.addr.on("focus", () => { this.editing = true; });
    this.addr.on("blur", () => { this.editing = false; this.addr.set_value(this.url); });
    cx.spawn(async (cx) => this.connect(cx, p?.url));
  }

  cmd(o) { if (this.sock) this.sock.write(JSON.stringify(o) + "\n").catch(() => {}); }

  async connect(cx, url) {
    for (let attempt = 0; ; attempt++) {
      try { this.sock = await net.connect("127.0.0.1", PORT); break; }
      catch {
        if (attempt === 0) { this.status = "starting engine…"; cx.notify(); await hc(["run", "--bg", "--no-parent", "--name", "webtabd", "--label", "webtab=engine", "--", NODE, DAEMON]).catch(() => {}); }
        if (attempt > 40) { this.status = "engine didn't start (hc ls → webtabd)"; cx.notify(); return; }
        await cx.sleep(250);
      }
    }
    this.status = "connected"; cx.notify();
    this.cmd({ t: "resize", w: this.size.width, h: this.size.height });
    const saved = localStorage.getItem("target");
    this.cmd({ t: "attach", target: saved, url: url || (saved ? null : "https://duckduckgo.com") });
    let buf = "";
    for (;;) {
      const chunk = await this.sock.read(1 << 20).catch(() => null);
      if (!chunk) { this.sock = null; this.status = "engine stopped, reconnecting"; cx.notify(); await cx.sleep(1000); return this.connect(cx, null); }
      buf += utf8(chunk); let i, any = false, newest = null;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line) continue;
        const m = JSON.parse(line); any = true;
        if (m.t === "frame") newest = m; else this.onMsg(m, cx);
      }
      // Only the newest frame of a burst joins the stack, so the frames under it are ones GPUI already drew.
      if (newest) this.onMsg(newest, cx);
      if (any) cx.notify();
    }
  }

  onMsg(m, cx) {
    switch (m.t) {
      case "attached": localStorage.setItem("target", m.target); this.status = "live"; this.setUrl(m.url); this.setTitle(m.title); break;
      case "frame": {
        // A new frame loads underneath, covered; it moves to the top on the next frame or after 35 ms.
        const f = { file: m.file, w: m.w, h: m.h };
        if (this.incoming) this.promote();
        this.incoming = f; this.fps = m.fps;
        cx.timer.after(35, (cx) => { if (this.incoming === f) { this.promote(); cx.notify(); } });
        break;
      }
      case "nav": this.setUrl(m.url); break;
      case "loading": this.loading = true; break;
      case "loaded": this.loading = false; break;
      case "title": this.setTitle(m.title); break;
      case "cursor": this.cursor = m.cursor; break;
      case "copied": if (m.text) cx.write_to_clipboard(m.text); break;
      case "status": this.status = m.status; break;
    }
  }

  promote() {
    this.frames.push(this.incoming); this.incoming = null;
    if (this.frames.length > STACK) this.frames.shift();
  }

  setUrl(u) { this.url = u; if (!this.editing) this.addr.set_value(u); }
  setTitle(t) {
    this.title = t;
    // Name the Herdr tab after the page, like a browser tab.
    const me = panes().find((p) => p.pane === props()?.pane) || panes().find((p) => p.mod === "webtab");
    if (me && t && t !== this.tabTitle) { this.tabTitle = t; run("tab.rename", { id: me.tab, name: "🌐 " + short(t, 24) }); }
  }

  // ---- input ----
  mods(m) { return (m.alt ? 1 : 0) | (m.control ? 2 : 0) | (m.platform ? 4 : 0) | (m.shift ? 8 : 0); }
  mouse(type, e, button) {
    // A release must always reach Chrome; fall back to the last position if this event has none.
    const p = e.local_position || (type === "mouseReleased" ? this.lastPos : null); if (!p) return;
    this.lastPos = p;
    if (type === "mousePressed") this.buttons |= button === "right" ? 2 : 1;
    if (type === "mouseReleased") this.buttons &= ~(button === "right" ? 2 : 1);
    this.cmd({ t: "mouse", type, x: p.x, y: p.y, button: button || (this.buttons & 1 ? "left" : "none"), buttons: this.buttons,
      clickCount: type === "mouseMoved" ? 0 : (e.click_count || 1), modifiers: this.mods(e.modifiers) });
    if (type === "mouseMoved" && !this.buttons) {
      const now = Date.now(); if (now - (this.lastCursorAsk || 0) > 120) { this.lastCursorAsk = now; this.cmd({ t: "cursor", x: p.x, y: p.y }); }
    }
  }
  sendNamed(name, mods) {
    const [key, code, vk] = KEYS[name];
    this.cmd({ t: "key", event: { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers: mods } });
    if (key === "Enter") this.cmd({ t: "key", event: { type: "char", text: "\r", key, code, windowsVirtualKeyCode: vk, modifiers: mods } });
    else if (key === " " && !(mods & 6)) this.cmd({ t: "key", event: { type: "char", text: " ", key, code, windowsVirtualKeyCode: vk, modifiers: mods } });
    this.cmd({ t: "key", event: { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: mods } });
  }
  claimed(chord) {
    const parts = chord.split("-"), name = parts.pop();
    const mods = (parts.includes("alt") ? 1 : 0) | (parts.includes("ctrl") ? 2 : 0) | (parts.includes("shift") ? 8 : 0);
    this.sendNamed(name, mods);
  }
  key(e, cx) {
    const m = e.modifiers, mods = this.mods(m), ctl = m.control || m.platform, k = e.key;
    // browser-chrome shortcuts handled by the tab itself
    if (ctl && k === "l") { this.addr.focus(); return; }
    if ((ctl && k === "r") || k === "f5") { this.cmd({ t: "reload" }); return; }
    if (m.alt && k === "left") { this.cmd({ t: "back" }); return; }
    if (m.alt && k === "right") { this.cmd({ t: "forward" }); return; }
    if (ctl && k === "v") { const text = cx.read_from_clipboard(); if (text) this.cmd({ t: "text", text }); return; }
    if (ctl && EDIT[k]) {
      // Real editing command in the page (fires copy/cut events), plus the selection onto the OS clipboard for copy/cut.
      const vk = k.toUpperCase().charCodeAt(0), base = { key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: vk, modifiers: mods };
      this.cmd({ t: "key", event: { ...base, type: "rawKeyDown", commands: [EDIT[k]] } });
      this.cmd({ t: "key", event: { ...base, type: "keyUp" } });
      if (k === "c" || k === "x") this.cmd({ t: "copy" });
      return;
    }
    if (KEYS[k]) {
      this.sendNamed(k, mods);
    } else if (ctl && k.length === 1) {
      // other ctrl chords as real key events (no text)
      const vk = k.toUpperCase().charCodeAt(0);
      this.cmd({ t: "key", event: { type: "rawKeyDown", key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: vk, modifiers: mods } });
      this.cmd({ t: "key", event: { type: "keyUp", key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: vk, modifiers: mods } });
    } else if (e.key_char) {
      this.cmd({ t: "text", text: e.key_char });
    }
  }

  render(cx) {
    const t = theme();
    const icon = (id, glyph, fn) => div().id(id).w(26).h(26).flex().items_center().justify_center().rounded(6).text_size(15)
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer().on_click(fn).child(glyph);
    const secure = this.url.startsWith("https://");
    const bar = h_flex().h(40).px(8).gap(4).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(icon("back", "←", () => this.cmd({ t: "back" })))
      .child(icon("fwd", "→", () => this.cmd({ t: "forward" })))
      .child(this.loading
        ? div().w(26).h(26).flex().items_center().justify_center().text_color(t.accent).text_size(14).child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 80))
        : icon("reload", "↻", () => this.cmd({ t: "reload" })))
      .child(h_flex().flex_1().h(28).px(10).gap(6).items_center().rounded(14).bg(t.surface).border_1().border_color(t.border)
        .child(div().text_size(11).text_color(secure ? t.done : t.dim).child(secure ? "🔒" : "ⓘ"))
        .child(Input.new(this.addr).flex_1().text_size(12.5).text_color(t.foreground)))
      .child(div().px(6).text_size(10.5).text_color(t.dim).child(this.status === "live" ? `${this.fps} fps` : this.status));
    // Bottom: the incoming frame (loading, covered). Above it: frames GPUI already drew, newest on top.
    const layer = (f) => image(f.file).absolute().top(0).left(0).w(f.w).h(f.h);
    const layers = [...(this.incoming ? [layer(this.incoming)] : []), ...this.frames.map(layer)];
    const view = div().id("view").relative().flex_1().w_full().overflow_hidden().bg(this.frames.length ? "#ffffff" : t.background)
      .when(this.cursor === "pointer", (el) => el.cursor_pointer())
      .when(this.cursor === "text", (el) => el.cursor_text())
      .on_size_change((size) => { this.size = size; this.cmd({ t: "resize", w: size.width, h: size.height }); })
      .track_focus(this.focus)
      .key_context("WebTab")
      .when(true, (el) => CLAIMED.reduce((el, k) => el.on_action("webtab::" + k, () => this.claimed(k)), el))
      .on_mouse_down("left", (e) => { this.focus.focus(); this.mouse("mousePressed", e, "left"); })
      .on_mouse_down("right", (e) => { this.focus.focus(); this.mouse("mousePressed", e, "right"); })
      // While a button is held, follow the pointer and catch its release anywhere in the window,
      // so a drag that leaves the view keeps going and never leaves Chrome holding the button.
      .on_window_mouse_up("left", (e) => { if (this.buttons & 1) this.mouse("mouseReleased", e, "left"); })
      .on_window_mouse_up("right", (e) => { if (this.buttons & 2) this.mouse("mouseReleased", e, "right"); })
      .on_window_mouse_move((e) => { if (this.buttons) this.mouse("mouseMoved", e); })
      .on_mouse_move((e) => { if (!this.buttons) this.mouse("mouseMoved", e); })
      .on_scroll_wheel((e) => { const p = e.local_position; if (p) this.cmd({ t: "wheel", x: p.x, y: p.y, dx: -e.delta.x, dy: -e.delta.y, modifiers: this.mods(e.modifiers) }); })
      .on_key_down((e, cx) => { this.key(e, cx); cx.stop_propagation(); })
      .children(layers.length ? layers : [div().size_full().flex().items_center().justify_center().text_color(t.muted).child(this.status)]);
    return v_flex().id("root").size_full().bg(t.background).child(bar).child(view);
  }

  async close() { try { this.sock?.close(); } catch {} }
}
