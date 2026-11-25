// The agent path end to end: an MCP client starts mcp.mjs with no engine running; the launcher must
// start the engine and its browser on demand, and chrome-devtools-mcp must drive that browser.
// Needs Chrome, and network the first time (npx fetches chrome-devtools-mcp when no pinned copy exists).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { findChrome, loadConfig, stopEngine } from "../mods/webtab/node/common.mjs";

const CHROME = findChrome({});
const skip = CHROME ? (process.env.WEBTAB_SKIP_MCP_TEST ? "WEBTAB_SKIP_MCP_TEST is set" : false) : "no Chrome or Chromium installed";
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
let HOME, child;

after(async () => {
  if (!HOME) return;
  try { child?.kill(); } catch {}
  await stopEngine(HOME, { closeBrowser: true }).catch(() => {});
  for (let i = 0; i < 10; i++) { try { fs.rmSync(HOME, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
});

test("an agent's MCP server starts the engine on demand and drives the shared browser", { skip, timeout: 180000 }, async () => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), "webtab-mcp-"));
  fs.mkdirSync(path.join(HOME, "data", "webtab"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "data", "webtab", "config.json"), JSON.stringify({
    port: await freePort(), httpPort: await freePort(), cdpPort: await freePort(), dpr: 1, home: "about:blank", chrome: CHROME,
    chromeArgs: process.env.CI && process.platform === "linux" ? ["--no-sandbox"] : [] }));
  const cfg = loadConfig(HOME).cfg;
  // Reuse a pinned copy if this machine has one (keeps the test offline); else npx fetches it.
  const pinned = process.env.WEBTAB_MCP_DIR;
  if (pinned && fs.existsSync(pinned)) fs.cpSync(pinned, path.join(HOME, "data", "webtab", "mcp"), { recursive: true });

  child = spawn(process.execPath, [path.resolve("mods/webtab/node/mcp.mjs")], { env: { ...process.env, HERDR_APP_HOME: HOME }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", stderr = "";
  const waiting = new Map();
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    const t = setTimeout(() => { waiting.delete(i); reject(new Error(`no reply to ${method}; stderr:\n${stderr}`)); }, 120000);
    waiting.set(i, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  });

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "webtab-test", version: "1" } });
  assert.ok(init.result?.serverInfo, "MCP server answered initialize");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await rpc("tools/list", {});
  assert.ok(tools.result.tools.some((t) => t.name === "list_pages"));

  const pages = await rpc("tools/call", { name: "new_page", arguments: { url: "data:text/html,<title>from the agent</title><h1>hi</h1>" } });
  assert.ok(!pages.result?.isError, JSON.stringify(pages.result || pages.error).slice(0, 500));
  // The engine came up on demand and sees the agent's tab.
  let status;
  for (let i = 0; i < 40; i++) {
    status = await (await fetch(`http://127.0.0.1:${cfg.httpPort}/status`)).json();
    if (status.tabs.some((t) => t.title === "from the agent")) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(status.engine, "webtabd");
  assert.ok(status.tabs.some((t) => t.title === "from the agent"), JSON.stringify(status.tabs));
  child.stdin.end();
});
