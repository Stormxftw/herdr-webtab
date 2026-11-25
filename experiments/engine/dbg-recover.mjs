// how long does recovery take after the browser dies, in a quiet engine?
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import net from "node:net";
import { spawn } from "node:child_process";
import { findChrome, ENGINE, loadConfig, stopEngine, closeChrome } from "../../mods/webtab/node/common.mjs";
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "webtab-rec-"));
fs.mkdirSync(path.join(HOME, "data", "webtab"), { recursive: true });
fs.writeFileSync(path.join(HOME, "data", "webtab", "config.json"), JSON.stringify({ port: await freePort(), httpPort: await freePort(), cdpPort: await freePort(), dpr: 1, home: "about:blank", chrome: findChrome({}) }));
const cfg = loadConfig(HOME).cfg;
const eng = spawn(process.execPath, [ENGINE, "--app-home", HOME], { stdio: "ignore", env: { ...process.env, WEBTAB_DEBUG: "1" } });
for (let i = 0; i < 100; i++) { try { if ((await (await fetch(`http://127.0.0.1:${cfg.httpPort}/status`)).json()).ready) break; } catch {} await sleep(200); }
const token = fs.readFileSync(path.join(HOME, "data", "webtab", "token"), "utf8").trim();
const sock = net.connect(cfg.port, "127.0.0.1"); await new Promise((r) => sock.on("connect", r));
let buf = "", attachedAt = [];
sock.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.t === "attached") attachedAt.push(Date.now()); } });
sock.write(JSON.stringify({ t: "hello", token }) + "\n" + JSON.stringify({ t: "resize", w: 640, h: 400 }) + "\n" + JSON.stringify({ t: "attach", url: "https://example.com" }) + "\n");
await sleep(3000);
for (let round = 1; round <= 3; round++) {
  const t0 = Date.now(), n = attachedAt.length;
  await closeChrome(cfg);
  while (attachedAt.length === n && Date.now() - t0 < 60000) await sleep(100);
  console.log(`round ${round}: back after ${((attachedAt[attachedAt.length - 1] - t0) / 1000).toFixed(1)} s`);
  await sleep(2000);
}
console.log(fs.readFileSync(path.join(HOME, "data", "webtab", "webtabd.log"), "utf8").split("\n").filter((l) => /lost|exit|launching|reconnected|won't/.test(l)).map((l) => l.slice(11)).join("\n"));
sock.destroy(); await stopEngine(HOME); eng.kill(); process.exit(0);
