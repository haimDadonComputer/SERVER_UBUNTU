# Development and maintenance

- Read README.md, INSTALL.md and TASKS.json before changes.
- Never invent OS data or report unavailable probes as healthy.
- Never run arbitrary shell strings or accept executable paths from HTTP.
- The web process is unprivileged. Root operations belong in helper/helper.py with a root-owned allowlist.
- Require authenticated sessions, same-origin checks and CSRF for every mutation. WebSockets must authenticate and revalidate sessions.
- Keep secrets out of API responses, logs and Git. Tests use temporary data and adapters only.
- Project files must remain within authorized roots; reject symlinks, secret paths and protected runtime data.
- Project folders can be created/opened through the authenticated site under the configured project_root. Do not reintroduce per-project manual helper.json approval. The helper persists these registrations in its private state directory; existing service allowlists remain separate.
- Never alter existing services/firewalls automatically. Protect management access and retain rollback state.
- Run npm test, npm run build, and npm run check:helper after relevant changes. Ubuntu integration must be labeled unverified until tested on Ubuntu.
