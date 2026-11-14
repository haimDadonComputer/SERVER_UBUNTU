# Verification record — 2026-11-14

## Ubuntu Python command fix — 2026-11-15

User-provided Ubuntu upgrade output confirmed npm ci and all 11 Node tests passed, then the staging helper check stopped because the legacy npm script invoked `python`, which is not installed as an alias on Ubuntu 24.04. Added scripts/check-helper.mjs: it runs python3 on POSIX and python on Windows using argument-array spawnSync, anchors the test working directory to the project root, inherits the environment and propagates a nonzero failure status. No global alias, package installation or privilege change is required. The reported failure happened before the upgrade stopped services or replaced live code. Subsequent local checks are run on Windows; continuation of the full Ubuntu upgrade still requires the user's server.

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

## GitHub App upgrade

Local verification: 11 Node tests passed; Python ran 35 tests with 34 passed and one POSIX-only real-Git askpass test skipped on Windows; the Edge browser scenario passed and the TypeScript/Vite production build passed. Bash syntax checks passed separately for install.sh, install-permissions.sh, github-access.sh, upgrade.sh and the installer-permissions test. The SQLite migration test starts with an existing project/settings schema and confirms that adding GitHub metadata preserves legacy project/service/repository data and settings.

New checks use a mocked GitHub API and cover RS256 JWT claims/signing invocation, all-page repository enumeration, repository-scoped read-only token requests, cache renewal before expiry, one-time refresh after 401, 401/403/404/429 sanitization, disconnect/revocation, key rotation, arbitrary key-path rejection, and repositories outside the installation. PEM content, JWTs and tokens are absent from public status and persisted JSON. Tests assert token transport uses stdin, not command arguments/environment, and that the temporary askpass responder rejects other hosts/repositories. Deploy Key projects bypass the broker. Pull tests require clean local state, preserve a backup ref and enforce fast-forward only.

Authenticated API checks cover CSRF, password reauthentication on GitHub configuration, rejection of arbitrary PEM paths, imports as queued actions, duplicate-action rejection and persistence of the selected GitHub repository ID. Browser QA uses a private/public repository fixture and imports a private repository through the real application API with a temporary helper adapter. This is not an actual GitHub connection or clone.

Not executed here: live GitHub App signing with the user's PEM, actual GitHub token issuance or revocation, the dedicated systemd broker/peer credentials/PEM ACLs, Contabo deployment, and execution/automatic recovery of upgrade.sh on Ubuntu. The upgrade script passed syntax review only; its staged build and health checks must run on the target host. No server, private key, existing database or project was changed by this local task. The Linux Git credential-fill test and Linux installer-permission test are available in CI; their remote results were not observed in this session.
