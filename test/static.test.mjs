// Cheap checks that run everywhere: syntax, manifests, and no personal paths in the repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const files = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    e.isDirectory() ? files(p, out) : out.push(p);
  }
  return out;
};
const all = files(".");

test("every script parses", () => {
  for (const f of all.filter((f) => /\.(mjs|js)$/.test(f))) execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
});

test("mod manifests are valid and never dock themselves into a layout", () => {
  for (const m of ["webtab", "webtab-new", "webtab-guard", "new-menu-web"]) {
    const j = JSON.parse(fs.readFileSync(path.join("mods", m, "mod.json"), "utf8"));
    assert.equal(j.place, "none", m);
  }
  const palette = JSON.parse(fs.readFileSync("mods/webtab/mod.json", "utf8")).palette;
  assert.deepEqual(palette[0].args, { name: "webtab-new" });
});

test("no personal paths or machine names leak into the repo", () => {
  const bad = /[A-Z]:[\\/](Users|HermesData)[\\/]|\/Users\/[a-z]+\/|guita|Josephshaw/i;
  for (const f of all.filter((f) => !/\.(png|jpg|gif)$/.test(f) && !f.endsWith("static.test.mjs"))) assert.doesNotMatch(fs.readFileSync(f, "utf8"), bad, f);
});

test("the agent note keeps its markers so the installer can rewrite it", () => {
  const s = fs.readFileSync("agents/AGENTS.local.section.md", "utf8");
  assert.match(s, /^<!-- herdr-webtab:start/);
  assert.match(s.trim(), /<!-- herdr-webtab:end -->$/);
});
