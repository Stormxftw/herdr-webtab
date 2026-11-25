// Shared by the engine (webtabd.mjs), the MCP launcher (mcp.mjs) and the installer.
// Plain Node (22+), no dependencies.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERSION = "0.2.0";
export const MCP_PACKAGE = "chrome-devtools-mcp";
export const MCP_VERSION = "1.14.0";
export const NODE_DIR = path.dirname(fileURLToPath(import.meta.url)); // <appHome>/mods/webtab/node once installed
export const ENGINE = path.join(NODE_DIR, "webtabd.mjs");
export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";

export const DEFAULTS = {
  port: 9440,          // mod <-> engine (NDJSON, token handshake)
  httpPort: 9441,      // GET /status, POST /claim (local tools and agents)
  cdpPort: 9333,       // Chromium DevTools protocol (agents, chrome-devtools-mcp, Playwright)
  dpr: "auto",         // frame sharpness: "auto" (display scale) or a number such as 2
  quality: 72,         // JPEG quality of streamed frames (the settled frame is always 92)
  home: "https://duckduckgo.com",
  search: "https://duckduckgo.com/?q=%s",
  chrome: null,        // path to Chrome/Chromium; null = find one
  chromeArgs: [],      // extra Chromium flags, e.g. ["--no-sandbox"] in a container
  profile: null,       // browser profile folder; null = <appHome>/data/webtab/profile
  node: null,          // node binary the mod uses to start the engine; null = "node" on PATH
};

/** Herdr's app home: --app-home, $HERDR_APP_HOME, the folder this file is installed in, or ~/.config/herdr-app. */
export function appHome(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.HERDR_APP_HOME) return path.resolve(process.env.HERDR_APP_HOME);
  const guess = path.resolve(NODE_DIR, "..", "..", "..");
  if (path.basename(path.dirname(path.dirname(NODE_DIR))) === "mods" && fs.existsSync(path.join(guess, "AGENTS.md"))) return guess;
  return path.join(os.homedir(), ".config", "herdr-app");
}

export function paths(home) {
  const dir = path.join(home, "data", "webtab");
  return {
    dir,
    config: path.join(dir, "config.json"),
    frames: path.join(dir, "frames"),
    token: path.join(dir, "token"),
    log: path.join(dir, "webtabd.log"),
    mcp: path.join(dir, "mcp"),
    framesRel: "data/webtab/frames", // image() paths are relative to the app home
  };
}

export function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function loadConfig(home) {
  const p = paths(home);
  const user = readJson(p.config);
  const cfg = { ...DEFAULTS, ...user };
  if (!cfg.profile) cfg.profile = path.join(p.dir, "profile");
  return { cfg, user, paths: p };
}

/** Merges `patch` into the user's config file (keeps everything they set). */
export function saveConfig(home, patch) {
  const p = paths(home);
  fs.mkdirSync(p.dir, { recursive: true });
  const next = { ...readJson(p.config), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  fs.writeFileSync(p.config, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export const fwd = (p) => String(p).replace(/\\/g, "/");

function which(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of IS_WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").concat("") : [""]) {
      const f = path.join(dir, name + ext.toLowerCase());
      try { if (fs.statSync(f).isFile()) return f; } catch {}
    }
  }
  return null;
}
export { which };

/** Every place a Chromium-family browser might be, best first. Edge is last: it can sign in to the OS account on its own. */
export function chromeCandidates() {
  const H = os.homedir(), env = process.env, out = [];
  if (env.WEBTAB_CHROME) out.push(env.WEBTAB_CHROME);
  if (env.CHROME_PATH) out.push(env.CHROME_PATH);
  const playwright = (root, rels) => {
    try {
      const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split("-")[1] - +a.split("-")[1]);
      for (const d of dirs) for (const r of rels) out.push(path.join(root, d, r));
    } catch {}
  };
  if (IS_WIN) {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) out.push(path.join(r, "Google", "Chrome", "Application", "chrome.exe"));
    for (const r of roots) out.push(path.join(r, "Chromium", "Application", "chrome.exe"), path.join(r, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"));
    playwright(path.join(env.LOCALAPPDATA || path.join(H, "AppData", "Local"), "ms-playwright"), [path.join("chrome-win64", "chrome.exe"), path.join("chrome-win", "chrome.exe")]);
    for (const r of roots) out.push(path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"));
  } else if (IS_MAC) {
    for (const base of ["/Applications", path.join(H, "Applications")]) {
      out.push(`${base}/Google Chrome.app/Contents/MacOS/Google Chrome`, `${base}/Chromium.app/Contents/MacOS/Chromium`,
        `${base}/Brave Browser.app/Contents/MacOS/Brave Browser`);
    }
    playwright(path.join(H, "Library", "Caches", "ms-playwright"), [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"]);
    out.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    for (const n of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "brave-browser"]) { const f = which(n); if (f) out.push(f); }
    playwright(path.join(env.XDG_CACHE_HOME || path.join(H, ".cache"), "ms-playwright"), ["chrome-linux64/chrome", "chrome-linux/chrome"]);
    for (const n of ["microsoft-edge", "microsoft-edge-stable"]) { const f = which(n); if (f) out.push(f); }
  }
  return out;
}

export function findChrome(cfg = {}) {
  for (const c of [cfg.chrome, ...chromeCandidates()]) if (c && fs.existsSync(c)) return c;
  return null;
}

/** The display scale, so frames are sharp on high-resolution screens. */
export function systemDpr(cfg = {}) {
  const n = Number(cfg.dpr);
  if (cfg.dpr !== "auto" && n > 0) return Math.min(4, Math.max(1, n));
  try {
    if (IS_WIN) {
      const out = execFileSync("reg", ["query", "HKCU\\Control Panel\\Desktop\\WindowMetrics", "/v", "AppliedDPI"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      const m = /0x([0-9a-f]+)/i.exec(out);
      if (m) return Math.min(4, Math.max(1, parseInt(m[1], 16) / 96));
    } else if (IS_MAC) {
      const out = execFileSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8", timeout: 10000 });
      if (/Retina|5K|4K|6K/i.test(out)) return 2;
    } else {
      const s = parseFloat(process.env.GDK_SCALE || process.env.QT_SCALE_FACTOR || "");
      if (s > 0) return Math.min(4, Math.max(1, s));
    }
  } catch {}
  return 1;
}

export function portOpen(port, host = "127.0.0.1") {
  return new Promise((r) => {
    const s = net.connect(port, host);
    s.setTimeout(1500, () => { s.destroy(); r(false); });
    s.on("connect", () => { s.destroy(); r(true); });
    s.on("error", () => r(false));
  });
}

export async function engineStatus(cfg) {
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.httpPort}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** Starts the engine in the background unless it already runs. Resolves to {ok, started, status|error}. */
export async function ensureEngine(home, { timeoutMs = 20000 } = {}) {
  const { cfg, paths: p } = loadConfig(home);
  let status = await engineStatus(cfg);
  if (status?.engine === "webtabd") return { ok: true, started: false, status };
  fs.mkdirSync(p.dir, { recursive: true });
  const child = spawn(process.execPath, [ENGINE, "--app-home", home], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
    status = await engineStatus(cfg);
    if (status?.engine === "webtabd" && status.ready) return { ok: true, started: true, status };
  }
  return { ok: false, started: true, error: `engine did not start within ${timeoutMs / 1000}s; see ${fwd(p.log)}` };
}

/** Stops the engine; with closeBrowser also closes the Chromium it owns. */
export async function stopEngine(home, { closeBrowser = true } = {}) {
  const { cfg, paths: p } = loadConfig(home);
  let token = ""; try { token = fs.readFileSync(p.token, "utf8").trim(); } catch {}
  let stopped = false;
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.httpPort}/quit${closeBrowser ? "?browser=1" : ""}`, { method: "POST", headers: { "x-webtab-token": token }, signal: AbortSignal.timeout(4000) });
    stopped = r.ok;
  } catch {}
  if (closeBrowser) await closeChrome(cfg).catch(() => {});
  for (let i = 0; i < 25 && (await portOpen(cfg.port)); i++) await new Promise((r) => setTimeout(r, 200));
  return { stopped };
}

/** Closes the Chromium on cfg.cdpPort through the DevTools protocol. */
export async function closeChrome(cfg) {
  const ver = await (await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
  await new Promise((resolve) => {
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    const done = () => { try { ws.close(); } catch {} resolve(); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    ws.onmessage = done; ws.onerror = done; ws.onclose = done;
    setTimeout(done, 3000);
  });
}

/** Where --autostart puts the login item on this platform. */
export function autostartFile() {
  const H = os.homedir();
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(H, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "herdr-webtab.vbs");
  if (IS_MAC) return path.join(H, "Library", "LaunchAgents", "dev.herdr.webtab.plist");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(H, ".config"), "autostart", "herdr-webtab.desktop");
}

export const newToken = () => crypto.randomBytes(24).toString("hex");
