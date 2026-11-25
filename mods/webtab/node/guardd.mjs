#!/usr/bin/env node
// guardd: Guard's terminal watcher. Every couple of seconds it reads the shell terminals Herdr runs
// (through `hc`), picks out the commands typed at a prompt, and checks each new one against Guard's
// policy (guard.mjs). A risky one is logged and shown as a Herdr notification. It never types into a
// terminal or stops anything: in a terminal the person is in charge. Agents' own commands are
// stopped earlier, by the agent hook (guard-hook.mjs).
//
// One runs at a time (the pid in data/webtab/guard/watcher.json). The agent hook, the installer and
// the login item start it.
//
//   node guardd.mjs [--app-home <dir>]   run (exits at once if another watcher is running)
//   node guardd.mjs --stop               stop the running watcher
//   node guardd.mjs --status             print the running watcher's state
import fs from "node:fs";
import { execFile } from "node:child_process";
import { appHome, which, alive, VERSION } from "./common.mjs";
import { evaluate, compileRules, loadGuardConfig, audit, toastHerdr, describe, guardPaths, SHELL_PROGRAMS, commandsIn, newCommands } from "./guard.mjs";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const HOME = appHome(opt("app-home"));
const P = guardPaths(HOME);
const readState = () => { try { return JSON.parse(fs.readFileSync(P.state, "utf8")); } catch { return null; } };

if (args.includes("--status")) { const s = readState(); console.log(JSON.stringify(s && alive(s.pid) ? s : { running: false }, null, 2)); process.exit(0); }
if (args.includes("--stop")) {
  const s = readState();
  if (s && alive(s.pid)) { try { process.kill(s.pid); } catch {} }
  console.log(JSON.stringify({ stopped: !!(s && alive(s.pid)) }));
  process.exit(0);
}

// ---------- the loop ----------

await main();

async function main() {
  const prev = readState();
  if (prev && prev.pid !== process.pid && alive(prev.pid)) process.exit(0); // one watcher at a time
  fs.mkdirSync(P.dir, { recursive: true });
  const state = { watcher: "guardd", version: VERSION, pid: process.pid, started: new Date().toISOString(), terminals: 0, lastPoll: null, hc: null };
  const save = () => { try { fs.writeFileSync(P.state, JSON.stringify(state, null, 2) + "\n"); } catch {} };
  save();
  // Two watchers starting at once: the later writer wins; the other notices and leaves.
  const claimed = () => readState()?.pid === process.pid;
  process.on("exit", () => { if (claimed()) { try { fs.rmSync(P.state); } catch {} } });
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(0));

  // `hc` (or WEBTAB_HC, a JSON array, for tests).
  const hcCmd = (() => { try { const a = JSON.parse(process.env.WEBTAB_HC || "null"); if (Array.isArray(a) && a.length) return a.map(String); } catch {} const f = which("hc"); return f ? [f] : null; })();
  const hc = (...a) => new Promise((resolve) => {
    if (!hcCmd) return resolve(null);
    execFile(hcCmd[0], [...hcCmd.slice(1), ...a], { encoding: "utf8", timeout: 8000, windowsHide: true, maxBuffer: 8e6 }, (err, stdout) => resolve(err ? null : stdout));
  });
  const herdrApp = which("herdr-app");
  const seen = new Map();      // terminal address -> commands at the last read
  const recentAlerts = new Map(); // `${address}\n${command}` -> time, so a cleared and redrawn screen doesn't alert twice
  const interval = Math.max(500, Number(process.env.WEBTAB_GUARD_POLL_MS) || 2000);

  for (let idle = 0; ; ) {
    if (!claimed()) process.exit(0);
    const cfg = loadGuardConfig(HOME);
    if (cfg.watchTerminals === false) { await sleep(10000); continue; }
    const rules = compileRules(cfg);
    const listing = await hc("ls", "--json");
    let terms = null;
    try { terms = JSON.parse(listing || "null")?.terminals; } catch {}
    state.hc = Array.isArray(terms) ? "ok" : "unavailable"; state.lastPoll = new Date().toISOString();
    if (!Array.isArray(terms)) { save(); await sleep(Math.min(15000, interval * (++idle + 1))); continue; } // Herdr isn't running
    idle = 0;
    const shells = terms.filter((t) => t && t.state === "live" && typeof t.address === "string" && SHELL_PROGRAMS.test(String(t.agent || "")));
    state.terminals = shells.length; save();
    const live = new Set(shells.map((t) => t.address));
    for (const a of seen.keys()) if (!live.has(a)) seen.delete(a);
    for (const t of shells) {
      const text = await hc("read", t.address, "--lines", "80");
      if (text == null) continue;
      const cur = commandsIn(text);
      const before = seen.get(t.address);
      seen.set(t.address, cur);
      if (!before) continue; // first look: what's already on screen happened before we watched
      for (const command of newCommands(before, cur)) {
        const r = evaluate(command, rules);
        if (r.verdict === "allow") continue;
        const key = `${t.address}\n${command}`;
        if (r.verdict !== "audit" && Date.now() - (recentAlerts.get(key) || 0) < 10 * 60e3) continue;
        recentAlerts.set(key, Date.now());
        // In a terminal Guard can't stop a command, so a "block" is reported as an alert.
        audit(HOME, { source: "terminal", terminal: t.address, where: String(t.where || t.labels?.where || ""), verdict: r.verdict === "block" ? "alert" : r.verdict,
          rules: r.hits.map((h) => h.id), why: describe(r), cwd: String(t.cwd || ""), command });
        if (r.verdict !== "audit") toastHerdr(herdrApp);
      }
    }
    for (const [k, at] of recentAlerts) if (Date.now() - at > 10 * 60e3) recentAlerts.delete(k);
    await sleep(interval);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
