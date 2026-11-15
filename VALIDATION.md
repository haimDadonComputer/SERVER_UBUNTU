# Verification record — 2026-11-14

## Scoped persistent upload/data storage for Node — 2026-11-15

Node-only change; Docker launcher behavior was retained as requested. Added automatic nested upload/uploads discovery, explicit additional data directories in runtime and versioned project configuration, stable private StateDirectory mappings, read-only root-owned runtime projections, noexec and ordinary CJS/ESM load restrictions. Data migration preserves originals and rejects conflicts/links; updates/rollback retain the catalog and persistent stores. Managed proxy and source-file API block direct storage access. Upgrade prepares root directories and defers adoption until explicit activation; acceptance-runtime.py now tests nested storage, missing data, code immutability, noexec, module denial and data preservation.

Local checks: 25 Node tests passed; 111 Python tests ran, 101 passed and 10 POSIX/root/systemd checks skipped on Windows. Production build and focused project lifecycle UI test passed, including the additional-data field and existing environment/console/archive flows. Bash upgrade syntax and diff whitespace checks passed. No screenshots were used.

No Ubuntu/Contabo integration was run here. Descriptor-anchored copying, real DynamicUser ownership/bind/noexec behavior and reboot recovery require the updated Ubuntu acceptance test and operator verification. Loader/proxy policy does not sandbox malicious app code or authenticate custom download routes; that limit is documented explicitly in INSTALL.md.

## Content organization and responsive styling — 2026-11-15

Preserved the application header/sidebar and reorganized content: project summaries and status filters, primary actions versus native expandable management/Git/release sections, topic-based settings, filtered jobs and readable event timelines. Network forms, cards and tables share content-only spacing and responsive rules. Existing pending DNS diagnostic changes were preserved.

`npm run build` passed. Both existing Playwright flows passed after adapting navigation assertions: desktop/session/settings/GitHub/jobs and project runtime/private ENV file import/console/archive/restore. Assertions cover hidden advanced controls, persistent task drawer, default settings category, category switching, job filtering, light theme and mobile overflow. No screenshots were captured. Backend behavior was not changed for this redesign; no server deployment or Ubuntu integration was performed.

## Task panel, ENV import and public publication — 2026-11-15

Local Windows verification: `npm test` passed 24 tests; `npm run check:helper` ran 98 tests, 92 passed and 6 Linux-only tests skipped. `npm run build` passed. The focused Playwright `project runtime` case passed, including the persistent task drawer, no navigation to Jobs, npm-install default, private ENV file preview/merge and console/archive behavior. Screenshot calls were removed; validation used DOM assertions. Bash syntax checks for setup-publication.sh, reload-publication.sh and upgrade.sh passed using Git Bash; `git diff --check` passed.

Coverage includes framed/split helper progress, incomplete-response rejection, bounded redacted event history, ENV grammar/empty-value semantics and authenticated import, exact management origins and link isolation, npm policy compatibility, Nginx rollback and first-publication challenge cleanup, existing UFW rule ownership including later UFW activation, scoped proxy resources, localhost service ownership, rootless Docker label/image/port binding and rejection of wildcard listeners that could bypass HTTPS.

System commands, certificates and proxy changes in unit/API tests use mocks and temporary directories. No Contabo server was accessed. Actual Ubuntu Nginx/systemd sandbox behavior, Certbot issuance/renewal, DNS, public IP reachability and Contabo firewall handling remain unverified; follow the acceptance steps in INSTALL.md with a test project before enabling real public access. The existing new-borny-box database connection/build error is outside this change.

## Detailed diagnostics — 2026-11-15

Added structured redacted records across command/runner/helper/API/SQLite and expandable frontend reports with copy/download. Git failures retain original command, stage, exit code and sanitized stdout/stderr instead of a generic runuser failure; launcher metadata is separate. GitHub HTTP diagnostics carry status/request ID without response bodies or authorization headers. Existing job rows survive the additive error_details column migration, and old generic errors remain explicitly without recoverable detail.

Local checks: 13 Node tests and 40 Python tests passed (one POSIX-only Git test skipped); production Build and browser QA passed. New tests cover known opaque tokens, quoted credentials/PEM removal before truncation, field allowlisting, nested runuser protocol, permissions, timeout/missing executables, persisted reports after database reopen, and API forwarding. Browser QA injects a helper Git authentication failure, expands its report, downloads a redacted JSON report and verifies diagnostics persist after page reload. This is a mock failure, not a diagnosis of the user's live import failure. No privileges/capabilities were broadened and no server was accessed.

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

## Project lifecycle — 2026-11-15

Local verification on Windows: 22 Node tests passed; Python ran 69 tests with 64 passed and 5 POSIX-only checks skipped; 2 Edge browser scenarios passed; TypeScript/Vite production build passed. Bash syntax and Python compilation checks passed. `git diff --check` passed. Browser screenshots were inspected for runtime settings, archive and mobile project layout. No dependency changes were required.

New tests exercise authenticated lifecycle routes, CSRF and password reauthentication, secret metadata and partial updates, queued duplicate rejection, additive schema preservation, archive/restore/purge API behavior with adapters, audit/job retention and filtered log downloads. WebSocket tests use a real local pipe/socket with mock journal records: shared source, cursor replay, unsubscribe, redaction, backpressure gaps and expired-session rejection. Scheduler checks cover ETag/unchanged SHA, minute interval, max-two checks, manual/archived exclusions, stopped-project authority, failed-SHA suppression, newer-commit retries, backoff/Retry-After, coalescing queued commits and helper reconciliation.

Python adapter tests cover typed launch settings, forbidden environment names and atomic updates, public-build separation, generated DynamicUser/LoadCredential units, rootless prerequisites and dangerous mounts, project locks and firewall exclusion, cgroup-scoped transient builders, health ownership and 20-second process stability, rollback and recovery verification, durable root journals, interrupted deployment recovery, boot rehydration policy and bounded console queues. POSIX-only tests cover local snapshot symlinks/permissions, archive/environment/data preservation, restore conflicts, scoped purge rejection and real Git askpass; those five are skipped on Windows and remain in Ubuntu CI. Existing security/GitHub/deployment diagnostics tests continue to pass.

Ubuntu integration is **pending**. Local tests mock systemd/Docker/GitHub; they do not prove DynamicUser mounts, LoadCredential, transient build cleanup, rootless Docker, real rollback, shared external service handling or actual reboot on Contabo. `scripts/acceptance-runtime.py` and its `--docker` option prepare isolated operator-run runtime tests against the installed helper. INSTALL.md includes further GitHub delivery, background-worker, console load/reconnect, reboot, shared-resource and name-conflict acceptance checks. Do not enable automatic updates for real projects until those server checks pass. No remote upgrade or deployment was performed in this session.

## Non-root upgrade test isolation fix

The first server upgrade reported two Python failures: static-project and invalid-settings fixtures omitted state_dir, so the new recovery guard probed the real root-only helper directory. The staging checks run correctly as ubuntu-control and stopped before installation replacement. The subsequent acceptance command therefore imported the previous installed helper, where project_lifecycle was unavailable. Production permissions and the recovery guard remain unchanged.

All project fixtures now use temporary state directories, and a cross-platform filesystem guard fails tests that probe the live helper state. A regression test verifies pending recovery still blocks project creation in isolated state. Acceptance preflight checks all required installed modules before imports or resource creation and explains that upgrade.sh must finish successfully; it never falls back to checkout helper code. Two preflight tests cover old and complete installations without executing their modules.

Rechecked locally: 22 Node tests passed; Python ran 72 tests, 67 passed and 5 POSIX-only tests skipped; production build passed. The server retry and real Ubuntu runtime acceptance remain pending.

## Generated WorkingDirectory fix and acceptance diagnostics

The server journal identified the first real runtime failure: JSON quotes around WorkingDirectory were treated literally by systemd 255, so the path was rejected as non-absolute. The generator now emits an unquoted scalar path, keeps quoting for list directives, and escapes percent specifiers. Regression checks assert the scalar form, whitespace/specifier behavior, and use systemd-analyze verify on Linux without starting services. This Linux parser check is skipped on Windows.

Acceptance now prints and privately stores redacted structured primary and cleanup errors separately, preserves resources when recovery is pending, and reports PASS only after cleanup succeeds. A narrowly scoped --cleanup-state option recovers and removes a single verified root-private acceptance fixture; it never accepts normal project IDs or arbitrary paths. First-deployment rollback confirms a bad-setting/not-found unit is inactive before treating a failed stop as harmless; ambiguous or active states retain the recovery journal.

Local checks after this fix: 22 Node tests and the production build passed; Python ran 79 tests, 73 passed and 6 Linux/POSIX checks skipped. The systemd parser regression is included in the Ubuntu CI test run, but was not executed on this Windows host. The corrected unit still needs runtime acceptance on Contabo; the provided server journal establishes the old quoting failure, not a successful deployment of this fix.

## BindPaths separator fix

The next Contabo acceptance run reached unit startup but failed with 226/NAMESPACE. The journal showed systemd treating the whole source:destination pair as a single source filename because the generator quoted the complete pair. BindPaths now quotes each component separately, exposing the separator. The private StateDirectory, persistent-data location, credentials, read-only source and service isolation are preserved.

A regression covers spaces and percent specifiers. The Linux systemd parser test now inspects the parsed BindPaths mapping from the debug dump; a zero syntax-check exit code alone cannot detect the old valid-but-unintended filename. Local Node/Python/build results are recorded with this fix; actual corrected mount/startup still requires the Ubuntu acceptance rerun. The user's failed run reported only a retained diagnostic directory and no cleanup failure, so the isolated test resources were cleaned while the redacted report remains.

Verified locally: 22 Node tests passed; Python ran 80 tests with 74 passed and 6 Linux/POSIX checks skipped; production build, Python compilation and diff whitespace checks passed. No service security settings or filesystem permissions were relaxed.

## Project navigation, IP links, console status and missing npm lockfiles

Removed automatic navigation to Jobs after lifecycle operations, runtime configuration and GitHub imports. Projects can open an explicitly saved HTTP(S) link or an IPv4/port URL derived from actual server interfaces for HTTP runtimes with remote listening enabled. URL writes require session/CSRF, reject credentials/script protocols and reject the management hostname across ports to avoid forwarding control cookies. Runtime listenAddress is typed and defaults to localhost; remote IPv4 binding is explicit and changes neither UFW nor cloud firewall rules. The source application's Node server must honor HOST/PORT.

Console history read failures are displayed, service state and the latest scoped job are fetched, empty output is distinguished from a failed/stopped service, and HTTP history fallback polls at five-second intervals only while the console is visible and the WebSocket is disconnected. Per-project latest-job metadata is not persisted into the helper mirror. Job ordering breaks same-second timestamp ties by rowid. A TCP health ownership probe now requests TCP+UDP ss output so Netid matches the existing parser; UDP records cannot prove HTTP ownership.

Missing npm lockfiles produce NPM_LOCKFILE_MISSING with recovery guidance. An explicit runtime policy allows npm install in the release when no npm lockfile exists; existing package-lock/npm-shrinkwrap continues to select ci. Root source/Git state, credentials and default policy are preserved. Tests cover locked/fallback selection, runtime policy validation, URL security/migration, navigation staying in place, IP links, visible deployment errors with no runtime logs and HTTP console updates. Runtime IP reachability and actual deployment of the user's repository remain pending on Ubuntu.

Local verification: 22 Node tests, 77 Python tests (83 total, six platform skips), production build and two Edge scenarios passed. The browser scenarios exercise automatic IP links from a network-interface fixture, custom IP URLs, install-policy selection, staying on Projects after configuration/import, and console error/HTTP fallback rendering. No live Contabo binding, firewall reachability or repository deployment was performed by this local change.
