# Contributing to Herdr Web Tab

Thanks for helping. This page covers everything you need to send a good change: how the repo is laid
out, how we work, how we test, and what a pull request needs before it's merged.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug** with the [bug form](https://github.com/Stormxftw/herdr-webtab/issues/new/choose).
  The engine log (`~/.config/herdr-app/data/webtab/webtabd.log`) and your OS / Herdr / browser
  versions save a lot of back and forth.
- **Report a Guard rule problem:** a safe command it blocked, or a risky one it missed. Use the
  Guard rule form and paste what `guard-hook.mjs --test "<command>"` prints.
- **Try it on macOS or Linux.** The engine and installer run in CI on all three, but the mod inside
  Herdr has only been tried on Windows. A run through [docs/manual-test.md](docs/manual-test.md)
  on your OS is very welcome, even if everything works.
- **Fix something or add a feature.** For anything bigger than a small fix, open an issue first so
  we can agree on the approach before you spend time on it.
- **Improve the docs.** If something confused you, it will confuse the next person.

Security problems: **don't open a public issue**. See [SECURITY.md](SECURITY.md).

## Getting set up

You need **Node 22+**, **Chrome, Chromium, Brave or Edge**, and for anything under `mods/`, the
**Herdr desktop app**.

```sh
git clone https://github.com/Stormxftw/herdr-webtab
cd herdr-webtab
npm test                 # the whole suite, against a real headless Chrome
node install.mjs         # put your working copy into Herdr (re-run after each change)
```

There's nothing to `npm install`: the engine, installer, Guard and tests use only Node's standard
library.

## How the repo is laid out

| Path | What |
|---|---|
| `mods/webtab/main.js` | The view: the web tab Herdr draws (GPUI). Toolbar, tab strip, dialogs, console strip, observe-only. |
| `mods/webtab/node/webtabd.mjs` | The engine: owns Chromium, streams frames, replays input, detects agents, serves the HTTP API. |
| `mods/webtab/node/common.mjs` | Shared helpers: config, finding a browser, starting and stopping the engine. |
| `mods/webtab/node/mcp.mjs` | The `webtab` MCP server agents run (wraps chrome-devtools-mcp). |
| `mods/webtab/node/guard*.mjs` | Guard: the policy (`guard.mjs`), the agent hook (`guard-hook.mjs`), the terminal watcher (`guardd.mjs`). |
| `mods/webtab-new/`, `mods/new-menu-web/`, `mods/webtab-guard/` | Small helper mods: the palette entry, the + menu row, Guard's notifications. |
| `install.mjs`, `uninstall.mjs` | Put everything in place, and take it all back out. |
| `agents/AGENTS.local.section.md` | The note the installer gives agents in Herdr. |
| `test/` | The automated suite (see below). |
| `docs/` | How it works, the R&D log, the testing log, Guard, upstream issues. |
| `experiments/` | The scripts behind the research and measurements. Not shipped. |

Start with [docs/how-it-works.md](docs/how-it-works.md): it explains every piece, port and file.

## How we work

These are the habits this project was built with. Please keep them.

1. **Understand before changing.** Read the code you're touching and the doc that explains it.
   Reproduce a bug before fixing it.
2. **A failing test first, for every bug.** Write the test that shows the bug, watch it fail, then
   fix it. Most tests in `test/` started this way, and [docs/testing.md](docs/testing.md) says what
   each one caught.
3. **Test against the real thing.** Engine tests drive a real headless Chrome through the same
   socket protocol the mod uses. Don't mock Chrome or CDP: the bugs live in how they really behave
   (see the "front tab only paints" story in [docs/testing.md](docs/testing.md)).
4. **Tests never touch a real setup.** Every test uses a throwaway Herdr app folder, a throwaway
   home folder, a throwaway browser profile and **random free ports**. A test that falls back to the
   default ports (9440, 9441, 9333) can talk to, or close, the browser of whoever runs it. That
   happened once while Guard was being built, and the install test now sets random ports before
   every install.
5. **Measure before deciding.** When a design question has a number behind it (frame rate, how
   long Chromium takes to exit, what a headless build paints), measure it with a script in
   `experiments/` and write down the result in [docs/research.md](docs/research.md) or
   [docs/testing.md](docs/testing.md).
6. **Prove a security test can fail.** For a test that guards a security property, break the code on
   purpose and check the test goes red (see "Testing the tests" in [docs/testing.md](docs/testing.md)).
7. **Small steps, each one working.** A change you haven't run isn't done.
8. **Write down what you learned.** Dropped approaches and surprising behaviour go into the docs,
   not just the commit message.

## Testing

```sh
npm test                                    # everything (about 3 minutes)
node --test test/guard.test.mjs             # one file
WEBTAB_SKIP_MCP_TEST=1 npm test             # offline: skip the test that fetches chrome-devtools-mcp
WEBTAB_MCP_DIR=<dir> npm test               # use an installed chrome-devtools-mcp instead of npx
WEBTAB_DEBUG=1 node mods/webtab/node/webtabd.mjs   # the engine in the foreground, with timings
```

| File | Covers | Needs |
|---|---|---|
| `test/engine.test.mjs` | The engine end to end: frames, input, tabs, dialogs, observe-only, the console strip, agents, recovery, security of the socket and HTTP API | Chrome |
| `test/install.test.mjs` | Install, re-install, uninstall against fake Herdr and home folders, byte-for-byte restore, Guard hook registration | — |
| `test/mcp.test.mjs` | An agent's MCP server starting the engine and driving the browser | Chrome, network (or `WEBTAB_MCP_DIR`) |
| `test/guard.test.mjs` | Every Guard rule: what it catches and the near-misses it must leave alone; rule config; redaction; speed | — |
| `test/guard-hook.test.mjs` | The hook as Claude Code and Codex run it; the terminal watcher against a fake `hc` | — |
| `test/static.test.mjs` | Every script parses, mod manifests, no personal paths, the agent note's markers | — |

CI runs the suite on Windows, macOS and Linux with Node 22 and 24. All six jobs must pass.

**Inside Herdr.** The suite can't see what Herdr draws. For anything under `mods/`:

- run `herdr-app check mods/<name>` after each edit (it renders the mod without a window);
- keep `"place": "none"` in every `mod.json`, or Herdr docks the mod into the person's layout;
- re-run `node install.mjs`, then go through the relevant steps of
  [docs/manual-test.md](docs/manual-test.md). Screenshots (`herdr-app shot`) in the pull request help.

## Changing Guard's rules

Guard is the part most people will want to tune. Every rule in `mods/webtab/node/guard.mjs` needs:

- an **id** that never changes once released (people turn rules off and change severities by id);
- a **severity**: `block` only for things that can't be undone or that leak secrets; `alert` for
  risky but legitimate commands (the agent asks you); `audit` for things worth a log line;
- a plain-language **why**, finishing the sentence "this command …" (it's shown to people and agents);
- **tests in `test/guard.test.mjs`**: commands it must catch, and in the near-miss list, the closest
  safe commands it must leave alone. A test checks that every rule has tests.

Think about false positives as hard as misses: a rule that blocks everyday work gets turned off, and
then it protects nothing. Run `node --test test/guard.test.mjs` until it's green, and keep it fast
(the hook runs before every shell command an agent runs).

## Code style

- **No dependencies.** Node's standard library only. chrome-devtools-mcp is the one download, and
  it's pinned (`MCP_VERSION` in `common.mjs`).
- **ES modules, Node 22+.** Match the style of the file you're in: two-space indent, double quotes,
  semicolons, compact helpers.
- **Comments say why**, not what. If you worked something out the hard way, leave a line for the
  next person.
- **Security rules:** anything new that reaches the page or the browser goes through the
  token-gated view socket or the HTTP API's Origin/Host checks. Only numbers are ever interpolated
  into page scripts. Nothing from a page is trusted.
- **Never write personal paths** (a username, a home folder) into the repo. A test checks.
- **Docs are plain English**: short sentences, no jargon a newcomer wouldn't know.

## Commits and pull requests

- Branch from `main`. Keep each pull request to one change.
- Commit messages: a short summary line in the imperative, prefixed with the area when it helps
  (`Engine: …`, `Guard: …`, `Installer: …`, `Docs: …`), then a body that says why.
- Update the docs your change affects (the README's feature list, [docs/how-it-works.md](docs/how-it-works.md),
  [docs/architecture.md](docs/architecture.md) for protocol changes, [docs/guard.md](docs/guard.md),
  [docs/testing.md](docs/testing.md) for new tests).
- Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
- Fill in the pull request template: what changed, why, and **how you tested it**, with real output.

A maintainer reviews every pull request. We merge when CI is green, the checklist is done, and any
review comments are resolved. If something needs a change in Herdr itself, add it to
[docs/upstream.md](docs/upstream.md) rather than working around Herdr's shipped mods.

## Releases

Releases follow [semantic versioning](https://semver.org/). The version lives in `package.json` and
`VERSION` in `mods/webtab/node/common.mjs`. A release moves the **Unreleased** notes in
`CHANGELOG.md` under the new version, runs the manual test in Herdr, and tags `vX.Y.Z`.

## License

Herdr Web Tab is under the [Apache License 2.0](LICENSE). Contributions you submit are under the
same license (section 5 of the license); you don't need to sign anything else.
