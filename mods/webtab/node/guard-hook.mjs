#!/usr/bin/env node
// Guard's agent hook: Claude Code and Codex run it before every shell command (PreToolUse). It reads
// the tool call on stdin and answers with the policy in guard.mjs:
//   block  -> deny: the command never runs, and the agent is told why
//   alert  -> Claude Code asks the person first; Codex shows a warning (its hooks can't ask)
//   audit  -> runs, logged
// The verdict is worked out here, in-process: no daemon to be down, so it never silently fails open.
// A crash or bad input lets the command through (an agent must not be stuck on Guard's bug), and
// that is logged too.
//
//   node guard-hook.mjs --agent claude|codex        hook mode (stdin: the agent's hook JSON)
//   node guard-hook.mjs --test "<command>"          dry run: what Guard would do, and why
//   node guard-hook.mjs --recent [n]                the last n events in the audit log
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { appHome, which, alive, NODE_DIR } from "./common.mjs";
import { evaluate, compileRules, loadGuardConfig, audit, recent, toastHerdr, describe, guardPaths } from "./guard.mjs";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const HOME = appHome(opt("app-home"));
const SHELL_TOOLS = /^(?:Bash|PowerShell|shell|local_shell|exec_command|unified_exec)$/i;

if (args.includes("--test")) {
  const cmd = opt("test") ?? "";
  const cfg = loadGuardConfig(HOME);
  if (cfg.error) console.error(cfg.error);
  const r = evaluate(cmd, compileRules(cfg));
  console.log(JSON.stringify({ verdict: r.verdict, hits: r.hits }, null, 2));
  process.exit(0);
}
if (args.includes("--recent")) {
  for (const e of recent(HOME, Number(opt("recent")) || 20)) console.log(`${e.at}  ${e.verdict.padEnd(5)}  ${e.source}${e.agent ? ":" + e.agent : ""}${e.terminal ? ":" + e.terminal : ""}  ${e.rules?.join(",") || ""}  ${e.command}`);
  process.exit(0);
}

const agent = /^(claude|codex)$/i.test(opt("agent") || "") ? opt("agent").toLowerCase() : "claude";

function readStdin(ms = 3000) {
  return new Promise((resolve) => {
    let buf = "";
    const done = () => resolve(buf);
    const t = setTimeout(done, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { buf += d; if (buf.length > 4e6) { clearTimeout(t); done(); } });
    process.stdin.on("end", () => { clearTimeout(t); done(); });
    process.stdin.on("error", () => { clearTimeout(t); done(); });
  });
}

// The terminal watcher shares the audit log and the toasts; make sure it's running (a pid check, no
// network: a refused localhost connection takes seconds on Windows).
function ensureWatcher() {
  try {
    const st = JSON.parse(fs.readFileSync(guardPaths(HOME).state, "utf8"));
    if (alive(st.pid)) return;
  } catch {}
  try {
    const child = spawn(process.execPath, [path.join(NODE_DIR, "guardd.mjs"), "--app-home", HOME], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {}); child.unref();
  } catch {}
}

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

try {
  const input = JSON.parse((await readStdin()) || "{}");
  const tool = String(input.tool_name || "");
  let command = input.tool_input?.command;
  if (Array.isArray(command)) command = command.join(" ");
  if (!SHELL_TOOLS.test(tool) || typeof command !== "string") process.exit(0);

  const cfg = loadGuardConfig(HOME);
  if (cfg.watchTerminals !== false && process.env.WEBTAB_GUARD_NO_WATCHER !== "1") ensureWatcher();
  const r = evaluate(command, compileRules(cfg));
  if (r.verdict === "allow") process.exit(0);

  audit(HOME, { source: "agent", agent, tool, verdict: r.verdict, rules: r.hits.map((h) => h.id), why: describe(r), cwd: String(input.cwd || ""), command });
  if (r.verdict === "block" || r.verdict === "alert") toastHerdr(which("herdr-app"));

  const rulesFile = guardPaths(HOME).rules.replace(/\\/g, "/");
  if (r.verdict === "block") {
    out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: `Guard blocked this command: it ${describe(r)}. Don't try to get around this. Tell the person what you wanted to run and why; they can run it themselves, or change the rule in ${rulesFile}.` } });
  } else if (r.verdict === "alert") {
    const reason = `Guard: this command ${describe(r)}.`;
    if (agent === "claude") out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } });
    else out({ systemMessage: reason }); // Codex hooks can deny or allow, not ask: warn and let its own approvals decide
  }
  process.exit(0);
} catch (e) {
  // Fail open, but leave a trace: Guard's own bug must not stop every command an agent runs.
  try { audit(HOME, { source: "agent", agent, verdict: "error", rules: [], why: String(e?.message || e).slice(0, 200), command: "" }); } catch {}
  process.exit(0);
}
