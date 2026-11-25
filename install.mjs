#!/usr/bin/env node
// herdr-webtab installer. One command, safe to re-run (it updates in place).
//
//   node install.mjs                 mods, agent note, MCP server for Claude Code / Codex / pi, start the engine
//   node install.mjs --menu          also add a "Web tab" row to the + menu of your own tab bars
//   node install.mjs --key [chord]   also bind a key to "New web tab" (default ctrl-shift-y, cmd-shift-y on macOS)
//   node install.mjs --autostart     also start the engine at login (it otherwise starts on demand)
//   node install.mjs --no-agents     skip the MCP server and the AGENTS.local.md note
//   node install.mjs --no-guard      skip Guard (the agent hook for Claude Code / Codex and the terminal watcher)
//   node install.mjs --chrome <path> --profile <dir>   choose the browser binary / profile folder
//   node install.mjs --install-chromium   download Playwright's Chromium if no browser is found
//
// Undo everything with: node uninstall.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const C = await import(new URL("./mods/webtab/node/common.mjs", import.meta.url));
const G = await import(new URL("./mods/webtab/node/guard.mjs", import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); const v = i >= 0 ? argv[i + 1] : undefined; return v && !v.startsWith("--") ? v : undefined; };
const say = (s) => console.log("  " + s);
const warn = (s) => console.log("  ! " + s);
const GUARD = !has("--no-guard");
const GUARD_NOTE = `- **Guard** checks every shell command you run here before it runs. It blocks a few that can't be
  undone (wiping a disk or home folder, force-pushing main, deleting a repo, sending keys or secrets
  away) and asks the person first about others (publishing, force-pushing, reading secrets, running
  scripts from the internet). When Guard blocks a command, don't try another way around it: tell the
  person what you wanted to run and why. Rules: \`{{rules}}\`.`;

const [major] = process.versions.node.split(".").map(Number);
if (major < 22) { console.error(`herdr-webtab needs Node 22 or newer (this is ${process.version}).`); process.exit(1); }

const HOME = C.appHome(val("--app-home"));
if (!fs.existsSync(path.join(HOME, "mods"))) {
  console.error(`Herdr's app folder wasn't found at ${HOME}. Start Herdr once, or pass --app-home <dir> (or set HERDR_APP_HOME).`);
  process.exit(1);
}
const USER_HOME = os.homedir();
const NO_CLI = process.env.WEBTAB_NO_AGENT_CLI === "1"; // tests: never touch the real agent CLIs
console.log(`herdr-webtab ${C.VERSION}: installing into ${C.fwd(HOME)}`);

// ---------- 1. config ----------
const patch = { node: C.fwd(process.execPath) };
if (val("--chrome")) patch.chrome = C.fwd(path.resolve(val("--chrome")));
if (val("--profile")) patch.profile = C.fwd(path.resolve(val("--profile")));
C.saveConfig(HOME, patch);
const { cfg, paths: P } = C.loadConfig(HOME);
let chrome = C.findChrome(cfg);
if (!chrome && has("--install-chromium")) {
  say("no browser found: downloading Playwright's Chromium (one time)…");
  run(npxBin(), ["-y", "playwright", "install", "chromium"], { stdio: "inherit" });
  chrome = C.findChrome(cfg);
}
if (!chrome) {
  console.error("\nNo Chrome, Chromium, Brave or Edge was found. Install Chrome, or run again with --install-chromium,\n" +
    "or point at a browser with --chrome <path>.");
  process.exit(2);
}
say(`config: ${C.fwd(P.config)}`);
say(`browser: ${C.fwd(chrome)}${/msedge|Microsoft Edge/i.test(chrome) ? " (Edge may sign in to your OS account on its own; --chrome picks another)" : ""}`);

// ---------- 2. mods ----------
// mod.json goes first: a folder Herdr sees without "place": "none" gets docked into the shown layout.
function syncMod(name, keep = []) {
  const src = path.join(REPO, "mods", name), dst = path.join(HOME, "mods", name);
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(src, "mod.json"), path.join(dst, "mod.json"));
  const want = new Set();
  const copy = (s, d, rel = "") => {
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const r = path.join(rel, e.name); want.add(r);
      if (e.isDirectory()) { fs.mkdirSync(path.join(d, e.name), { recursive: true }); copy(path.join(s, e.name), path.join(d, e.name), r); }
      else if (e.name !== "mod.json") fs.copyFileSync(path.join(s, e.name), path.join(d, e.name));
    }
  };
  copy(src, dst);
  // Remove files an older version left behind.
  const prune = (d, rel = "") => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (want.has(r) || keep.includes(r) || e.name.startsWith(".")) { if (e.isDirectory() && want.has(r)) prune(path.join(d, e.name), r); continue; }
      fs.rmSync(path.join(d, e.name), { recursive: true, force: true });
    }
  };
  prune(dst);
}
syncMod("webtab");
syncMod("webtab-new");
syncMod("webtab-guard");
const baseMenu = path.join(HOME, "mods", "new-menu", "main.js");
if (fs.existsSync(baseMenu)) {
  syncMod("new-menu-web", ["base.js"]);
  fs.copyFileSync(baseMenu, path.join(HOME, "mods", "new-menu-web", "base.js"));
}
say(`mods: webtab, webtab-new, webtab-guard${fs.existsSync(baseMenu) ? ", new-menu-web" : ""}  (command palette: "New web tab")`);

// ---------- 3. optional: + menu row in the person's own tab bars ----------
const MARK = "/* webtab: was ";
if (has("--menu")) {
  if (!fs.existsSync(baseMenu)) warn("+ menu: Herdr's new-menu mod wasn't found; skipped");
  else {
    let shipped = new Set();
    try { shipped = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(HOME, "installed.json"), "utf8")))); } catch {}
    const OLD = /openOverlay\(\{\s*mod:\s*"new-menu",\s*kind:\s*"popup",\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}\)/g;
    const patched = [], already = [];
    for (const m of fs.readdirSync(path.join(HOME, "mods"))) {
      const f = path.join(HOME, "mods", m, "main.js");
      if (shipped.has(m) || ["new-menu", "new-menu-web"].includes(m) || !fs.existsSync(f)) continue;
      const src = fs.readFileSync(f, "utf8");
      if (src.includes(MARK)) { already.push(m); continue; }
      if (!src.match(OLD)) continue;
      if (!fs.existsSync(f + ".before-webtab")) fs.copyFileSync(f, f + ".before-webtab");
      fs.writeFileSync(f, src.replace(OLD, (_, w, h) => `openOverlay({ mod: "new-menu-web", kind: "popup", width: ${w}, height: ${Math.max(+h, 560)} ${MARK}${h} */ })`));
      patched.push(m);
    }
    const all = [...patched, ...already];
    say(all.length ? `+ menu: ${all.join(", ")}${patched.length ? " (backups: main.js.before-webtab)" : " (already set up)"}`
      : "+ menu: no tab bars of your own open the + menu; Herdr's shipped tab bar stays as shipped, so use the command palette");
  }
}

// ---------- 4. optional: a key for "New web tab" ----------
if (has("--key")) {
  const chord = val("--key") || (C.IS_MAC ? "cmd-shift-y" : "ctrl-shift-y");
  const kf = path.join(HOME, "keys.json");
  const keys = C.readJson(kf, null);
  if (!keys) warn(`keys: ${C.fwd(kf)} isn't readable JSON; skipped`);
  else {
    const taken = Object.entries(keys).find(([, sec]) => sec && typeof sec === "object" && chord in sec);
    if (taken && JSON.stringify(taken[1][chord]).includes("webtab-new")) say(`keys: ${chord} already opens a web tab`);
    else if (taken) warn(`keys: ${chord} is already bound in "${taken[0]}"; pick another with --key <chord>`);
    else {
      if (!fs.existsSync(kf + ".before-webtab")) fs.copyFileSync(kf, kf + ".before-webtab");
      keys.global = { ...(keys.global || {}), [chord]: { command: "mod.open", args: { name: "webtab-new" } } };
      fs.writeFileSync(kf, JSON.stringify(keys, null, 2) + "\n");
      say(`keys: ${chord} opens a web tab (Herdr now treats keys.json as edited by you; new default keys must be added by hand)`);
    }
  }
}

// ---------- 5. agents: chrome-devtools-mcp as "webtab", and a note in AGENTS.local.md ----------
const MCP_LAUNCHER = C.fwd(path.join(HOME, "mods", "webtab", "node", "mcp.mjs"));
const registered = [];
function run(cmd, args, opt = {}) {
  // .cmd shims (npm, npx, claude) need a shell on Windows; quote every argument for it.
  if (C.IS_WIN && /\.(cmd|bat)$/i.test(cmd)) {
    const line = [cmd, ...args].map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(" ");
    return execFileSync(line, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true, windowsHide: true, ...opt });
  }
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...opt });
}
function npxBin() { const f = path.join(path.dirname(process.execPath), C.IS_WIN ? "npx.cmd" : "npx"); return fs.existsSync(f) ? f : (C.IS_WIN ? "npx.cmd" : "npx"); }
function npmBin() { const f = path.join(path.dirname(process.execPath), C.IS_WIN ? "npm.cmd" : "npm"); return fs.existsSync(f) ? f : (C.IS_WIN ? "npm.cmd" : "npm"); }
const cli = (name) => (NO_CLI ? null : C.which(name));
const firstLine = (e) => String(e.stderr || e.stdout || e.message).trim().split("\n")[0];

if (!has("--no-agents")) {
  // A pinned local copy, so every agent starts the same version without a download.
  const mcpPkg = path.join(P.mcp, "node_modules", C.MCP_PACKAGE, "package.json");
  if (C.readJson(mcpPkg, {}).version !== C.MCP_VERSION && !has("--skip-mcp-download")) {
    say(`downloading ${C.MCP_PACKAGE}@${C.MCP_VERSION}…`);
    fs.mkdirSync(P.mcp, { recursive: true });
    try { run(npmBin(), ["install", "--prefix", P.mcp, "--no-audit", "--no-fund", "--loglevel", "error", `${C.MCP_PACKAGE}@${C.MCP_VERSION}`]); }
    catch (e) { warn(`couldn't download it (${firstLine(e)}); agents will use npx instead`); }
  }
  const launch = [C.fwd(process.execPath), MCP_LAUNCHER];

  // Claude Code (user scope: every project)
  const claude = cli("claude");
  if (claude) {
    try { run(claude, ["mcp", "remove", "--scope", "user", "webtab"]); } catch {}
    try { run(claude, ["mcp", "add", "--scope", "user", "webtab", "--", ...launch]); registered.push("Claude Code"); }
    catch (e) { warn(`Claude Code: ${firstLine(e)}`); }
  }

  // Codex: its CLI when present, else a marked block in ~/.codex/config.toml
  const codexDir = path.join(USER_HOME, ".codex"), codexToml = path.join(codexDir, "config.toml");
  const codex = cli("codex");
  if (codex || fs.existsSync(codexDir)) {
    let toml = fs.existsSync(codexToml) ? fs.readFileSync(codexToml, "utf8") : "";
    const stripped = toml.replace(/\n*# herdr-webtab:start[\s\S]*?# herdr-webtab:end\n?/g, "\n");
    if (stripped !== toml) { fs.writeFileSync(codexToml, stripped.trimEnd() + "\n"); toml = stripped; }
    if (codex) {
      try { run(codex, ["mcp", "remove", "webtab"]); } catch {}
      try { run(codex, ["mcp", "add", "webtab", "--", ...launch]); registered.push("Codex"); }
      catch (e) { warn(`Codex: ${firstLine(e)}`); }
    } else if (/^\[mcp_servers\.webtab\]/m.test(toml)) {
      warn("Codex: ~/.codex/config.toml already has an [mcp_servers.webtab] of its own; left it alone");
    } else {
      if (fs.existsSync(codexToml) && !fs.existsSync(codexToml + ".before-webtab")) fs.copyFileSync(codexToml, codexToml + ".before-webtab");
      const q = (s) => JSON.stringify(s);
      fs.writeFileSync(codexToml, (toml.trimEnd() + `\n\n# herdr-webtab:start\n[mcp_servers.webtab]\ncommand = ${q(launch[0])}\nargs = [${q(launch[1])}]\nstartup_timeout_sec = 30\n# herdr-webtab:end\n`).trimStart());
      registered.push("Codex");
    }
  }

  // pi (pi-mcp-adapter reads ~/.pi/agent/mcp.json)
  const piDir = path.join(USER_HOME, ".pi", "agent");
  if (fs.existsSync(piDir)) {
    const f = path.join(piDir, "mcp.json");
    const j = C.readJson(f, null);
    if (j === null && fs.existsSync(f)) warn("pi: ~/.pi/agent/mcp.json isn't valid JSON; skipped");
    else {
      if (fs.existsSync(f) && !fs.existsSync(f + ".before-webtab")) fs.copyFileSync(f, f + ".before-webtab");
      const next = j || {};
      next.mcpServers = { ...(next.mcpServers || {}), webtab: { command: launch[0], args: [launch[1]] } };
      fs.writeFileSync(f, JSON.stringify(next, null, 2) + "\n");
      registered.push("pi (needs pi-mcp-adapter)");
    }
  }
  say(`MCP server "webtab": ${registered.length ? registered.join(", ") : "no Claude Code, Codex or pi found"}`);

  // The note agents read: Herdr's AGENTS.md tells them to read AGENTS.local.md, and Herdr never writes it.
  const notes = path.join(HOME, "AGENTS.local.md");
  const vars = { ...cfg, guardNote: GUARD ? GUARD_NOTE.replace("{{rules}}", C.fwd(G.guardPaths(HOME).rules)) : "", engine: C.fwd(path.join(HOME, "mods", "webtab", "node", "webtabd.mjs")), agents: registered.length ? registered.join(", ").replace(" (needs pi-mcp-adapter)", "") : "agents that support MCP" };
  const section = fs.readFileSync(path.join(REPO, "agents", "AGENTS.local.section.md"), "utf8")
    .replace(/^\{\{guardNote\}\}\r?\n/m, vars.guardNote ? vars.guardNote + "\n" : "")
    .replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? "")).trim();
  let cur = fs.existsSync(notes) ? fs.readFileSync(notes, "utf8") : "# Notes on this machine's Herdr setup\n";
  const BEGIN = "<!-- herdr-webtab:start", END = "<!-- herdr-webtab:end -->";
  const a = cur.indexOf(BEGIN), b = cur.indexOf(END);
  cur = a >= 0 && b > a ? cur.slice(0, a) + section + cur.slice(b + END.length) : cur.trimEnd() + "\n\n" + section + "\n";
  fs.writeFileSync(notes, cur);
  say(`agent note: ${C.fwd(notes)}`);
}

// ---------- 6. Guard: a PreToolUse hook for Claude Code and Codex, its rules file ----------
const guarded = [];
if (GUARD) {
  say(`guard rules: ${C.fwd(G.seedGuardConfig(HOME))}`);
  const hookFile = C.fwd(path.join(HOME, "mods", "webtab", "node", "guard-hook.mjs"));
  const hookCmd = (agent) => `"${C.fwd(process.execPath)}" "${hookFile}" --agent ${agent}`;
  // A settings file we can't read is left alone: never overwrite what we don't understand.
  const editJson = (file, fn) => {
    const j = fs.existsSync(file) ? C.readJson(file, null) : {};
    if (j === null || typeof j !== "object" || Array.isArray(j)) { warn(`guard: ${C.fwd(file)} isn't valid JSON; skipped`); return false; }
    if (fs.existsSync(file) && !fs.existsSync(file + ".before-webtab")) fs.copyFileSync(file, file + ".before-webtab");
    fn(j);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
    return true;
  };
  // Claude Code: ~/.claude/settings.json (user scope: every project). Bash and, on Windows, PowerShell.
  const claudeDir = path.join(USER_HOME, ".claude");
  if (fs.existsSync(claudeDir) || cli("claude")) {
    if (editJson(path.join(claudeDir, "settings.json"), (j) => G.addGuardHook(j, { matcher: "Bash|PowerShell", command: hookCmd("claude") }))) guarded.push("Claude Code");
  }
  // Codex: $CODEX_HOME/hooks.json. Codex runs hooks only with [features] hooks on, after you trust them in /hooks.
  const codexHome = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(USER_HOME, ".codex");
  if (fs.existsSync(codexHome) || cli("codex")) {
    if (editJson(path.join(codexHome, "hooks.json"), (j) => G.addGuardHook(j, { matcher: "Bash", command: hookCmd("codex") }))) {
      guarded.push("Codex");
      const toml = fs.existsSync(path.join(codexHome, "config.toml")) ? fs.readFileSync(path.join(codexHome, "config.toml"), "utf8") : "";
      const off = /^\[features\][^[]*^\s*hooks\s*=\s*false/m.test(toml);
      say(`guard: Codex ${off ? "has hooks turned OFF ([features] hooks = false in config.toml): turn them on, then" : "needs you to"} trust the new hook once (/hooks in Codex)`);
    }
  }
  say(`guard: agent hook for ${guarded.length ? guarded.join(", ") : "no Claude Code or Codex found"}; terminal alerts in Herdr`);
}

// ---------- 7. optional: start at login ----------
const node = C.fwd(process.execPath), engine = C.fwd(path.join(HOME, "mods", "webtab", "node", "webtabd.mjs"));
if (has("--autostart")) {
  const f = C.autostartFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const body = {
    win32: () => `' herdr-webtab engine (from herdr-webtab install.mjs)\r\nCreateObject("WScript.Shell").Run """${node}"" ""${engine}"" --detach --app-home ""${C.fwd(HOME)}""", 0, False\r\n`,
    darwin: () => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>dev.herdr.webtab</string>\n  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(engine)}</string><string>--detach</string><string>--app-home</string><string>${xml(HOME)}</string></array>\n  <key>RunAtLoad</key><true/>\n</dict></plist>\n`,
    linux: () => `[Desktop Entry]\nType=Application\nName=Herdr web tab engine\nExec="${node}" "${engine}" --detach --app-home "${HOME}"\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`,
  }[process.platform] || (() => "");
  fs.writeFileSync(f, body());
  say(`autostart: ${C.fwd(f)}`);
}

// ---------- 8. (re)start the engine and Guard's watcher, and check the mods ----------
const before = await C.engineStatus(cfg);
if (before) await C.stopEngine(HOME, { closeBrowser: false }); // an older engine may still be running
const started = has("--no-start") ? null : await C.ensureEngine(HOME);
if (GUARD && !has("--no-start")) {
  // An older watcher may still run: replace it with this version's.
  try { execFileSync(process.execPath, [path.join(HOME, "mods", "webtab", "node", "guardd.mjs"), "--stop", "--app-home", HOME], { stdio: "ignore", windowsHide: true, timeout: 10000 }); } catch {}
  const { spawn } = await import("node:child_process");
  spawn(process.execPath, [path.join(HOME, "mods", "webtab", "node", "guardd.mjs"), "--app-home", HOME], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  say("guard: terminal watcher running");
}
if (started) say(started.ok ? `engine: running (CDP ${started.status.cdp}, ${started.status.tabs.length} tab(s), display scale ${started.status.dpr})` : `engine: ${started.error}`);
const herdrApp = cli("herdr-app");
if (herdrApp) {
  for (const m of ["webtab", "webtab-new", "webtab-guard", ...(fs.existsSync(baseMenu) ? ["new-menu-web"] : [])]) {
    try { run(herdrApp, ["check", path.join(HOME, "mods", m)]); } catch (e) { warn(`herdr-app check ${m}: ${firstLine(e)}`); }
  }
  say("herdr-app check: done");
}
console.log(`done. Open one from the command palette ("New web tab")${has("--menu") ? " or the + menu" : ""}, or:\n` +
  `  herdr-app do tab.new '{"name":"🌐 Web","mod":"webtab","props":{"id":"1","url":"https://example.com"}}'`);
if (started && !started.ok) process.exit(3);
