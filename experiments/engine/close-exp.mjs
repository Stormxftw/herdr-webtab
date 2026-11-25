// how long does Chrome take to exit after Browser.close, by itself?
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
import { findChrome } from "../../mods/webtab/node/common.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const variant of ["plain", "with windows"]) {
  const PORT = 9700 + Math.floor(Math.random() * 200), prof = fs.mkdtempSync(path.join(os.tmpdir(), "vis-close-"));
  const ch = spawn(process.env.EXE || findChrome({}), ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  let exitedAt = 0; ch.on("exit", () => { exitedAt = Date.now(); });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const B = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (B.onopen = r));
  let n = 0; const send = (method, params = {}) => B.send(JSON.stringify({ id: ++n, method, params }));
  if (variant === "with windows") { send("Target.createTarget", { url: "https://example.com", newWindow: true }); send("Target.createTarget", { url: "about:blank", newWindow: true }); }
  else await fetch(`http://127.0.0.1:${PORT}/json/new?https://example.com`, { method: "PUT" });
  await sleep(2500);
  const t0 = Date.now(); send("Browser.close");
  let portGone = 0;
  while (!exitedAt && Date.now() - t0 < 30000) { if (!portGone) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(300) }); } catch { portGone = Date.now(); } } await sleep(100); }
  console.log(`${variant}: DevTools port closed after ${((portGone - t0) / 1000).toFixed(1)} s, process exited after ${exitedAt ? ((exitedAt - t0) / 1000).toFixed(1) + " s" : "> 30 s"}`);
  try { ch.kill(); } catch {}
}
process.exit(0);
