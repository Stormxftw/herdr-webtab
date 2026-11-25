// Stand-in "agent": a separate CDP client driving the same page the webtab shows.
// usage: node agent.mjs <cmd> [arg]   cmds: list | goto <url> | eval <js> | click <x> <y> | type <text> | shot <file>
const [, , cmd, ...args] = process.argv;
const CDP = "http://127.0.0.1:9333";
const list = await (await fetch(`${CDP}/json/list`)).json();
const pages = list.filter((t) => t.type === "page");
if (cmd === "list") { for (const p of pages) console.log(p.id, p.url, "|", p.title); process.exit(0); }
const page = pages.find((p) => p.id === process.env.TARGET) || pages.find((p) => /^https?:/.test(p.url)) || pages[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const t0 = Date.now();
if (cmd === "goto") console.log(JSON.stringify((await send("Page.navigate", { url: args[0] })).result));
if (cmd === "eval") console.log(JSON.stringify((await send("Runtime.evaluate", { expression: args.join(" "), returnByValue: true })).result?.result?.value));
if (cmd === "click") { const [x, y] = args.map(Number); for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); console.log("clicked", x, y); }
if (cmd === "type") { console.log(JSON.stringify(await send("Input.insertText", { text: args.join(" ") }))); }
if (cmd === "shot") { const r = await send("Page.captureScreenshot", { format: "png" }); (await import("node:fs")).writeFileSync(args[0], Buffer.from(r.result.data, "base64")); console.log("saved", args[0]); }
console.log(`[agent] ${cmd} on ${page.id} (${page.url}) in ${Date.now() - t0}ms`);
ws.close();
