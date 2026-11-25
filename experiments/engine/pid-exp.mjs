import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
import { findChrome } from "../../mods/webtab/node/common.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9700 + Math.floor(Math.random() * 200), prof = fs.mkdtempSync(path.join(os.tmpdir(), "vis-pid-"));
const ch = spawn(process.env.EXE || findChrome({}), ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const B = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (B.onopen = r));
B.onmessage = (e) => { const m = JSON.parse(e.data); console.log("spawned pid", ch.pid, "->", JSON.stringify(m.result?.processInfo?.filter((p) => p.type === "browser") ?? m.error)); ch.kill(); process.exit(0); };
B.send(JSON.stringify({ id: 1, method: "SystemInfo.getProcessInfo" }));
