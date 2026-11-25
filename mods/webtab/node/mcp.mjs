#!/usr/bin/env node
// The `webtab` MCP server agents run: starts the web tab engine (and its browser) if needed, then
// hands stdio to chrome-devtools-mcp attached to that browser. Extra arguments pass through.
//
//   node <appHome>/mods/webtab/node/mcp.mjs [chrome-devtools-mcp args…]
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { appHome, loadConfig, ensureEngine, MCP_PACKAGE, MCP_VERSION, IS_WIN } from "./common.mjs";

const passthrough = process.argv.slice(2);
const home = appHome();
const { cfg, paths: P } = loadConfig(home);
const err = (s) => process.stderr.write(`[webtab-mcp] ${s}\n`);

// Start the engine alongside the MCP server, not before it: agents give MCP servers only a few
// seconds to answer, and chrome-devtools-mcp reaches for the browser on its first tool call.
ensureEngine(home).then((r) => { if (!r.ok) err(r.error); }, (e) => err(String(e)));

// The pinned copy the installer put in <appHome>/data/webtab/mcp; else npx (needs network the first time).
function vendoredBin() {
  try {
    const dir = path.join(P.mcp, "node_modules", MCP_PACKAGE);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[MCP_PACKAGE];
    const f = bin && path.join(dir, bin);
    return f && fs.existsSync(f) ? f : null;
  } catch { return null; }
}
const mcpArgs = ["--browserUrl", `http://127.0.0.1:${cfg.cdpPort}`, "--no-usage-statistics", ...passthrough];
const bin = vendoredBin();
const child = bin
  ? spawn(process.execPath, [bin, ...mcpArgs], { stdio: "inherit", windowsHide: true })
  : spawn(IS_WIN ? "npx.cmd" : "npx", ["-y", `${MCP_PACKAGE}@${MCP_VERSION}`, ...mcpArgs], { stdio: "inherit", windowsHide: true, shell: IS_WIN });
if (!bin) err(`no vendored ${MCP_PACKAGE} in ${P.mcp}; using npx (run install.mjs to pin a local copy)`);
// The engine starter keeps a timer alive; leave when the MCP server does.
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
