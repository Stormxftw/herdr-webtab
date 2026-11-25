# Security

Herdr Web Tab runs a browser that coding agents can drive, so it treats web pages as hostile:

- every port listens on 127.0.0.1 only;
- the mod socket requires a random token stored in `<appHome>/data/webtab/token` (mode 600);
- the HTTP API rejects requests with `Origin` or a non-`none` `Sec-Fetch-Site` header and checks
  `Host`;
- Chromium runs without `--remote-allow-origins`, so pages can't open its DevTools websocket;
- page scripts the engine evaluates only ever have numbers interpolated into them.

Local programs running as you can reach the DevTools port; that's the point (agents use it). Don't
sign in to accounts in the web tab that you wouldn't let your agents use.

**Guard** (see [docs/guard.md](docs/guard.md)) adds a check on agents' shell commands and an alert on
risky commands typed into Herdr's terminals. It is a text policy, not a sandbox: it fails open on its
own errors (logged), and a process running as you can change or stop it. Its rules and audit log
live in `<appHome>/data/webtab/guard/` (mode 600); the log never holds tokens, passwords or
`Authorization` headers. A web tab in observe-only mode drops the person's input in the engine, not
just in the view.

**Reporting:** please use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability) rather than a public issue.
