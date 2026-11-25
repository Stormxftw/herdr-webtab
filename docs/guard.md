# Guard

Guard checks the shell commands run in Herdr against a small policy, and stops or flags the ones that
are hard to take back. It ships with Herdr Web Tab and installs with it (`node install.mjs`; skip it
with `--no-guard`).

It's our take on [StructuPath's herdr-guard](https://github.com/StructuPath/herdr-guard), which is
built for the legacy Herdr TUI. This version works with the Herdr desktop app, and it makes the
agent hook its main line of defence.

## What it does

| Where the command comes from | What Guard sees | What it can do |
|---|---|---|
| **Claude Code** (Bash, and PowerShell on Windows) | the exact command, before it runs | **block** it, or **ask you first** |
| **Codex** (Bash) | the exact command, before it runs | **block** it, or **warn** (Codex hooks can't ask) |
| **A shell in a Herdr terminal** (PowerShell, cmd, bash, zsh, fish…) | the command line after you press Enter | **alert and log** only, never type into your terminal |
| An agent's own TUI screen, logs, builds | nothing | the hook covers agents |

Every rule has a severity:

| Severity | Agent hook | Terminals |
|---|---|---|
| `block` | denied; the agent is told why and not to work around it | alert |
| `alert` | Claude Code asks you; Codex shows a warning | alert |
| `audit` | runs | logged only |

An alert is a Herdr notification (drawn by the `webtab-guard` mod) and a line in the audit log.

## The shipped rules

**Blocked:** wiping a disk, a drive, a home folder or "everything here" (`rm -rf /`, `rm -rf ~`,
`Remove-Item -Recurse C:\`, `rd /s /q C:\`, `format`, `mkfs`, `dd of=/dev/sda`, `diskpart`),
`chmod -R` on `/`, fork bombs, force-pushing `main`/`master`, `gh repo delete`, sending a private key
or secrets file to the network, piping your environment variables to the network.

**Asks first (alert):** other force-pushes, deleting a remote branch, making a repo public,
publishing (`npm`/`pnpm`/`yarn`/`bun`/`cargo publish`, `twine upload`, `docker push`,
`gh release create`, …), destroying cloud or cluster resources (`terraform destroy`,
`kubectl delete namespace`, `aws … delete-*`, `helm uninstall`, …), `DROP`/`TRUNCATE` through a
database client, reading private keys and secrets files (`~/.ssh/id_*`, `.env`, `~/.aws/credentials`,
`~/.codex/auth.json`, …), running scripts straight from the internet (`curl … | bash`, `iwr … | iex`),
encoded/hidden commands, changing Guard's own files, stopping Herdr, shutting the computer down,
deleting from the registry.

**Logged:** `rm -rf` of anything else, `Remove-Item -Recurse -Force`, `git reset --hard`,
`git clean -fdx`, `--force-with-lease` pushes, clearing shell history.

Every rule is tested on what it should catch and on near-misses it must leave alone
(`test/guard.test.mjs`): `cat ~/.ssh/id_rsa.pub`, `git push origin main`, `npm run publish-docs`, a
commit message that *mentions* `rm -rf /`, and so on.

### How a command is read

Guard reads a command roughly the way a shell would, so it neither misses the obvious nor blocks a
commit message:

- it checks each command in a chain (`;`, `&&`, `||`, `|`), with `sudo`, `env X=1` and the like in front;
- quoted text with spaces in it (messages) and heredoc bodies are skipped; short quoted words
  (paths: `rm -rf "/"`) are kept;
- text a shell is asked to run is read as a command: `bash -c "…"`, `powershell -Command "…"`,
  `eval '…'`, a heredoc fed to `bash`.

It's still a text policy, not a sandbox. Someone determined to hide a command from it can. It's there
to catch the destructive mistake, the leaked key and the surprise publish.

## Your rules

`<appHome>/data/webtab/guard/rules.json` (the installer creates it):

```json
{
  "disabled": ["publish"],
  "severity": { "git-force-push": "block", "secret-read": "audit" },
  "rules": [
    { "id": "no-prod", "pattern": "--env[= ]prod", "severity": "block", "why": "touches production" }
  ],
  "watchTerminals": true
}
```

- `disabled`: shipped rule ids to switch off (ids are in `mods/webtab/node/guard.mjs`).
- `severity`: change a shipped rule's severity.
- `rules`: your own; `pattern` is a JavaScript regex (case-insensitive unless you give `flags`), and
  `"raw": true` matches the command exactly as written (quoted text included).
- `watchTerminals: false` turns the terminal watcher off.

Changes apply to the next command; nothing needs restarting. A file that isn't valid JSON is ignored
(the shipped rules apply) rather than switching Guard off.

Try a command without running it:

```sh
node ~/.config/herdr-app/mods/webtab/node/guard-hook.mjs --test "git push -f origin main"
```

## The audit log

`<appHome>/data/webtab/guard/audit.jsonl`, one JSON object per line: when, where from (agent and
which, or terminal and which), the verdict, the rules, the folder, and the command. Tokens, passwords,
`Authorization` headers and passwords in URLs are replaced by `***` before anything is written. The
file rolls over to `audit.jsonl.old` at 1 MB.

```sh
node ~/.config/herdr-app/mods/webtab/node/guard-hook.mjs --recent 20
```

## The pieces

| File | Job |
|---|---|
| `mods/webtab/node/guard.mjs` | The policy, the command reader, the log, hook registration helpers. Pure, no dependencies. |
| `mods/webtab/node/guard-hook.mjs` | The PreToolUse hook Claude Code and Codex run. Decides in-process, so there's no daemon to be down. |
| `mods/webtab/node/guardd.mjs` | The terminal watcher: polls `hc ls` / `hc read` every 2 s, picks out prompt lines, checks new ones. |
| `mods/webtab-guard/` | Opened by the other two after an alert: posts the notifications, then closes. |

**What the installer changes for Guard:** a `PreToolUse` entry in `~/.claude/settings.json` (matcher
`Bash|PowerShell`) and in `~/.codex/hooks.json` (matcher `Bash`), next to any hooks you have (a
`.before-webtab` backup is kept); the rules file; and it starts the watcher. `uninstall.mjs` removes
only Guard's entries.

**Codex** runs hooks only when `[features] hooks = true` is set in `~/.codex/config.toml`, and only
after you trust a new hook once (`/hooks` in Codex). The installer tells you if hooks are off; it
doesn't change that setting for you.

**When the watcher runs:** it starts with the installer, the web tab engine, and the first command an
agent runs through the hook. After a reboot, use `node install.mjs --autostart` (the engine starts at
login and brings the watcher), or it starts the first time one of those happens. Only one runs at a
time.

## Limits

- **Terminals: alert, not prevention.** Guard sees a command after you press Enter. It never types
  into your terminal or sends Ctrl+C, because you're in charge there.
- **Agents in a terminal:** commands an agent runs go through its hook. The watcher only reads shells.
- **Fails open on its own bugs.** If the hook crashes or gets input it can't read, the command goes
  through and the error is logged. An agent must never be stuck because Guard broke.
- **Same-user processes** can edit or stop Guard. Changing its files is an `alert` rule, so an agent
  has to ask you first, but it isn't a security boundary.
