// Guard: a command policy shared by the agent hook (guard-hook.mjs) and the terminal watcher
// (guardd.mjs). Plain Node (22+), no dependencies.
//
// Every rule has a severity:
//   block  the agent hook refuses the command (terminals: an alert, since Guard can't stop typing)
//   alert  the agent hook asks the person first (Claude Code) or warns (Codex); terminals: an alert
//   audit  logged only
//
// It's a text policy, not a sandbox: a determined process can hide a command from it. It is there to
// catch the destructive mistake, the leaked key and the surprise publish.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const SEVERITIES = ["audit", "alert", "block"];
const rank = (s) => SEVERITIES.indexOf(s);

// Where a command starts: line start or after ; & | ( or $( , then any sudo/env/VAR=x prefixes.
const AT = String.raw`(?:^|[;&|\n({]|\$\()\s*(?:(?:sudo|doas|command|nohup|time|exec)\s+(?:-\S+\s+)*|env\s+(?:-\S+\s+)*(?:\w+=\S*\s+)*|\w+=\S*\s+)*`;
// The rest of one command (stops at ; & | and newlines).
const REST = String.raw`[^;&|\n]*`;
const HOMEISH = String.raw`(?:~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%|\$env:HOMEPATH)`;
// A path that is the whole disk, a drive, a home folder or "everything here".
const ROOTISH = String.raw`(?:\/\*?|${HOMEISH}[\\/]?\*?|[A-Za-z]:[\\/]?\*?|\*|\.[\\/]?\*?|\.\.[\\/]?\*?)`;
const ARGEND = String.raw`(?=\s|$|[;&|)])`;
const SECRET_FILE = String.raw`(?:\.ssh[\\/](?:id_[a-z0-9]+|[^\s\\/]*_key)(?!\.pub)\b|\.aws[\\/]credentials|\.git-credentials|\.netrc|\.pypirc|\.npmrc|\.docker[\\/]config\.json|\.kube[\\/]config|\.config[\\/]gh[\\/]hosts\.yml|\.codex[\\/]auth\.json|\.claude[\\/]\.credentials\.json|(?<=^|[\s\\/'"=@])\.env(?:\.(?:local|prod|production|dev|development))?${ARGEND})`;
const READERS = String.raw`(?:cat|type|less|more|head|tail|bat|nl|strings|xxd|od|base64|gc|Get-Content|Select-String|cp|copy|Copy-Item|scp|rsync)`;
const NET = String.raw`(?:curl|wget|nc|ncat|netcat|socat|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)`;
const SHELLS = String.raw`(?:ba|z|da|k|fi)?sh|pwsh|powershell|iex|Invoke-Expression|python3?|node|perl|ruby`;

const r = (id, severity, why, re, opt = {}) => ({ id, severity, why, re: new RegExp(re, opt.flags ?? "i"), raw: !!opt.raw });

/** The rules Guard ships with. Ids are stable: config can turn one off or change its severity. */
export const DEFAULT_RULES = [
  // ---- wiping disks, homes and repos ----
  r("rm-rf-root", "block", "deletes a whole disk, home folder or everything in the current folder",
    String.raw`${AT}rm\b(?=${REST}\s-(?:[a-zA-Z]*[rR]|-recursive\b))(?=${REST}\s-(?:[a-zA-Z]*f|-force\b))${REST}\s["']?${ROOTISH}["']?${ARGEND}`),
  r("rm-rf", "audit", "deletes a folder tree without asking",
    String.raw`${AT}rm\b(?=${REST}\s-(?:[a-zA-Z]*[rR]|-recursive\b))(?=${REST}\s-(?:[a-zA-Z]*f|-force\b))`),
  r("remove-item-root", "block", "deletes a whole drive or home folder",
    String.raw`${AT}(?:Remove-Item|rm|ri|del|rd|rmdir)\b(?=${REST}-Recurse\b)${REST}(?:\s|-Path\s+|-LiteralPath\s+)["']?${ROOTISH}["']?${ARGEND}`),
  r("remove-item-recurse", "audit", "deletes a folder tree",
    String.raw`${AT}(?:Remove-Item|ri)\b(?=${REST}-Recurse\b)(?=${REST}-Force\b)`),
  r("rd-s-root", "block", "deletes a whole drive or home folder",
    String.raw`${AT}(?:rd|rmdir|del|erase)\b(?=${REST}\/[sS]\b)${REST}\s["']?(?:[A-Za-z]:[\\/]?\*?|%USERPROFILE%[\\/]?|\\)["']?${ARGEND}`),
  r("format-disk", "block", "formats or wipes a disk",
    String.raw`${AT}(?:format\s+[A-Za-z]:|Format-Volume\b|Clear-Disk\b|Initialize-Disk\b|diskpart\b|mkfs(?:\.\w+)?\s|wipefs\s|shred\s${REST}\/dev\/|dd\s${REST}\bof=\/dev\/(?:sd|nvme|disk|hd|mmcblk))`),
  r("chmod-root", "block", "opens up or takes over the whole filesystem",
    String.raw`${AT}(?:chmod|chown|chgrp)\b(?=${REST}\s-(?:[a-zA-Z]*R|-recursive))${REST}\s\/["']?${ARGEND}`),
  r("fork-bomb", "block", "a fork bomb", String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`),

  // ---- git and GitHub ----
  r("git-force-push-main", "block", "force-pushes over main/master",
    String.raw`${AT}git\s${REST}\bpush\b(?=${REST}(?:\s--force(?!-with-lease|-if-includes)\b|\s-[a-zA-Z]*f\b|\s\+\S))${REST}\b(?:main|master)\b`),
  r("git-force-push", "alert", "force-pushes, which can throw away commits on the remote",
    String.raw`${AT}git\s${REST}\bpush\b(?=${REST}(?:\s--force(?!-with-lease|-if-includes)\b|\s-[a-zA-Z]*f\b|\s\+\S))`),
  r("git-force-with-lease", "audit", "force-pushes with a lease",
    String.raw`${AT}git\s${REST}\bpush\s${REST}--force-(?:with-lease|if-includes)`),
  r("git-delete-remote-branch", "alert", "deletes a branch on the remote",
    String.raw`${AT}git\s${REST}\bpush\s(?:${REST}\s(?:--delete|-d)\b|${REST}\s:[\w./-]+${ARGEND})`),
  r("git-reset-hard", "audit", "throws away uncommitted work", String.raw`${AT}git\s${REST}\b(?:reset\s${REST}--hard|clean\s${REST}-[a-zA-Z]*[fdx][a-zA-Z]*|checkout\s+(?:--\s+)?\.${ARGEND}|restore\s+(?:--\S+\s+)*\.${ARGEND})`),
  r("gh-repo-delete", "block", "deletes a GitHub repository", String.raw`${AT}gh\s+repo\s+(?:delete|archive)\b`),
  r("gh-repo-public", "alert", "makes a GitHub repository public", String.raw`${AT}gh\s+repo\s+(?:edit\s${REST}--visibility[=\s]+public|create\s${REST}--public)`),

  // ---- publishing and releases ----
  r("publish", "alert", "publishes a package or image for everyone",
    String.raw`${AT}(?:npm\s+publish|pnpm\s+publish|yarn\s+(?:npm\s+)?publish|bun\s+publish|cargo\s+publish|twine\s+upload|poetry\s+publish|uv\s+publish|gem\s+push|dotnet\s+nuget\s+push|nuget\s+push|docker\s+push|podman\s+push|gh\s+release\s+create|vsce\s+publish|ovsx\s+publish)\b`),

  // ---- cloud, clusters, infrastructure, databases ----
  r("infra-destroy", "alert", "deletes cloud or cluster resources",
    String.raw`${AT}(?:terraform\s+(?:destroy|apply\s${REST}-destroy)|tofu\s+destroy|pulumi\s+destroy|cdk\s+destroy|aws\s${REST}\b(?:delete-[\w-]+|terminate-instances|s3\s+rb|s3\s+rm\s${REST}--recursive)|gcloud\s${REST}\bdelete\b|az\s${REST}\bdelete\b|kubectl\s${REST}\bdelete\s${REST}(?:\b(?:namespace|ns|pv|pvc|node|crd)\b|--all\b)|helm\s+(?:uninstall|delete)\b|heroku\s+apps:destroy|fly\s+(?:apps\s+)?destroy|vercel\s+(?:remove|rm)\b|doctl\s${REST}\bdelete\b)`),
  r("sql-drop", "alert", "drops or empties a database table",
    String.raw`(?:psql|mysql|mariadb|sqlite3|sqlcmd|mongosh?|duckdb|clickhouse(?:-client)?|cockroach\s+sql|supabase\s+db|prisma\s+db\s+execute|Invoke-Sqlcmd)\b[\s\S]*\b(?:DROP\s+(?:DATABASE|SCHEMA|TABLE)|TRUNCATE\s+(?:TABLE\s+)?\w|dropDatabase\(|\.drop\(\))`, { raw: true }),

  // ---- secrets and sending things away ----
  r("secret-exfil", "block", "sends a key or secrets file to the network",
    String.raw`(?:${NET}\b${REST}(?:@|--upload-file\s+|-T\s+|-InFile\s+)["']?\S*${SECRET_FILE}|${READERS}\s${REST}${SECRET_FILE}${REST}\|\s*${NET}\b|\b(?:scp|rsync|sftp)\s${REST}(?:\.ssh|\.aws|\.gnupg)(?:[\\/]|\s|$)${REST}\S+:)`),
  r("env-exfil", "block", "sends your environment variables (and the keys in them) to the network",
    String.raw`${AT}(?:env|printenv|set|Get-ChildItem\s+env:|gci\s+env:|dir\s+env:)\s*\|${REST}\b${NET}\b`),
  r("secret-read", "alert", "reads a private key, token or secrets file",
    String.raw`${AT}${READERS}\s${REST}${SECRET_FILE}`),

  // ---- running code from the internet, hidden commands ----
  r("pipe-to-shell", "alert", "runs a script straight from the internet",
    String.raw`\b${NET}\b${REST}\|\s*(?:sudo\s+)?(?:${SHELLS})\b|\b(?:iex|Invoke-Expression)\s*\(?\s*\(?\s*(?:New-Object\s+Net\.WebClient|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b`),
  r("encoded-command", "alert", "runs a hidden (encoded) command",
    String.raw`(?:\b(?:powershell|pwsh)(?:\.exe)?${REST}\s-(?:e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}|base64\s+(?:-d|--decode|-D)\b${REST}\|\s*(?:${SHELLS})\b|\bFromBase64String\b[\s\S]*\b(?:iex|Invoke-Expression)\b)`),
  r("history-wipe", "audit", "clears shell history", String.raw`${AT}(?:history\s+-c|Clear-History\b|unset\s+HISTFILE)`),

  // ---- Guard itself, Herdr, the machine ----
  r("guard-tamper", "alert", "changes or switches off Guard",
    String.raw`(?:\b(?:rm|del|erase|rd|rmdir|Remove-Item|ri|mv|move|Move-Item|Rename-Item|truncate|Set-Content|Clear-Content|Out-File|sed\s+-i)\b${REST}|>>?\s*["']?)\S*(?:data[\\/]webtab[\\/]guard\b|guard-hook\.mjs|guardd\.mjs|mods[\\/]webtab[\\/]node[\\/]guard\.mjs)`, { raw: true }),
  r("kill-herdr", "alert", "stops Herdr", String.raw`${AT}(?:taskkill\s${REST}herdr|Stop-Process\s${REST}herdr|kill(?:all)?\s${REST}herdr|pkill\s${REST}herdr|hc\s+server\s+stop)`),
  r("shutdown", "alert", "shuts down or restarts the computer", String.raw`${AT}(?:shutdown(?:\.exe)?\s|Stop-Computer\b|Restart-Computer\b|reboot\b|poweroff\b|halt\b)`),
  r("registry-delete", "alert", "deletes from the Windows registry", String.raw`${AT}(?:reg(?:\.exe)?\s+delete\s|Remove-Item(?:Property)?\s${REST}(?:HKLM|HKCU|Registry)::?)`),
];

// ---------- reading a command the way a shell would, roughly ----------

const EXECS = /\b(?:(?:ba|z|da|k)?sh|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?|python3?|node|perl|ruby)\s+(?:\S+\s+)*?(?:-c|-Command|\/c|\/k|-e)\b|\b(?:eval|iex|Invoke-Expression|exec)\b|\bxargs\b|\bssh\s/i;

/**
 * The texts to match against one command. Quoted text and heredoc bodies are usually messages
 * (a commit message that says "rm -rf /" mustn't be blocked), so they are blanked out, except
 * short single words (paths) and anything a shell is asked to run (bash -c "…", eval, heredocs fed
 * to a shell).
 */
export function views(command) {
  let s = String(command ?? "").replace(/\r\n?/g, "\n");
  const inner = [];
  // heredocs: <<EOF … EOF (fed to a shell: its body is code)
  s = s.replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g, (all, _q, tag, tail, body, off, str) => {
    const lineStart = str.lastIndexOf("\n", off) + 1;
    if (EXECS.test(str.slice(lineStart, off)) || /^\s*(?:(?:ba|z)?sh|pwsh|powershell|python3?|node)\b/i.test(str.slice(lineStart, off))) inner.push(body);
    return `<<${tag}${tail}\n${tag}`;
  });
  const runsStrings = EXECS.test(s);
  const unquote = (src, dq) => src.replace(new RegExp(`'([^'\\n]*)'|${dq}`, "g"), (all, a, b) => {
    const body = a ?? (dq.includes("\\\\") ? b.replace(/\\(.)/g, "$1") : b);
    if (runsStrings) inner.push(body);
    return /\s/.test(body) ? "''" : body; // a path or a word stays; a sentence goes
  });
  // Bash escapes \" inside double quotes; PowerShell and cmd don't (C:\" ends the string there).
  const mark = inner.length;
  let out = unquote(s, String.raw`"((?:[^"\\\n]|\\.)*)"`);
  if (out.includes('"')) { inner.length = mark; out = unquote(s, String.raw`"([^"\n]*)"`); }
  s = out;
  return { text: s, inner };
}

/** Rules in force: the defaults, minus what config turns off, with config's severities and extra rules. */
export function compileRules(config = {}) {
  const off = new Set(Array.isArray(config.disabled) ? config.disabled.map(String) : []);
  const sev = config.severity && typeof config.severity === "object" ? config.severity : {};
  const out = [];
  for (const rule of DEFAULT_RULES) {
    if (off.has(rule.id)) continue;
    const s = SEVERITIES.includes(sev[rule.id]) ? sev[rule.id] : rule.severity;
    out.push({ ...rule, severity: s });
  }
  for (const x of Array.isArray(config.rules) ? config.rules : []) {
    if (!x || typeof x !== "object" || typeof x.pattern !== "string" || off.has(String(x.id))) continue;
    try {
      out.push({ id: String(x.id || "custom"), severity: SEVERITIES.includes(x.severity) ? x.severity : "alert",
        why: String(x.why || "matches a rule of yours"), re: new RegExp(x.pattern, typeof x.flags === "string" ? x.flags.replace(/[gy]/g, "") : "i"), raw: !!x.raw });
    } catch {} // a broken rule of the person's is skipped, never fatal
  }
  return out;
}

/**
 * Checks one command. Resolves to { verdict: "allow" | "audit" | "alert" | "block", hits: [{id, severity, why}] },
 * the verdict being the most severe hit.
 */
export function evaluate(command, rules = compileRules()) {
  const raw = String(command ?? "");
  if (!raw.trim()) return { verdict: "allow", hits: [] };
  const v = views(raw);
  const texts = [v.text, ...v.inner];
  const hits = [];
  for (const rule of rules) {
    const hit = rule.raw ? rule.re.test(raw) : texts.some((t) => rule.re.test(t));
    if (hit) hits.push({ id: rule.id, severity: rule.severity, why: rule.why });
  }
  // rm-rf / rm-rf-root style pairs: keep only the most severe of rules on the same action
  hits.sort((a, b) => rank(b.severity) - rank(a.severity));
  return { verdict: hits[0]?.severity || "allow", hits };
}

// ---------- config and the audit log ----------

export function guardPaths(home) {
  const dir = path.join(home, "data", "webtab", "guard");
  return { dir, rules: path.join(dir, "rules.json"), audit: path.join(dir, "audit.jsonl"), state: path.join(dir, "watcher.json") };
}

export const RULES_TEMPLATE = {
  "//": "Guard rules. Turn shipped rules off by id, change their severity (audit, alert, block), or add your own regex rules. See the README.",
  disabled: [],
  severity: {},
  rules: [],
};

/** The person's rules file (seeded on first use). A broken file falls back to the shipped rules. */
export function loadGuardConfig(home) {
  const p = guardPaths(home);
  try { return { ...JSON.parse(fs.readFileSync(p.rules, "utf8")), ok: true }; }
  catch (e) { return { ok: e.code === "ENOENT", error: e.code === "ENOENT" ? null : `rules.json isn't valid JSON (${e.message}); using the shipped rules` }; }
}

export function seedGuardConfig(home) {
  const p = guardPaths(home);
  fs.mkdirSync(p.dir, { recursive: true });
  if (!fs.existsSync(p.rules)) fs.writeFileSync(p.rules, JSON.stringify(RULES_TEMPLATE, null, 2) + "\n", { mode: 0o600 });
  return p.rules;
}

// Tokens and passwords never reach the log.
const SECRETS = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[\w-]{20,}|sk-(?:ant-|proj-)?[\w-]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g,
  /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
  /((?:authorization|x-api-key|private-token)\s*:\s*(?:bearer\s+|basic\s+|token\s+)?)(\S+)/gi,
  /(\/\/[^/\s:@]+:)([^@\s/]+)(@)/g,
];
export function redact(text) {
  let s = String(text ?? "");
  s = s.replace(SECRETS[0], "***");
  s = s.replace(SECRETS[1], "$1***").replace(SECRETS[2], "$1***").replace(SECRETS[3], "$1***$3");
  return s;
}

/** Appends one event to the audit log (kept under ~1 MB: the old half rolls to audit.jsonl.old). */
export function audit(home, event) {
  const p = guardPaths(home);
  fs.mkdirSync(p.dir, { recursive: true });
  try { if (fs.statSync(p.audit).size > 1e6) fs.renameSync(p.audit, p.audit + ".old"); } catch {}
  const id = `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const line = { id, at: new Date().toISOString(), ...event, command: redact(String(event.command ?? "")).slice(0, 600) };
  fs.appendFileSync(p.audit, JSON.stringify(line) + "\n", { mode: 0o600 });
  return line;
}

/** The newest audit events, newest last. */
export function recent(home, n = 50) {
  const p = guardPaths(home);
  try {
    const lines = fs.readFileSync(p.audit, "utf8").trim().split("\n").slice(-n);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * Shows new alerts in Herdr: opens the webtab-guard mod, which posts a notification for each one it
 * hasn't shown yet and closes. Fire and forget; no Herdr window means no toast, the log still has it.
 */
export function toastHerdr(herdrApp) {
  if (!herdrApp || process.env.WEBTAB_GUARD_NO_TOAST === "1") return;
  try {
    const child = spawn(herdrApp, ["do", "mod.open", JSON.stringify({ name: "webtab-guard" })], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

// ---------- reading commands off a terminal (the watcher, guardd.mjs) ----------

// Programs whose terminals are shells we can read commands from. Agent TUIs are left to the hook.
export const SHELL_PROGRAMS = /^(?:pwsh|powershell|bash|zsh|sh|fish|cmd|nu|dash|ksh|tcsh|elvish|xonsh)(?:\.exe)?$/i;

// A line that is a prompt followed by a command; the command is the last group.
const PROMPTS = [
  /^PS(?: [^>\n]*)?> (.+)$/,                                   // PowerShell: PS C:\x> cmd
  /^[A-Za-z]:\\[^>\n]*>(\S.*)$/,                              // cmd.exe:    C:\x>cmd
  /^(?:\([^)\n]*\)\s*)?[\w.-]+@[\w.-]+(?::|\s)[^\n$#%]*[$#%] (.+)$/, // bash/zsh:   me@host:~/x$ cmd
  /^[^\s\n]{0,40}\s?[$#%❯➜»›λ] (.+)$/u,                      // short prompts: $ cmd, ~/x ❯ cmd, (venv) $ cmd
];
export function commandOf(line) {
  const s = line.replace(/\s+$/, "");
  for (const re of PROMPTS) { const m = re.exec(s); if (m && m[1].trim()) return m[1].trim(); }
  return null;
}

/**
 * The commands in a terminal's text, oldest first. The last non-empty line is skipped: a command on
 * it may still be being typed. It counts once anything follows it (its output or the next prompt).
 */
export function commandsIn(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.pop();
  return lines.map(commandOf).filter(Boolean);
}

/** What's new in `cur` given the last read `prev`: the part after the longest overlap of prev's end with cur's start. */
export function newCommands(prev, cur) {
  for (let m = Math.min(prev.length, cur.length); m > 0; m--) {
    let same = true;
    for (let i = 0; i < m && same; i++) same = prev[prev.length - m + i] === cur[i];
    if (same) return cur.slice(m);
  }
  return cur;
}

/** One line for people: what was caught and why. */
export function describe(result) {
  const top = result.hits[0];
  return top ? `${top.why} (rule ${top.id})` : "";
}

// ---------- registering the hook with Claude Code (settings.json) and Codex (hooks.json) ----------
// Both use { hooks: { PreToolUse: [ { matcher, hooks: [ { type: "command", command, timeout } ] } ] } }.

export const HOOK_MARK = "mods/webtab/node/guard-hook.mjs";
const isOurs = (h) => typeof h?.command === "string" && h.command.replace(/\\/g, "/").includes(HOOK_MARK);

/** Removes our PreToolUse entries (only ours: other hooks in the same groups stay). Returns whether anything changed. */
export function removeGuardHook(settings) {
  const list = settings?.hooks?.PreToolUse;
  if (!Array.isArray(list)) return false;
  let changed = false;
  const next = [];
  for (const group of list) {
    if (!group || !Array.isArray(group.hooks)) { next.push(group); continue; }
    const kept = group.hooks.filter((h) => !isOurs(h));
    if (kept.length !== group.hooks.length) changed = true;
    if (kept.length) next.push({ ...group, hooks: kept });
  }
  if (!changed) return false;
  if (next.length) settings.hooks.PreToolUse = next; else delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return true;
}

/** Puts our PreToolUse entry in (replacing an older one of ours). */
export function addGuardHook(settings, { matcher, command, timeout = 10 }) {
  removeGuardHook(settings);
  settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const list = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  list.push({ matcher, hooks: [{ type: "command", command, timeout }] });
  settings.hooks.PreToolUse = list;
  return settings;
}
