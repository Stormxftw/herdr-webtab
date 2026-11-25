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

**Reporting:** please use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability) rather than a public issue.
