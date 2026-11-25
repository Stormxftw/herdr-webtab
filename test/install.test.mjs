// Installer and uninstaller, in throwaway folders: a fake Herdr app home and a fake user home.
// Uses random ports and never calls the real agent CLIs, so it can't touch a live setup.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";

const REPO = path.resolve(".");
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
let T, APP, USER, env;
const read = (...p) => fs.readFileSync(path.join(...p), "utf8");
const exists = (...p) => fs.existsSync(path.join(...p));

const TABBAR = `export default class Tabs { open() { openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }); } }\n`;
const NOTES = "# My notes\n\nKeep this line.\n";
const CODEX = 'model = "gpt-x"\n\n[mcp_servers.other]\ncommand = "other"\n';
const PI = { mcpServers: { other: { command: "other", args: [] } } };
const KEYS = { global: { "ctrl-shift-t": "tab.new" } };

function sh(script, ...args) {
  return execFileSync(process.execPath, [path.join(REPO, script), ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

before(async () => {
  T = fs.mkdtempSync(path.join(os.tmpdir(), "webtab-install-"));
  APP = path.join(T, "herdr-app"); USER = path.join(T, "user");
  for (const d of ["mods/new-menu", "mods/tabs", "mods/my-tabs", "data/webtab"]) fs.mkdirSync(path.join(APP, d), { recursive: true });
  fs.writeFileSync(path.join(APP, "mods/new-menu/main.js"), "export default class NewMenu {}\n");
  fs.writeFileSync(path.join(APP, "mods/tabs/main.js"), TABBAR);     // shipped: must stay untouched
  fs.writeFileSync(path.join(APP, "mods/my-tabs/main.js"), TABBAR);  // the person's own: patched with --menu
  fs.writeFileSync(path.join(APP, "installed.json"), JSON.stringify({ "new-menu": {}, tabs: {} }));
  fs.writeFileSync(path.join(APP, "AGENTS.local.md"), NOTES);
  fs.writeFileSync(path.join(APP, "keys.json"), JSON.stringify(KEYS, null, 2));
  fs.writeFileSync(path.join(APP, "AGENTS.md"), "# Herdr manual\n");
  // random ports, so nothing here talks to a real engine or browser
  fs.writeFileSync(path.join(APP, "data/webtab/config.json"), JSON.stringify({ port: await freePort(), httpPort: await freePort(), cdpPort: await freePort() }));
  fs.mkdirSync(path.join(USER, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(USER, ".codex/config.toml"), CODEX);
  fs.mkdirSync(path.join(USER, ".pi/agent"), { recursive: true });
  fs.writeFileSync(path.join(USER, ".pi/agent/mcp.json"), JSON.stringify(PI, null, 2));
  env = { ...process.env, HERDR_APP_HOME: APP, HOME: USER, USERPROFILE: USER, APPDATA: path.join(USER, "AppData", "Roaming"),
    XDG_CONFIG_HOME: path.join(USER, ".config"), WEBTAB_NO_AGENT_CLI: "1", WEBTAB_CHROME: process.execPath /* any existing file */ };
});
after(() => { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} });

const installArgs = ["--menu", "--key", "--autostart", "--skip-mcp-download", "--no-start"];

test("install puts every piece in place", () => {
  const out = sh("install.mjs", ...installArgs);
  assert.match(out, /done\./);
  for (const f of ["webtab/mod.json", "webtab/main.js", "webtab/node/webtabd.mjs", "webtab/node/mcp.mjs", "webtab/node/common.mjs", "webtab-new/main.js", "new-menu-web/main.js"]) assert.ok(exists(APP, "mods", f), f);
  assert.equal(read(APP, "mods/new-menu-web/base.js"), read(APP, "mods/new-menu/main.js"));
  // + menu: the person's tab bar points at new-menu-web, with a backup; the shipped one is untouched
  assert.match(read(APP, "mods/my-tabs/main.js"), /mod: "new-menu-web".*height: 560 \/\* webtab: was 512 \*\//);
  assert.equal(read(APP, "mods/my-tabs/main.js.before-webtab"), TABBAR);
  assert.equal(read(APP, "mods/tabs/main.js"), TABBAR);
  // key, config, note, agents, autostart
  const keys = JSON.parse(read(APP, "keys.json"));
  assert.equal(keys.global["ctrl-shift-t"], "tab.new");
  assert.deepEqual(Object.values(keys.global).find((v) => v.args?.name === "webtab-new"), { command: "mod.open", args: { name: "webtab-new" } });
  const cfg = JSON.parse(read(APP, "data/webtab/config.json"));
  assert.equal(cfg.node, process.execPath.replace(/\\/g, "/"));
  const notes = read(APP, "AGENTS.local.md");
  assert.ok(notes.startsWith(NOTES.trimEnd()));
  assert.match(notes, new RegExp(`127\\.0\\.0\\.1:${cfg.cdpPort}`));
  assert.doesNotMatch(notes, /\{\{\w+\}\}/);
  const toml = read(USER, ".codex/config.toml");
  assert.ok(toml.startsWith(CODEX.trimEnd()));
  assert.match(toml, /# herdr-webtab:start\n\[mcp_servers\.webtab\]\ncommand = ".+"\nargs = \[".+mods\/webtab\/node\/mcp\.mjs"\]/);
  const pi = JSON.parse(read(USER, ".pi/agent/mcp.json"));
  assert.deepEqual(pi.mcpServers.other, PI.mcpServers.other);
  assert.match(pi.mcpServers.webtab.args[0], /mods\/webtab\/node\/mcp\.mjs$/);
  const auto = { win32: "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/herdr-webtab.vbs", darwin: "Library/LaunchAgents/dev.herdr.webtab.plist" }[process.platform] || ".config/autostart/herdr-webtab.desktop";
  assert.ok(exists(USER, auto), "autostart file");
});

test("running install again changes nothing it shouldn't and prunes stale files", () => {
  fs.writeFileSync(path.join(APP, "mods/webtab/config.js"), "// left by an older version\n");
  const out = sh("install.mjs", ...installArgs);
  assert.match(out, /already opens a web tab/);
  assert.ok(!exists(APP, "mods/webtab/config.js"), "stale file pruned");
  assert.equal(read(APP, "AGENTS.local.md").split("herdr-webtab:start").length - 1, 1);
  assert.equal(read(USER, ".codex/config.toml").split("[mcp_servers.webtab]").length - 1, 1);
  assert.equal(read(APP, "mods/my-tabs/main.js").split("new-menu-web").length - 1, 1);
  assert.equal(read(APP, "mods/my-tabs/main.js.before-webtab"), TABBAR);
});

test("a key that's already taken is left alone", () => {
  const out = sh("install.mjs", "--key", "ctrl-shift-t", "--skip-mcp-download", "--no-start", "--no-agents");
  assert.match(out, /already bound/);
  assert.equal(JSON.parse(read(APP, "keys.json")).global["ctrl-shift-t"], "tab.new");
});

test("uninstall puts everything back the way it was", () => {
  const out = sh("uninstall.mjs");
  assert.match(out, /done\./);
  for (const m of ["webtab", "webtab-new", "new-menu-web"]) assert.ok(!exists(APP, "mods", m), m);
  assert.equal(read(APP, "mods/my-tabs/main.js"), TABBAR);
  assert.ok(!exists(APP, "mods/my-tabs/main.js.before-webtab"));
  assert.equal(read(APP, "mods/tabs/main.js"), TABBAR);
  assert.deepEqual(JSON.parse(read(APP, "keys.json")), KEYS);
  assert.equal(read(APP, "AGENTS.local.md"), NOTES);
  assert.equal(read(USER, ".codex/config.toml").trimEnd(), CODEX.trimEnd());
  assert.deepEqual(JSON.parse(read(USER, ".pi/agent/mcp.json")), PI);
  assert.ok(exists(APP, "data/webtab/config.json"), "data kept without --purge");
  sh("uninstall.mjs", "--purge");
  assert.ok(!exists(APP, "data/webtab"), "data removed with --purge");
});

test("install refuses a missing Herdr app home with a clear message", () => {
  assert.throws(() => execFileSync(process.execPath, [path.join(REPO, "install.mjs")], { env: { ...env, HERDR_APP_HOME: path.join(T, "nope") }, stdio: "pipe" }),
    (e) => /app folder wasn't found/.test(String(e.stderr)));
});
