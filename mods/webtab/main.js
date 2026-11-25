// webtab: a browser tab drawn by Herdr itself (GPUI).
//
// The engine (node/webtabd.mjs) owns a headless Chromium and writes each frame as a JPEG; this mod
// draws it with image() and sends mouse, wheel, keys and navigation back over a local socket.
// Agents drive the same Chromium over CDP, so you see what they do and they see what you do.
//
// props: { id?: string, url?: string, target?: string }
//   id      makes this copy's saved state its own (copies with the same props share localStorage)
//   url     open this address in a new browser tab
//   target  show an existing browser tab (a CDP target id)
//   herdr-app do tab.new '{"name":"🌐 Web","mod":"webtab","props":{"id":"a1","url":"https://example.com"}}'
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, exec, appHome, readTextFile, checking, nextCommand, run, panes, props, agents, focused } from "herdr";
import net from "net";

const STACK = 3; // frames kept drawn under the newest, so a frame still loading never shows as a blank

// Module scope is shared by every copy of this mod: which props keys and panes are taken.
const LIVE_KEYS = new Map();
const CLAIMED_PANES = new Set();

// GPUI key name -> [DOM key, DOM code, Windows virtual key]
const KEYS = {
  enter: ["Enter", "Enter", 13], backspace: ["Backspace", "Backspace", 8], tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27],
  delete: ["Delete", "Delete", 46], left: ["ArrowLeft", "ArrowLeft", 37], up: ["ArrowUp", "ArrowUp", 38], right: ["ArrowRight", "ArrowRight", 39],
  down: ["ArrowDown", "ArrowDown", 40], home: ["Home", "Home", 36], end: ["End", "End", 35], pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34], space: [" ", "Space", 32], insert: ["Insert", "Insert", 45],
  f1: ["F1", "F1", 112], f5: ["F5", "F5", 116], f12: ["F12", "F12", 123],
};
// GPUI's focus navigation takes these before a mod's on_key_down: claim them in our own key context.
const CLAIMED = ["tab", "shift-tab", "up", "down", "left", "right", "shift-up", "shift-down", "shift-left", "shift-right",
  "ctrl-left", "ctrl-right", "ctrl-shift-left", "ctrl-shift-right", "home", "end", "pageup", "pagedown", "escape", "enter"];
const EDIT = { a: "selectAll", c: "copy", x: "cut", z: "undo", y: "redo" };
const utf8 = (bytes) => { try { return new TextDecoder().decode(bytes); } catch { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return decodeURIComponent(escape(s)); } };
const short = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const host = (u) => { try { return new URL(u).host || u; } catch { return u; } };
const memoryStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

export default class WebTab extends View {
  init(_p, cx) {
    this.frames = []; this.incoming = null; this.status = "starting…"; this.url = ""; this.title = ""; this.loading = false;
    this.size = { width: 800, height: 600 }; this.cursor = "default"; this.fps = 0; this.buttons = 0;
    this.tabs = []; this.activity = {}; this.driver = null; this.select = null;
    this.focus = cx.focus_handle();
    try { cx.bind_keys(CLAIMED.map((k) => ({ keystroke: k, action: "webtab::" + k, context: "WebTab" }))); } catch {}
    this.addr = InputState.new({ placeholder: "Search or enter address" });
    this.addr.on("submit", () => { this.cmd({ t: "navigate", url: this.addr.value() }); this.focus.focus(); });
    this.addr.on("focus", () => { this.editing = true; });
    this.addr.on("blur", () => { this.editing = false; this.addr.set_value(this.url); });
    this.dialogInput = InputState.new({ placeholder: "" });
    this.dialogInput.on("submit", () => this.answer(true));

    // Copies with the same props share localStorage. The first copy of a props key keeps the saved
    // state; another copy with the same props (say two plain "New web tab"s) starts its own browser tab.
    const pr = props() || {};
    this.key = JSON.stringify(pr);
    const live = LIVE_KEYS.get(this.key) || 0;
    LIVE_KEYS.set(this.key, live + 1);
    this.store = live ? memoryStore() : localStorage;
    this.claimPane();
    if (checking()) { this.status = "web tab"; return; } // herdr-app check runs init for real: start nothing
    cx.spawn(async (cx) => this.run(cx, pr));
    // "focusable": pane.go and closing a popup over this copy send "focus".
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); if (c === "focus") { this.focus.focus(); cx.notify(); } } });
  }

  // Which Herdr pane is this copy? Not in props for tab.new panes: keep the one saved for this copy,
  // else the focused web tab pane (tab.new focuses the new tab), unless another copy has it.
  claimPane() {
    if (this.paneId) return this.paneId;
    const free = (id) => id && !CLAIMED_PANES.has(id) && panes().some((x) => x.pane === id && x.mod === "webtab");
    let mine = this.store.getItem("pane");
    if (!free(mine)) { const f = focused()?.pane; mine = free(f) ? f : null; }
    if (mine) { CLAIMED_PANES.add(mine); this.store.setItem("pane", mine); this.paneId = mine; }
    return this.paneId;
  }

  cmd(o) { if (this.sock) this.sock.write(JSON.stringify(o) + "\n").catch(() => {}); }

  async readConfig() {
    try { return JSON.parse((await readTextFile(`${appHome()}/data/webtab/config.json`)) || "{}"); } catch { return {}; }
  }

  async startEngine() {
    const cfg = await this.readConfig();
    const r = await exec(cfg.node || "node", [`${appHome()}/mods/webtab/node/webtabd.mjs`, "--detach", "--app-home", appHome()], { timeout: 45000 })
      .catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
    if (r.code !== 0) {
      const why = (r.stderr || r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean).pop() || `exit ${r.code}`;
      this.status = `engine didn't start: ${short(why, 120)}`;
      return false;
    }
    return true;
  }

  async connect(cx) {
    const cfg = await this.readConfig();
    const port = cfg.port || 9440;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const token = ((await readTextFile(`${appHome()}/data/webtab/token`)) || "").trim();
        if (token) {
          const sock = await net.connect("127.0.0.1", port);
          await sock.write(JSON.stringify({ t: "hello", token }) + "\n");
          return sock;
        }
      } catch {}
      this.status = "starting the browser…"; cx.notify();
      if (!(await this.startEngine())) { cx.notify(); return null; }
    }
    return null;
  }

  async run(cx, pr) {
    let first = true;
    for (;;) {
      this.sock = await this.connect(cx);
      if (!this.sock) { cx.notify(); await cx.sleep(5000); continue; } // keep trying: the person may fix the setup
      this.status = "connected"; cx.notify();
      this.cmd({ t: "resize", w: this.size.width, h: this.size.height });
      const saved = (first && pr.target) || this.store.getItem("target");
      this.cmd({ t: "attach", target: saved || null, url: first && !pr.target && !saved ? pr.url || null : null });
      first = false;
      // A reload retires this copy: its next cx use throws. Close the socket on the way out, or the
      // engine keeps streaming to a reader that's gone.
      try { await this.readLoop(cx); } catch (e) { try { this.sock?.close(); } catch {} throw e; }
      this.sock = null; this.status = "engine stopped, reconnecting…"; cx.notify();
      await cx.sleep(1000);
    }
  }

  async readLoop(cx) {
    let buf = "", sawHello = false;
    for (;;) {
      const chunk = await this.sock.read(1 << 20).catch(() => null);
      if (!chunk) return;
      buf += utf8(chunk); let i, any = false, newest = null;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line) continue;
        try {
          const m = JSON.parse(line); any = true;
          if (m.t === "hello") sawHello = true;
          if (m.t === "frame") newest = m; else this.onMsg(m, cx);
        } catch (e) { this.status = "error: " + e; any = true; } // one bad message must not end the loop
      }
      if (newest) this.onMsg(newest, cx); // only the newest frame of a burst joins the stack
      if (any) cx.notify();
    }
  }

  onMsg(m, cx) {
    switch (m.t) {
      case "attached": this.dialog = null; this.store.setItem("target", m.target); this.target = m.target; this.status = "live"; this.frames = []; this.incoming = null; this.setUrl(m.url); this.setTitle(m.title); break;
      case "frame": {
        // A new frame loads underneath, covered; it moves to the top on the next frame or after 35 ms.
        const f = { file: m.file, w: m.w, h: m.h };
        if (this.incoming) this.promote();
        this.incoming = f; this.fps = m.fps;
        cx.timer.after(35, (cx) => { if (this.incoming === f) { this.promote(); cx.notify(); } });
        break;
      }
      case "tabs": this.tabs = m.tabs; break;
      case "nav": this.setUrl(m.url); this.select = null; break;
      case "loading": this.loading = true; break;
      case "loaded": this.loading = false; break;
      case "title": this.setTitle(m.title); break;
      case "cursor": this.cursor = m.cursor; break;
      case "copied": if (m.text) cx.write_to_clipboard(m.text); break;
      case "status": this.status = m.status; break;
      case "select": this.select = { ...m, hi: Math.max(0, m.selected) }; break;
      case "dialog": {
        this.dialog = m;
        if (m.kind === "prompt") { this.dialogInput.set_value(m.value || ""); this.dialogInput.focus(); }
        break;
      }
      case "dialog-closed": this.dialog = null; break;
      case "activity": {
        this.activity[m.target] = m.at;
        cx.timer.after(8200, (cx) => cx.notify()); // let the 🤖 on that tab fade
        break;
      }
      case "driver": {
        const d = { who: m.who, at: Date.now() };
        this.driver = d;
        cx.timer.after(5200, (cx) => { if (this.driver === d) { this.driver = null; cx.notify(); } });
        break;
      }
    }
  }

  promote() { this.frames.push(this.incoming); this.incoming = null; if (this.frames.length > STACK) this.frames.shift(); }
  setUrl(u) { this.url = u || ""; if (!this.editing) this.addr.set_value(this.url); }
  setTitle(t) { this.title = t; this.renameTab(); }
  // Names the Herdr tab after the page. Until this copy knows its pane (tab.new may still be moving
  // focus to it), render() calls this again whenever Herdr's focus or panes change.
  renameTab() {
    const id = this.claimPane();
    const me = id && panes().find((p) => p.pane === id);
    const t = this.title;
    if (me && t && t !== this.tabTitle) { this.tabTitle = t; run("tab.rename", { id: me.tab, name: "🌐 " + short(t, 24) }); }
  }
  driverName() {
    if (!this.driver) return null;
    if (this.driver.who !== "agent") return this.driver.who;
    // Nobody said who: if exactly one Herdr agent is working, it's almost certainly that one.
    const working = agents().filter((a) => a.status === "working");
    return working.length === 1 ? (working[0].program?.name || working[0].app || "An agent") : "An agent";
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
  claimed(chord, cx) {
    const parts = chord.split("-"), name = parts.pop();
    if (this.dialog && (name === "enter" || name === "escape")) { this.answer(name === "enter"); cx.notify(); return; }
    if (this.select) return this.selectKey(name, cx);
    const mods = (parts.includes("alt") ? 1 : 0) | (parts.includes("ctrl") ? 2 : 0) | (parts.includes("shift") ? 8 : 0);
    this.sendNamed(name, mods);
  }
  selectKey(name, cx) {
    const s = this.select, n = s.options.length;
    const step = (d) => { let i = s.hi; for (let k = 0; k < n; k++) { i = (i + d + n) % n; if (!s.options[i].disabled) break; } s.hi = i; };
    if (name === "down") step(1); else if (name === "up") step(-1);
    else if (name === "home") { s.hi = -1; step(1); } else if (name === "end") { s.hi = n; step(-1); }
    else if (name === "enter" || name === "space") this.pick(s.hi);
    else if (name === "escape" || name === "tab") this.select = null;
    cx.notify();
  }
  answer(accept) {
    if (!this.dialog) return;
    this.cmd({ t: "dialog", accept, ...(this.dialog.kind === "prompt" && accept ? { text: this.dialogInput.value() } : {}) });
    this.dialog = null; this.focus.focus();
  }
  // alert / confirm / prompt / beforeunload, drawn by Herdr over the page.
  dialogBox(t) {
    const d = this.dialog; if (!d) return null;
    const btn = (id, label, primary, fn) => div().id(id).h(28).px(14).flex().items_center().rounded(6).text_size(12.5).cursor_pointer()
      .bg(primary ? t.accent : t.raised).text_color(primary ? t.accent_foreground : t.foreground).hover((s) => s.opacity(0.85))
      .on_click((e, cx) => { fn(); cx.notify(); }).child(label);
    const leave = d.kind === "beforeunload";
    return div().absolute().top(0).left(0).size_full().flex().items_start().justify_center().pt(48).bg("#00000066")
      .child(v_flex().w(420).p(16).gap(10).rounded(10).bg(t.popover).border_1().border_color(t.border).shadow_lg()
        .child(div().text_size(11).text_color(t.dim).child(`${host(d.url) || "This page"} says`))
        .child(div().text_size(13).text_color(t.foreground).child(leave ? "Leave this page? Changes you made may not be saved." : d.message || " "))
        .when(d.kind === "prompt", (el) => el.child(Input.new(this.dialogInput).h(28).text_size(12.5)))
        .child(h_flex().gap(8).justify_end()
          .when(d.kind !== "alert", (el) => el.child(btn("dlg-cancel", leave ? "Stay" : "Cancel", false, () => this.answer(false))))
          .child(btn("dlg-ok", leave ? "Leave" : "OK", true, () => this.answer(true)))));
  }
  pick(i) { if (this.select && !this.select.options[i]?.disabled) this.cmd({ t: "pick", id: this.select.id, index: i }); this.select = null; }
  key(e, cx) {
    if (this.dialog) return; // the page waits for the dialog; keys go to its buttons (Enter / Escape)
    const m = e.modifiers, mods = this.mods(m), ctl = m.control || m.platform, k = e.key;
    if (this.select && k === "space") { this.pick(this.select.hi); cx.notify(); return; }
    if (this.select && k.length === 1 && !ctl) { // type-ahead in an open dropdown
      const i = this.select.options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(k.toLowerCase()));
      if (i >= 0) this.select.hi = i; cx.notify(); return;
    }
    if (ctl && k === "l") { this.addr.focus(); return; }
    if (ctl && k === "t") { this.cmd({ t: "newtab" }); return; }
    if (ctl && k === "w") { if (this.target) this.cmd({ t: "closetab", id: this.target }); return; }
    if ((ctl && k === "r") || k === "f5") { this.cmd({ t: "reload" }); return; }
    if (m.alt && k === "left") { this.cmd({ t: "back" }); return; }
    if (m.alt && k === "right") { this.cmd({ t: "forward" }); return; }
    if (ctl && k === "v") { const text = cx.read_from_clipboard(); if (text) this.cmd({ t: "text", text }); return; }
    if (ctl && EDIT[k]) {
      const vk = k.toUpperCase().charCodeAt(0), base = { key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: vk, modifiers: mods };
      this.cmd({ t: "key", event: { ...base, type: "rawKeyDown", commands: [EDIT[k]] } });
      this.cmd({ t: "key", event: { ...base, type: "keyUp" } });
      if (k === "c" || k === "x") this.cmd({ t: "copy" });
      return;
    }
    if (KEYS[k]) this.sendNamed(k, mods);
    else if (ctl && k.length === 1) {
      const vk = k.toUpperCase().charCodeAt(0);
      this.cmd({ t: "key", event: { type: "rawKeyDown", key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: vk, modifiers: mods } });
      this.cmd({ t: "key", event: { type: "keyUp", key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: vk, modifiers: mods } });
    } else if (e.key_char) this.cmd({ t: "text", text: e.key_char });
  }

  // ---- drawing ----
  tabStrip(t) {
    const now = Date.now();
    const pill = (tab) => {
      const active = tab.id === this.target, busy = now - (this.activity[tab.id] || 0) < 8000;
      return h_flex().id("tab-" + tab.id).h(24).px(8).gap(6).items_center().rounded(6).max_w(200).flex_shrink(1)
        .bg(active ? t.selected : t.chrome).text_color(active ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).cursor_pointer()
        .on_click(() => { if (!active) this.cmd({ t: "switch", id: tab.id }); })
        .child(div().text_size(11).child(busy ? "🤖" : "◦"))
        .child(div().flex_1().truncate().text_size(11.5).child(short(tab.title || host(tab.url), 28)))
        .child(div().id("x-" + tab.id).px(3).rounded(4).text_size(11).text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
          .on_click((e, cx) => { cx.stop_propagation(); this.cmd({ t: "closetab", id: tab.id }); }).child("×"));
    };
    return h_flex().h(30).px(6).gap(3).items_center().bg(t.chrome).overflow_hidden()
      .children(this.tabs.map(pill))
      .child(div().id("newtab").w(24).h(24).flex().items_center().justify_center().rounded(6).text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer().on_click(() => this.cmd({ t: "newtab" })).child("+"));
  }
  badge(t) {
    const who = this.driverName(); if (!who) return null;
    return h_flex().h(22).px(8).gap(5).items_center().rounded(11).bg(t.accent).text_color(t.accent_foreground).text_size(11)
      .child(div().loop("opacity", { from: 0.35, to: 1, period: 900 }).child("●")).child(`${who} is driving`);
  }
  selectMenu(t) {
    const s = this.select; if (!s) return null;
    const w = Math.max(160, s.rect.w), below = this.size.height - (s.rect.y + s.rect.h);
    const groups = new Set(s.options.map((o) => o.group).filter(Boolean)).size;
    const h = Math.min(320, s.options.length * 26 + groups * 22 + 10), y = below >= h || below > s.rect.y ? s.rect.y + s.rect.h + 2 : Math.max(0, s.rect.y - h - 2);
    let group = null; const rows = [];
    s.options.forEach((o, i) => {
      if (o.group && o.group !== group) { group = o.group; rows.push(div().h(22).px(8).flex().items_end().text_size(10.5).text_color(t.dim).child(o.group)); }
      rows.push(div().id("opt-" + i).h(26).px(10).flex().items_center().rounded(5).text_size(12.5).truncate()
        .bg(i === s.hi ? t.selected : t.popover).text_color(o.disabled ? t.dim : t.foreground)
        .when(!o.disabled, (el) => el.cursor_pointer().hover((x) => x.bg(t.hover)))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pick(i); cx.notify(); })
        .child((i === s.selected ? "✓ " : "   ") + o.label));
    });
    // The position sits on a plain outer box and the scrolling list inside it: a scrollbar wrapper drops absolute positioning.
    return div().id("select-menu").absolute().left(Math.min(s.rect.x, Math.max(0, this.size.width - w))).top(y).w(w).h(h)
      .rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_lg()
      .on_mouse_down_out((e, cx) => { this.select = null; cx.notify(); })
      .child(v_flex().id("select-scroll").size_full().p(4).overflow_y_scrollbar().children(rows));
  }

  render(cx) {
    const t = theme();
    if (!this.paneId && this.title) this.renameTab();
    const icon = (id, glyph, fn) => div().id(id).w(26).h(26).flex().items_center().justify_center().rounded(6).text_size(15)
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer().on_click(fn).child(glyph);
    const secure = this.url.startsWith("https://");
    const badge = this.badge(t);
    const menu = this.selectMenu(t);
    const dialog = this.dialogBox(t);
    const bar = h_flex().h(40).px(8).gap(4).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(icon("back", "←", () => this.cmd({ t: "back" })))
      .child(icon("fwd", "→", () => this.cmd({ t: "forward" })))
      .child(this.loading
        ? div().w(26).h(26).flex().items_center().justify_center().text_color(t.accent).text_size(14).child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 80))
        : icon("reload", "↻", () => this.cmd({ t: "reload" })))
      .child(h_flex().flex_1().h(28).px(10).gap(6).items_center().rounded(14).bg(t.surface).border_1().border_color(badge ? t.accent : t.border)
        .child(div().text_size(11).text_color(secure ? t.done : t.dim).child(secure ? "🔒" : "ⓘ"))
        .child(Input.new(this.addr).flex_1().text_size(12.5).text_color(t.foreground)))
      .when(Boolean(badge), (el) => el.child(badge))
      .child(div().px(6).text_size(10.5).text_color(t.dim).child(this.status === "live" ? `${this.fps} fps` : short(this.status, 60)));
    // Bottom: the incoming frame (loading, covered). Above it: frames GPUI already drew, newest on top.
    const layer = (f) => image(f.file).absolute().top(0).left(0).w(f.w).h(f.h);
    const layers = [...(this.incoming ? [layer(this.incoming)] : []), ...this.frames.map(layer)];
    const view = div().id("view").relative().flex_1().w_full().overflow_hidden().bg(this.frames.length ? "#ffffff" : t.background)
      .when(this.cursor === "pointer", (el) => el.cursor_pointer())
      .when(this.cursor === "text", (el) => el.cursor_text())
      .on_size_change((size) => { this.size = size; this.cmd({ t: "resize", w: size.width, h: size.height }); })
      .track_focus(this.focus)
      .key_context("WebTab")
      .when(true, (el) => CLAIMED.reduce((el, k) => el.on_action("webtab::" + k, (_e, cx) => this.claimed(k, cx)), el))
      .on_mouse_down("left", (e) => { if (this.dialog) return; this.focus.focus(); if (!this.select) this.mouse("mousePressed", e, "left"); })
      .on_mouse_down("right", (e) => { this.focus.focus(); this.mouse("mousePressed", e, "right"); })
      // While a button is held, follow the pointer and catch its release anywhere in the window.
      .on_window_mouse_up("left", (e) => { if (this.buttons & 1) this.mouse("mouseReleased", e, "left"); })
      .on_window_mouse_up("right", (e) => { if (this.buttons & 2) this.mouse("mouseReleased", e, "right"); })
      .on_window_mouse_move((e) => { if (this.buttons) this.mouse("mouseMoved", e); })
      .on_mouse_move((e) => { if (!this.buttons && !this.select) this.mouse("mouseMoved", e); })
      .on_scroll_wheel((e) => { const p = e.local_position; if (p && !this.select) this.cmd({ t: "wheel", x: p.x, y: p.y, dx: -e.delta.x, dy: -e.delta.y, modifiers: this.mods(e.modifiers) }); })
      .on_key_down((e, cx) => { this.key(e, cx); cx.stop_propagation(); })
      .children(layers.length ? layers : [div().size_full().flex().items_center().justify_center().text_color(t.muted).child(this.status)])
      .when(Boolean(menu), (el) => el.child(menu))
      .when(Boolean(dialog), (el) => el.child(dialog));
    return v_flex().id("root").size_full().bg(t.background).child(this.tabStrip(t)).child(bar).child(view);
  }

  async close() {
    try { this.sock?.close(); } catch {}
    const n = (LIVE_KEYS.get(this.key) || 1) - 1;
    if (n > 0) LIVE_KEYS.set(this.key, n); else LIVE_KEYS.delete(this.key);
    if (this.paneId) CLAIMED_PANES.delete(this.paneId);
  }
}
