# Development and maintenance

- Read README.md, INSTALL.md and TASKS.json before changes.
- Never invent OS data or report unavailable probes as healthy.
- Preserve structured operation diagnostics across runner/helper/API/job storage. Never collapse an inner Git failure into only a runuser exit. Redact known credentials and secret patterns before bounding/persisting output; whitelist diagnostic fields, omit stdin/environment dumps, and keep reports authenticated. Diagnostics must not expand system permissions or execute suggested commands.
- Never run arbitrary shell strings or accept executable paths from HTTP.
- The web process is unprivileged. Root operations belong in helper/helper.py with a root-owned allowlist.
- Require authenticated sessions, same-origin checks and CSRF for every mutation. WebSockets must authenticate and revalidate sessions.
- Keep secrets out of API responses, logs and Git. Tests use temporary data and adapters only.
- Project files must remain within authorized roots; reject symlinks, secret paths and protected runtime data.
- Project folders can be created/opened through the authenticated site under the configured project_root. Do not reintroduce per-project manual helper.json approval. The helper persists these registrations in its private state directory; existing service allowlists remain separate.
- Never alter existing services/firewalls automatically. Protect management access and retain rollback state.
- GitHub App PEM path is pinned to /etc/ubuntu-control/github/app.pem. Only the capability-free ubuntu-github broker may read it. Never grant the web user key access or accept client key paths/content.
- GitHub installation credentials stay in broker/helper/runner memory, use read-only repository-scoped tokens for Git, and travel via anonymous stdin + temporary askpass socket. Never embed credentials in argv, environment values, remotes, Git config, logs or build processes. Validate installation repository membership before each lease.
- Keep Deploy Key projects compatible. Imports/pulls require authenticated CSRF-protected actions and resource locks; configuration/disconnection require password/TOTP reauthentication.
- Upgrade existing servers with scripts/upgrade.sh, not install.sh. Build root-owned source in an isolated staging tree as the service user, back up configuration/SQLite/state, preserve existing service customizations and retain previous code for rollback.
- Run npm test, npm run build, and npm run check:helper after relevant changes. Ubuntu integration must be labeled unverified until tested on Ubuntu.
