// Agent turn for the webtab test: find the box, click it like a user would, type slowly so a human can watch.
const CDP = "http://127.0.0.1:9333";
const page = (await (await fetch(`${CDP}/json/list`)).json()).find((t) => t.url.includes("test.html"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalv = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;

await evalv(`document.getElementById("agentcard").scrollIntoView({behavior:"smooth",block:"center"})`); await sleep(700);
const r = JSON.parse(await evalv(`JSON.stringify(document.getElementById("agentbox").getBoundingClientRect())`));
const x = r.x + 40, y = r.y + r.height / 2;
for (let i = 0; i <= 12; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 200 + i * 16.6, y: y - 60 + i * 5 }); await sleep(30); }
await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
const msg = "Hi Joe, it's the agent driving your Herdr tab 👋";
for (const ch of msg) { await send("Input.insertText", { text: ch }); await sleep(70); }
await sleep(300);
console.log("results:", await evalv(`Object.keys(window.__results).join(", ")`));
console.log("agentbox:", await evalv(`document.getElementById("agentbox").value`));
ws.close();
