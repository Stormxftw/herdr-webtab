// webtab-new: opens a new web tab with props of its own, then closes itself.
// The command palette's "New web tab" (and keys.json) open this as an overlay: a palette entry has
// fixed arguments, but each web tab needs its own props id so its saved state stays its own.
import { View, div } from "gpui-kit";
import { run, closeOverlay, props, spaces, checking } from "herdr";

export const newWebTab = (url) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const space = spaces().find((s) => s.active)?.id;
  return run("tab.new", { name: "🌐 Web", mod: "webtab", props: url ? { id, url } : { id }, ...(space ? { space } : {}) });
};

export default class WebTabNew extends View {
  init(_p, cx) {
    if (checking()) return;
    cx.spawn(async () => {
      try { closeOverlay(props()?.overlay); } catch {}
      await newWebTab(props()?.url || null);
    });
  }
  render() { return div(); }
}
