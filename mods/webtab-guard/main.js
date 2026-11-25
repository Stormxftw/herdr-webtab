// webtab-guard: shows Guard's new alerts as Herdr notifications, then closes itself.
// Guard's agent hook and terminal watcher (mods/webtab/node) write data/webtab/guard/audit.jsonl and
// open this mod (herdr-app do mod.open {"name":"webtab-guard"}); it posts one notification per alert
// it hasn't shown yet. Opening it by hand shows nothing new; it's harmless.
import { View, div } from "gpui-kit";
import { appHome, readTextFile, notify, closeOverlay, props, checking } from "herdr";

const MAX = 4; // a burst shows the newest few and a count, not a wall of toasts

export default class WebTabGuard extends View {
  init(_p, cx) {
    if (checking()) return;
    cx.spawn(async () => {
      try { closeOverlay(props()?.overlay); } catch {}
      let text = null;
      try { text = await readTextFile(`${appHome()}/data/webtab/guard/audit.jsonl`); } catch {}
      const events = String(text || "").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && (e.verdict === "block" || e.verdict === "alert"));
      // Only what came after the newest one shown before; the first time, only the last minute's.
      const last = localStorage.getItem("shown") || "";
      let start = last ? events.findIndex((e) => e.id === last) + 1 : 0;
      if (!last || start === 0) { const i = events.findIndex((e) => Date.now() - Date.parse(e.at) < 60e3); start = i < 0 ? events.length : i; }
      const fresh = events.slice(start).filter((e) => Date.now() - Date.parse(e.at) < 10 * 60e3);
      if (!events.length) return;
      localStorage.setItem("shown", events[events.length - 1].id);
      const shown = fresh.slice(-MAX);
      if (fresh.length > shown.length) notify({ title: "Guard", body: `${fresh.length - shown.length} more alert(s): see data/webtab/guard/audit.jsonl`, level: "warning" });
      for (const e of shown) {
        const who = e.source === "agent" ? (e.agent === "codex" ? "Codex" : "Claude Code") : `Terminal ${e.where || e.terminal || ""}`.trim();
        const did = e.verdict === "block" ? "Guard blocked" : e.source === "agent" && e.agent === "claude" ? "Guard is asking about" : "Guard flagged";
        notify({ title: `${did} a command from ${who}`, body: `${String(e.command || "").replace(/\s+/g, " ").slice(0, 140)}  (${e.why || "a Guard rule"})`, level: e.verdict === "block" ? "error" : "warning", timeout: 12000 });
      }
    });
  }
  render() { return div(); }
}
