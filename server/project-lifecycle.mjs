import { z } from 'zod';
import { audit } from './db.mjs';
import { networkInterfaces } from 'node:os';
import { storedDetails } from './diagnostics.mjs';
export function projectView(row) {
    let state = {};
    try {
        state = JSON.parse(row.lifecycle_json || '{}');
    } catch {}
    return {
        ...row,
        ...state,
        id: row.id,
        name: row.name,
        lifecycle: state.lifecycle || 'active',
        updates: state.updates || 'manual',
    };
}
export async function reconcileProjects(db, helper) {
    const records = await helper('project-records');
    if (!Array.isArray(records)) return;
    const update = db.prepare('UPDATE projects SET lifecycle_json=? WHERE id=?');
    for (const record of records) {
        if (record.lifecycle === 'deleted')
            db.prepare('DELETE FROM projects WHERE id=?').run(record.id);
        else update.run(JSON.stringify(record), record.id);
    }
}
const runtime = z.object({
    kind: z.enum(['node', 'docker']),
    mode: z.enum(['npm', 'entry']).optional(),
    script: z.string().max(80).optional(),
    entry: z.string().max(300).optional(),
    args: z.array(z.string().max(1024)).max(40).default([]),
    port: z.number().int().min(1024).max(65535).nullable().optional(),
    health: z.enum(['http', 'process']),
    healthPath: z.string().max(200).default('/'),
    autostart: z.boolean().default(false),
    testScript: z.string().max(80).default(''),
    buildScript: z.string().max(80).default(''),
    dependencyInstall: z.enum(['locked', 'allow-install', 'install']).default('install'),
    listenAddress: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
    internalPort: z.number().int().min(1).max(65535).optional(),
    dataPath: z.string().max(200).optional(),
    storageDirectories: z.array(z.string().min(1).max(400)).max(64).default([]),
});
export function registerLifecycle({
    app,
    db,
    helper,
    queue,
    sessionUser,
    origin,
    origins = () => [origin],
}) {
    app.get('/api/project-access', async (_req, res) => {
        const addresses = Object.entries(networkInterfaces()).flatMap(([name, items]) =>
            (items || [])
                .filter((i) => !i.internal && i.family === 'IPv4')
                .map((i) => ({ address: i.address, interface: name }))
        );
        if (origin && new URL(origin).hostname.endsWith('.ts.net'))
            addresses.sort(
                (a, b) =>
                    Number(b.interface.startsWith('tailscale')) -
                    Number(a.interface.startsWith('tailscale'))
            );
        let publicationStatusKnown = true;
        const network = await helper('network-status').catch(() => {
            publicationStatusKnown = false;
            return {};
        });
        publicationStatusKnown =
            publicationStatusKnown && !!network?.projects && typeof network.projects === 'object';
        const managementHosts = [
            ...new Set([
                ...origins().map((value) =>
                    new URL(value).hostname.toLowerCase().replace(/\.$/, '')
                ),
                ...(network.domain ? [network.domain.toLowerCase().replace(/\.$/, '')] : []),
            ]),
        ];
        if (network.ip) addresses.unshift({ address: network.ip, interface: 'configured-public' });
        res.json({
            addresses,
            publications: network.projects || {},
            managementHosts,
            publicationStatusKnown,
        });
    });
    const save = (record) => {
        if (record?.id)
            db.prepare('UPDATE projects SET lifecycle_json=? WHERE id=?').run(
                JSON.stringify(record),
                record.id
            );
    };
    const enqueue = (req, res, action, args = {}) => {
        const id = req.project.id,
            user = req.session.username;
        const job = queue.add(
            'project:' + id,
            async (stage) => {
                stage(action);
                const record = await helper(action, { project: id, ...args }, stage);
                if (action === 'project-purge')
                    db.prepare('DELETE FROM projects WHERE id=?').run(id);
                else save(record);
                audit(db, user, action, id);
            },
            action
        );
        res.status(202).json({ job });
    };
    app.get('/api/projects/:project/lifecycle', async (req, res) => {
        const state = await helper('project-state', { project: req.project.id });
        save(state);
        const job = db
            .prepare('SELECT * FROM jobs WHERE resource=? ORDER BY rowid DESC LIMIT 1')
            .get('project:' + req.project.id);
        const { error_details, ...lastJob } = job || {};
        res.json({
            ...state,
            lastJob: job ? { ...lastJob, details: storedDetails(error_details) } : null,
        });
    });
    app.get('/api/projects/:project/options', async (req, res) =>
        res.json(await helper('project-options', { project: req.project.id }))
    );
    app.get('/api/projects/:project/port-check', async (req, res) => {
        const input = z
            .object({
                port: z.coerce.number().int().min(1024).max(65535),
                listenAddress: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
            })
            .parse(req.query);
        res.json(await helper('project-port-check', { project: req.project.id, ...input }));
    });
    app.get('/api/projects/:project/logs', async (req, res) =>
        res.json(
            await helper('project-log-history', {
                project: req.project.id,
                cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
            })
        )
    );
    app.get('/api/projects/:project/logs/download', async (req, res) => {
        const records = await helper('project-log-history', { project: req.project.id });
        const q = String(req.query.q || '')
            .slice(0, 200)
            .toLowerCase();
        res.type('text/plain')
            .attachment(req.project.id + '-redacted.log')
            .send(
                records
                    .filter((r) => String(r.text).toLowerCase().includes(q))
                    .map((r) => `${r.time} [${r.level}] ${r.text}`)
                    .join('\n')
            );
    });
    app.patch('/api/projects/:project/runtime', async (req, res) => {
        const input = z
            .object({ runtime, replaceExternal: z.boolean().optional() })
            .parse(req.body);
        enqueue(req, res, 'project-runtime', input);
    });
    app.patch('/api/projects/:project/link', async (req, res) => {
        const input = z.object({ url: z.string().trim().max(2048) }).parse(req.body);
        let value = '';
        if (input.url) {
            const url = new URL(input.url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
                throw new Error('נדרשת כתובת HTTP/HTTPS ללא פרטי התחברות');
            if (
                origins().some(
                    (value) =>
                        url.hostname.replace(/\.$/, '') ===
                        new URL(value).hostname.replace(/\.$/, '')
                )
            )
                throw new Error(
                    'יש להשתמש בשם מארח נפרד מממשק הניהול כדי לא להעביר לאפליקציה את עוגיות ההתחברות'
                );
            value = url.href;
        }
        db.prepare('UPDATE projects SET launch_url=? WHERE id=?').run(value, req.project.id);
        audit(db, req.session.username, 'project-link', req.project.id);
        res.json({ url: value });
    });
    app.patch('/api/projects/:project/updates', async (req, res) => {
        const input = z.object({ mode: z.enum(['manual', 'auto']) }).parse(req.body);
        if (queue.locks.has('project:' + req.project.id))
            return res.status(409).json({ error: 'הפרויקט נמצא בפעולה אחרת' });
        const record = await helper('project-updates', { project: req.project.id, ...input });
        save(record);
        audit(db, req.session.username, 'project-updates', req.project.id);
        res.json(record);
    });
    app.get('/api/projects/:project/env', async (req, res) =>
        res.json(await helper('project-env-meta', { project: req.project.id }))
    );
    app.post('/api/projects/:project/env/reveal', async (req, res) => {
        res.set('Cache-Control', 'no-store, private');
        res.set('Pragma', 'no-cache');
        res.json(await helper('project-env-values', { project: req.project.id }));
    });
    app.post('/api/projects/:project/env/import', async (req, res) => {
        await sessionUser(req);
        if (queue.locks.has('project:' + req.project.id))
            return res.status(409).json({ error: 'הפרויקט נמצא בפעולה אחרת' });
        const input = z.object({ text: z.string().max(1048576) }).parse(req.body);
        const result = await helper('project-env-import', {
            project: req.project.id,
            text: input.text,
        });
        audit(db, req.session.username, 'project-env-import', req.project.id);
        res.json(result);
    });
    app.post('/api/projects/:project/env/import/preview', async (req, res) => {
        const input = z.object({ text: z.string().max(1048576) }).parse(req.body);
        res.json(
            await helper('project-env-preview', { project: req.project.id, text: input.text })
        );
    });
    app.patch('/api/projects/:project/env', async (req, res) => {
        await sessionUser(req);
        if (queue.locks.has('project:' + req.project.id))
            return res.status(409).json({ error: 'הפרויקט נמצא בפעולה אחרת' });
        const input = z
            .object({
                set: z.record(z.string(), z.string().max(8192)).default({}),
                unset: z.array(z.string()).max(100).default([]),
                publicBuild: z.array(z.string()).max(100).optional(),
            })
            .parse(req.body);
        const result = await helper('project-env-patch', { project: req.project.id, ...input });
        audit(db, req.session.username, 'project-env-patch', req.project.id);
        res.json(result);
    });
    for (const operation of ['start', 'stop', 'restart', 'restore'])
        app.post('/api/projects/:project/' + operation, async (req, res) => {
            if (req.body.confirmed !== true) throw new Error('נדרש אישור מפורש');
            enqueue(req, res, 'project-' + operation);
        });
    app.post('/api/projects/:project/activate', async (req, res) => {
        const input = z
            .object({
                confirmed: z.literal(true),
                expected: z
                    .string()
                    .regex(/^[a-f0-9]{40}$/)
                    .optional(),
            })
            .parse(req.body);
        enqueue(req, res, 'project-activate', input);
    });
    app.post('/api/projects/:project/archive', async (req, res) => {
        const input = z
            .object({ confirmed: z.literal(true), confirmName: z.string() })
            .parse(req.body);
        if (input.confirmName !== req.project.id) throw new Error('שם התיקייה שהוקלד אינו תואם');
        enqueue(req, res, 'project-archive', input);
    });
    app.delete('/api/projects/:project', async (req, res) => {
        await sessionUser(req);
        const input = z
            .object({ confirmed: z.literal(true), confirmName: z.string() })
            .parse(req.body);
        if (input.confirmName !== req.project.id) throw new Error('שם התיקייה שהוקלד אינו תואם');
        enqueue(req, res, 'project-purge', input);
    });
}
