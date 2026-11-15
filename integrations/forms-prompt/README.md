# FORMS_PROMPT: explicit public origin behind the managed proxy

The repository's `server/app.js` explicitly allows only localhost hostnames. DNS or
Nginx configuration cannot enable a public origin in that application. Do not
rewrite public requests to look like localhost or remove its Origin check.

`public-origin.patch` adds the tested `public-access.mjs` middleware and replaces
the existing local-only middleware. It was prepared against `server/app.js` blob
`8047151291cae91cfd1174cad8531b18a2cc45a0` in the repository's default branch.
The adjacent module is a reviewable/tested copy; the patch includes its complete
contents. Applying it is a source-code change in FORMS_PROMPT, not in the live
deployment or the management application.

1. From a local FORMS_PROMPT checkout, run `git apply --check <path-to-public-origin.patch>`
   and then `git apply <path-to-public-origin.patch>`. Commit/push that repository
   through your usual workflow. The patch refuses incompatible source contexts.
2. In SERVER_UBUNTU, add this runtime variable through **protected environment**:
   `PUBLIC_ORIGIN=https://forms-prompt.haimdadon.co.il`. Keep the application
   listening at localhost. No build-variable flag is needed.
3. If the application generates HTML files, add `exports` to its additional data
   directories in Runtime settings; the existing application writes there.
4. Choose **Update and deploy** to use the changed FORMS_PROMPT commit.
5. Create an A record: `forms-prompt` → the configured server IPv4 address. In
   project publication select `forms-prompt.haimdadon.co.il`; HTTPS/443 are automatic.

With no PUBLIC_ORIGIN the application remains local-only. With the setting, only
that exact HTTPS origin is added. Other hosts and cross-origin browser requests
remain rejected. Nginx replaces forwarded headers and Express trusts only the
loopback proxy, following the [Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/).

The existing FORMS_PROMPT code has no user authentication for its forms API.
Allowing its public origin makes its forms management accessible to visitors;
hostname/Origin checks are not a login mechanism. This patch does not add users
or passwords. No changes have been pushed to that repository or deployed by this
integration artifact.
