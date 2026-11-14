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

## Installer permission fix — 2026-11-14

The source copy performed under `umask 077` could leave root-owned files at 0600 and directories at 0700. Removing group/other write bits did not give the service user read/traverse access. The installer now sets source files to 0644 and directories to 0755 before running npm, grants temporary ownership only of node_modules/dist, and restores root ownership plus read/execute access without non-root writes afterwards. Configuration secrets and runtime directory permissions are outside this normalization.

Re-run locally after this change: 8 Node tests, 13 Python tests and the production build passed. Bash syntax checks passed for the installer, its shared permission functions and the regression test; `git diff --check` passed. Shell files are pinned to LF in .gitattributes.

`tests/install-permissions.sh` adds a real Linux UID/permission test using an isolated temporary tree and the existing nobody account. It runs offline npm ci/prune, asserts source/helper/service-template writes are denied, verifies writable build directories, then checks locked runtime modules and executable dependency bins. It also checks that a private file outside the application tree stays unreadable. This test is wired into Ubuntu 24.04 GitHub Actions. It was **not executed locally**: this Windows host has no WSL distribution or running Docker Linux engine. The complete installer was not executed on a clean Ubuntu host in this session.

## Website-created project folders

Projects no longer require individual helper.json entries. The authenticated API calls the restricted project-create helper action. The helper creates or opens a direct child of the configured project root and persists registrations in private root-owned projects.json state. Existing static projects retain their settings. System service authorization, authentication, CSRF, path restrictions and secret protection remain separate.

Checks cover two project registrations, duplicate rejection, CSRF and traversal rejection, persisted-registry adapter behavior, legacy compatibility, invalid settings, and project roots outside the configured base. The Edge browser test creates two projects and creates/edits a file through the site, using a temporary folder adapter; other Ubuntu operations still report unavailable. Actual mkdir/chown/setgid/default-ACL behavior under the helper systemd sandbox has not been exercised on Ubuntu. The updated helper unit includes CAP_FSETID for setgid directory setup.
