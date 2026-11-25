// Experiment B: a CDP browser rendered with the Kitty graphics protocol inside a terminal pane.
// Shares the same headless Chromium (port 9333) as the webtab mod and the agents.
// usage: node kittyweb.mjs [targetId]
const CDP = "http://127.0.0.1:9333";
const out = (s) => process.stdout.write(s);
const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.id === process.argv[2]) || list.find((t) => t.type === "page" && /^https?:/.test(t.url)) || list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => (ws.onopen = r));

let cols = process.stdout.columns || 100, rows = process.stdout.rows || 30;
let cellW = 9, cellH = 18; // refined by the CSI 16 t reply if the terminal answers
let url = page.url, frames = 0, t0 = Date.now(), fps = 0, lastLen = 0;
const viewport = () => ({ w: cols * cellW, h: (rows - 1) * cellH });

out("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[?1003h\x1b[?1006h\x1b[16t");
process.stdin.setRawMode?.(true); process.stdin.resume();

async function applySize() {
  const { w, h } = viewport();
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send("Page.stopScreencast");
  await send("Page.startScreencast", { format: "png", maxWidth: w, maxHeight: h });
}

function drawFrame(b64) {
  // a=T transmit+display, f=100 PNG, i=1 reuse id (replaces previous image), c/r = size in cells, q=2 quiet
  let s = "\x1b[2;1H";
  for (let i = 0; i < b64.length; i += 4096) {
    const chunk = b64.slice(i, i + 4096), more = i + 4096 < b64.length ? 1 : 0;
    s += i === 0 ? `\x1b_Ga=T,f=100,i=1,p=1,q=2,C=1,c=${cols},r=${rows - 1},m=${more};${chunk}\x1b\\` : `\x1b_Gm=${more};${chunk}\x1b\\`;
  }
  out(s);
}

function header() {
  const info = ` ${fps} fps · ${(lastLen / 1024) | 0}KB · ${cols}x${rows} cells @${cellW}x${cellH}px `;
  const u = (" ⟨webtab/kitty⟩ " + url).slice(0, Math.max(10, cols - info.length));
  out(`\x1b[1;1H\x1b[7m${u.padEnd(cols - info.length)}${info}\x1b[0m`);
}

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === "Page.screencastFrame") {
    ws.send(JSON.stringify({ id: ++id, method: "Page.screencastFrameAck", params: { sessionId: m.params.sessionId } }));
    lastLen = m.params.data.length * 0.75; frames++;
    const dt = Date.now() - t0; if (dt > 2000) { fps = (frames * 1000 / dt).toFixed(1); frames = 0; t0 = Date.now(); }
    drawFrame(m.params.data); header();
  } else if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) { url = m.params.frame.url; header(); }
};

let down = false;
process.stdin.on("data", (d) => {
  const s = d.toString("latin1");
  const cell = /\x1b\[6;(\d+);(\d+)t/.exec(s); // CSI 16 t reply: cell size in pixels
  if (cell) { cellH = +cell[1]; cellW = +cell[2]; applySize(); return; }
  for (const mm of s.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([mM])/g)) {
    const [b, cx, cy, kind] = [+mm[1], +mm[2], +mm[3], mm[4]];
    const x = (cx - 0.5) * cellW, y = (cy - 1.5) * cellH; if (y < 0) continue;
    if (b === 64 || b === 65) { send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: b === 64 ? -120 : 120 }); continue; }
    if (b & 32) { send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: down ? "left" : "none" }); continue; }
    if ((b & 3) === 0) { down = kind === "M"; send("Input.dispatchMouseEvent", { type: down ? "mousePressed" : "mouseReleased", x, y, button: "left", clickCount: 1 }); }
  }
  if (s.startsWith("\x1b[<") || cell) return;
  if (s === "\x11") { cleanup(); } // ctrl+q quits
  else if (s === "\r") send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  else if (s === "\x7f" || s === "\b") { send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", windowsVirtualKeyCode: 8 }); send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", windowsVirtualKeyCode: 8 }); }
  else if (!s.startsWith("\x1b")) send("Input.insertText", { text: s });
});

process.stdout.on("resize", () => { cols = process.stdout.columns; rows = process.stdout.rows; out("\x1b[2J"); applySize(); });
function cleanup() { out("\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b[?1049l"); process.exit(0); }
process.on("SIGINT", cleanup);
await send("Page.enable");
setTimeout(applySize, 300); // give the terminal a moment to answer CSI 16 t
