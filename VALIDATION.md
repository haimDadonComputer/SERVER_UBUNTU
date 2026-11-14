# Verification record — 2026-11-14

Environment: Windows, Node.js 24.11.1, Python 3.14, installed Microsoft Edge. No Ubuntu/Hetzner server credentials or connection were supplied.

Passed locally:

- `npm run build`: TypeScript check and Vite production bundle.
- `npm test`: 8 Node tests covering encryption integrity, secret redaction, path restrictions, normal file operations, hardlink rejection, idle expiry, queue conflict/failure, authenticated API, CSRF, Argon2 login, persistent lockout, TOTP and encrypted SQLite backup.
- `npm run check:helper`: 13 Python tests with mocked system adapters, including `ss` IPv4/IPv6/UDP parsing, allowlists, protected services/ports, CIDR validation, UFW inactivity rejection, failed service startup, dual-stack/cloud rollback, repository validation, dirty worktrees, changed remote commits and expired QR payloads.
- `npm run test:ui`: one Edge end-to-end scenario covering login against a real temporary SQLite session, honest unavailable-system states, RTL, project modal, navigation, dark/light mode, mobile overflow and JavaScript errors. Desktop/mobile screenshots inspected.
- `bash -n scripts/install.sh` using Git Bash; Python helper syntax compilation.
- npm dependency audit reported zero known vulnerabilities at installation time.

Not verified locally:

- Linux-only file-descriptor anchoring and symlink race resistance (Windows test skips symlink creation; Linux CI is supplied but was not run here).
- Installer execution, systemd sandbox restrictions, Unix socket peer credentials and actual service actions.
- Real UFW/Hetzner changes, network reachability and watchdog recovery under real outages.
- Live GitHub clone/deployment, private Deploy Key authentication, rootless Docker, PM2 and Chromium/WhatsApp QR connectivity.
- Remote TLS/VPN setup, reboot behavior, real resource load and restore of an operational server.

Run the acceptance checklist in INSTALL.md on a disposable Ubuntu 24.04 server before operational use. Build success and mocks do not certify a production deployment.
