// Herdr's + menu with a "Web tab" row. It extends base.js, a copy of the shipped new-menu that
// install.mjs takes from your own Herdr (mods can't import another mod), so re-run the installer
// after a Herdr update. Your tab bars only use this menu if you installed with --menu.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, spaces, run, closeOverlay, props } from "herdr";
import NewMenu from "./base.js";

export default class NewMenuWeb extends NewMenu {
  render(cx) {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const open = () => {
      closeOverlay(props().overlay);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      run("tab.new", { name: "🌐 Web", mod: "webtab", props: { id }, ...(space ? { space: space.id } : {}) });
    };
    const row = h_flex().id("webtab").h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(t.foreground).hover((s) => s.bg(t.selected)).cursor_pointer().on_click(open)
      .child(div().w(14).text_size(13).child("🌐")).child(div().flex_1().child("Web tab")).child(div().text_size(11).text_color(t.dim).child("browser"));
    const menu = super.render(cx);
    // The base menu sizes itself to its rows; make room for one more. If a Herdr update renames
    // what this reads, the row still shows and the menu just scrolls.
    try {
      const installed = (this.agents || []).filter((a) => a.installed);
      const choices = this.failed ? installed : [...installed, ...(this.agents || []).filter((a) => !a.installed).slice(0, 2)];
      menu.h(Math.min(491, 167 + Math.max(1, choices.length + (this.failed ? 1 : 0)) * 31) + 42);
    } catch {}
    return menu.child(div().h(1).mx(4).my(5).bg(t.border)).child(row);
  }
}
