#!/usr/bin/env node
// herdr-webtab uninstaller: undoes install.mjs. Keeps the browser profile and config in
// <appHome>/data/webtab unless you pass --purge.
//
//   node uninstall.mjs [--purge] [--keep-browser] [--app-home <dir>]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const C = await import(new URL("./mods/webtab/node/common.mjs", import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const say = (s) => console.log("  " + s);
const HOME = C.appHome(val("--app-home"));
const USER_HOME = os.homedir();
const NO_CLI = process.env.WEBTAB_NO_AGENT_CLI === "1";
const quiet = (f) => { try { return f(); } catch { return undefined; } };
const run = (cmd, args) => (C.IS_WIN && /\.(cmd|bat)$/i.test(cmd)
  ? execFileSync([cmd, ...args].map((x) => `"${x}"`).join(" "), { stdio: "ignore", shell: true, windowsHide: true })
  : execFileSync(cmd, args, { stdio: "ignore", windowsHide: true }));
const cli = (name) => (NO_CLI ? null : C.which(name));
console.log(`herdr-webtab: uninstalling from ${C.fwd(HOME)}`);

// engine first (it holds files in data/webtab), and the browser it owns unless asked not to
const { cfg, paths: P } = C.loadConfig(HOME);
const r = await C.stopEngine(HOME, { closeBrowser: !has("--keep-browser") });
say(r.stopped ? "engine stopped" : "engine wasn't running");

// tab bars back to Herdr's own + menu (exact original height, from the marker install.mjs left)
const mods = path.join(HOME, "mods");
if (fs.existsSync(mods)) {
  const PATCHED = /openOverlay\(\{ mod: "new-menu-web", kind: "popup", width: (\d+), height: \d+ \/\* webtab: was (\d+) \*\/ \}\)/g;
  for (const m of fs.readdirSync(mods)) {
    const f = path.join(mods, m, "main.js");
    if (!fs.existsSync(f) || m === "new-menu-web") continue;
    const src = fs.readFileSync(f, "utf8");
    if (!src.includes('"new-menu-web"')) continue;
    const back = src.replace(PATCHED, 'openOverlay({ mod: "new-menu", kind: "popup", width: $1, height: $2 })')
      .replace(/openOverlay\(\{ mod: "new-menu-web", kind: "popup", width: (\d+), height: (\d+) \}\)/g, 'openOverlay({ mod: "new-menu", kind: "popup", width: $1, height: 512 })');
    fs.writeFileSync(f, back);
    fs.rmSync(f + ".before-webtab", { force: true });
    say(`+ menu restored: ${m}`);
  }
  for (const m of ["webtab", "webtab-new", "new-menu-web"]) {
    const d = path.join(mods, m);
    if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true, force: true }); say(`removed mod ${m}`); }
  }
}

// key binding
const kf = path.join(HOME, "keys.json");
const keys = C.readJson(kf, null);
if (keys) {
  let changed = false;
  for (const sec of Object.values(keys)) {
    if (!sec || typeof sec !== "object") continue;
    for (const [k, v] of Object.entries(sec)) if (JSON.stringify(v).includes("webtab-new")) { delete sec[k]; changed = true; }
  }
  if (changed) { fs.writeFileSync(kf, JSON.stringify(keys, null, 2) + "\n"); say("key binding removed"); }
}
fs.rmSync(kf + ".before-webtab", { force: true });

// agent note
const notes = path.join(HOME, "AGENTS.local.md");
if (fs.existsSync(notes)) {
  const t = fs.readFileSync(notes, "utf8");
  const u = t.replace(/\n*<!-- herdr-webtab:start[\s\S]*?<!-- herdr-webtab:end -->\n?/g, "\n");
  if (u !== t) {
    if (u.trim() === "# Notes on this machine's Herdr setup" || !u.trim()) fs.rmSync(notes);
    else fs.writeFileSync(notes, u.trimEnd() + "\n");
    say("agent note removed from AGENTS.local.md");
  }
}

// MCP registrations
const claude = cli("claude");
if (claude && quiet(() => run(claude, ["mcp", "remove", "--scope", "user", "webtab"])) !== undefined) say("Claude Code: webtab MCP server removed");
const codex = cli("codex");
if (codex && quiet(() => run(codex, ["mcp", "remove", "webtab"])) !== undefined) say("Codex: webtab MCP server removed");
const codexToml = path.join(USER_HOME, ".codex", "config.toml");
if (fs.existsSync(codexToml)) {
  const t = fs.readFileSync(codexToml, "utf8");
  const u = t.replace(/\n*# herdr-webtab:start[\s\S]*?# herdr-webtab:end\n?/g, "\n");
  if (u !== t) { fs.writeFileSync(codexToml, u.trimEnd() + "\n"); say("Codex: webtab block removed from config.toml"); }
}
fs.rmSync(codexToml + ".before-webtab", { force: true });
const piMcp = path.join(USER_HOME, ".pi", "agent", "mcp.json");
const pj = C.readJson(piMcp, null);
if (pj?.mcpServers?.webtab) { delete pj.mcpServers.webtab; fs.writeFileSync(piMcp, JSON.stringify(pj, null, 2) + "\n"); say("pi: webtab MCP server removed"); }
fs.rmSync(piMcp + ".before-webtab", { force: true });

// login item
const auto = C.autostartFile();
if (fs.existsSync(auto)) { fs.rmSync(auto); say(`autostart removed (${C.fwd(auto)})`); }

if (has("--purge")) {
  fs.rmSync(P.dir, { recursive: true, force: true });
  say(`deleted ${C.fwd(P.dir)} (browser profile, config, pinned MCP server)`);
} else say(`kept ${C.fwd(P.dir)} (browser profile and config; --purge deletes it${cfg.profile.startsWith(P.dir) ? "" : `; your profile at ${C.fwd(cfg.profile)} is never deleted`})`);
console.log("done.");
