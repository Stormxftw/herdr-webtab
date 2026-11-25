## What this changes

<!-- One or two sentences. Link the issue it fixes: "Fixes #12". -->

## Why

<!-- The problem, or what someone can do now that they couldn't before. -->

## How I tested it

<!-- Real output, not "it works". Which tests you ran, what you clicked in Herdr, on which OS.
     Screenshots from `herdr-app shot` help for anything under mods/. -->

- [ ] `npm test` passes locally
- [ ] For changes under `mods/`: `herdr-app check mods/<name>` passes, and I tried it in Herdr (OS: …)

## Checklist

- [ ] A test covers the change (for a bug: it failed before the fix)
- [ ] Tests use throwaway folders and random ports, never a real setup
- [ ] No new dependencies; no personal paths
- [ ] Guard rules: each new or changed rule has catch and near-miss tests in `test/guard.test.mjs`
- [ ] Docs updated (README, `docs/how-it-works.md`, `docs/architecture.md`, `docs/guard.md`, `docs/testing.md` as needed)
- [ ] A line under **Unreleased** in `CHANGELOG.md`

See [CONTRIBUTING.md](../CONTRIBUTING.md) for how we work.
