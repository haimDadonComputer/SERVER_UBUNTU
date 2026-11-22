import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import argon2 from 'argon2';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { audit } from './db.mjs';
import { hash, token, equal, seal, unseal, totp, sessionFromRequest, redact } from './security.mjs';
import * as OTPAuth from 'otpauth';
import { Queue } from './queue.mjs';
import { listFiles, readFile, writeFile, createDirectory, deleteEntry } from './files.mjs';
import { metrics } from './metrics.mjs';
import { sanitizeDetails, storedDetails } from './diagnostics.mjs';
import { registerLifecycle, reconcileProjects, projectView } from './project-lifecycle.mjs';
import { registerNetwork } from './network.mjs';
import { createNetworkStatus } from './network-status.mjs';

const credentials = z.object({
    username: z.string().min(3).max(64),
    password: z.string().min(1).max(256),
    code: z
        .string()
        .regex(/^\d{6}$/)
        .optional(),
});
const projectInput = z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
    name: z.string().min(1).max(80),
    kind: z.enum(['node', 'docker']).default('node'),
    repo: z
        .string()
        .max(300)
        .regex(
            /^(?:(?:https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/
        )
        .default(''),
    branch: z.string().max(101).default('main'),
    service: z.string().max(100).default(''),
    health_port: z.preprocess(
        (v) => (v === '' || v == null ? undefined : Number(v)),
        z.number().int().min(1024).max(65535).optional()
    ),
});
export async function createApp({ db, config, helper }) {
    const app = express(),
        queue = new Queue(db),
        networkStatus = createNetworkStatus(helper);
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    app.use(
        helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    imgSrc: ["'self'", 'data:'],
                    connectSrc: ["'self'"],
                    upgradeInsecureRequests: config.dev ? null : [],
                },
            },
            strictTransportSecurity: config.dev ? false : undefined,
        })
    );
    const envImportPath = /^\/api\/projects\/[a-z][a-z0-9-]{1,40}\/env\/import(?:\/preview)?\/?$/;
    const normalJson = express.json({ limit: '1500kb' });
    // A UTF-8 file can expand sixfold inside JSON. Only authenticated ENV
    // import requests receive the larger transport allowance; raw text stays 1 MiB.
    const envJson = express.json({ limit: '7mb' });
    const envText = express.text({ type: 'text/plain', limit: '1mb', defaultCharset: 'utf-8' });
    app.use(
        '/api',
        rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false })
    );
    app.use('/api', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (
            !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
            !(config.origins || [config.origin]).includes(req.headers.origin)
        )
            return res.status(403).json({ error: 'מקור הבקשה אינו מורשה' });
        next();
    });
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    app.use((req, res, next) =>
        envImportPath.test(req.path) ? next() : normalJson(req, res, next)
    );
    const dummy = await argon2.hash(token(), { type: argon2.argon2id });
    const cookieOptions = {
        httpOnly: true,
        secure: !config.dev,
        sameSite: 'strict',
        path: '/',
        maxAge: 8 * 3600e3,
    };
    app.post(
        '/api/login',
        rateLimit({
            windowMs: 15 * 60e3,
            limit: 20,
            standardHeaders: 'draft-8',
            legacyHeaders: false,
        }),
        async (req, res) => {
            const input = credentials.parse(req.body);
            const ip = req.ip || 'local';
            const now = Date.now();
            // Reserve the attempt atomically before asynchronous password work.
            // Concurrent requests must not all read and overwrite the same count.
            const attempt = db
                .prepare(
                    `
                INSERT INTO attempts(ip,count,until) VALUES(?,1,?)
                ON CONFLICT(ip) DO UPDATE SET
                    count=CASE WHEN attempts.until>? THEN attempts.count+1 ELSE 1 END,
                    until=excluded.until
                WHERE attempts.until<=? OR attempts.count<5
                RETURNING count
            `
                )
                .get(ip, now + 15 * 60e3, now, now);
            if (!attempt)
                return res.status(429).json({ error: 'יותר מדי ניסיונות. נסו שוב בעוד 15 דקות.' });
            const user = db.prepare('SELECT * FROM users WHERE username=?').get(input.username);
            const valid = await argon2.verify(user?.password || dummy, input.password);
            let step = null;
            if (user?.totp && input.code) {
                const delta = totp(unseal(user.totp, config.key)).validate({
                    token: input.code,
                    window: 1,
                });
                if (delta !== null) step = Math.floor(now / 30000) + delta;
            }
            if (!user || !valid || (user.totp && (step === null || step <= user.last_totp))) {
                audit(db, 'anonymous', 'login', 'authentication', 'denied');
                return res.status(401).json({ error: 'פרטי ההתחברות או קוד האימות אינם תקינים' });
            }
            if (step !== null) {
                const updated = db
                    .prepare('UPDATE users SET last_totp=? WHERE id=? AND last_totp<?')
                    .run(step, user.id, step);
                if (updated.changes !== 1)
                    return res.status(401).json({ error: 'קוד האימות כבר נוצל. המתינו לקוד הבא.' });
            }
            db.prepare('DELETE FROM attempts WHERE ip=?').run(ip);
            db.prepare('DELETE FROM sessions WHERE touched<? OR created<?').run(
                now - 15 * 60e3,
                now - 8 * 3600e3
            );
            const raw = token(),
                csrf = token();
            db.prepare(
                'INSERT INTO sessions(hash,user_id,csrf,created,touched) VALUES(?,?,?,?,?)'
            ).run(hash(raw), user.id, csrf, now, now);
            res.cookie('uc_session', raw, cookieOptions);
            audit(db, user.username, 'login', 'authentication');
            res.json({ username: user.username, csrf, totpEnabled: !!user.totp });
        }
    );
    app.use('/api', (req, res, next) => {
        const s = sessionFromRequest(req, db);
        if (!s) return res.status(401).json({ error: 'יש להתחבר למערכת' });
        req.session = s;
        if (!['GET', 'HEAD'].includes(req.method) && !equal(req.headers['x-csrf-token'], s.csrf))
            return res.status(403).json({ error: 'אסימון אבטחה אינו תקין' });
        next();
    });
    app.use((req, res, next) => {
        if (!envImportPath.test(req.path)) return next();
        return req.is('text/plain') ? envText(req, res, next) : envJson(req, res, next);
    });
    app.post('/api/activity', (req, res) => {
        db.prepare('UPDATE sessions SET touched=? WHERE hash=?').run(Date.now(), req.session.hash);
        res.json({ ok: true });
    });
    app.get('/api/me', (req, res) => {
        const u = db.prepare('SELECT totp FROM users WHERE id=?').get(req.session.user_id);
        res.json({ username: req.session.username, csrf: req.session.csrf, totpEnabled: !!u.totp });
    });
    app.post('/api/logout', (req, res) => {
        db.prepare('DELETE FROM sessions WHERE hash=?').run(req.session.hash);
        res.clearCookie('uc_session', cookieOptions);
        res.json({ ok: true });
    });
    async function sessionUser(req) {
        const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user_id);
        if (!user)
            throw Object.assign(new Error('Authenticated account is unavailable'), { status: 401 });
        return user;
    }
    app.post('/api/account', async (req, res) => {
        await sessionUser(req);
        const username = z
            .string()
            .regex(/^[\p{L}\p{N}_.-]{3,64}$/u)
            .parse(req.body.username);
        const password = z.string().min(14).max(256).parse(req.body.newPassword);
        db.prepare('UPDATE users SET username=?,password=? WHERE id=?').run(
            username,
            await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 }),
            req.session.user_id
        );
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.session.user_id);
        audit(db, username, 'account-update', 'account');
        res.json({ ok: true, relogin: true });
    });
    app.post('/api/totp/setup', async (req, res) => {
        const u = await sessionUser(req);
        if (u.totp) throw new Error('אימות דו־שלבי כבר מופעל');
        const secret = new OTPAuth.Secret({ size: 20 }).base32;
        db.prepare('UPDATE users SET pending_totp=? WHERE id=?').run(
            seal(secret, config.key),
            u.id
        );
        res.json({ uri: totp(secret, u.username).toString(), secret });
    });
    app.post('/api/totp/enable', async (req, res) => {
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user_id);
        if (!u.pending_totp || u.totp) throw new Error('יש להתחיל הגדרה מחדש');
        const code = z
            .string()
            .regex(/^\d{6}$/)
            .parse(req.body.code);
        const delta = totp(unseal(u.pending_totp, config.key)).validate({ token: code, window: 1 });
        if (delta === null) throw new Error('קוד אימות אינו תקין');
        db.prepare(
            'UPDATE users SET totp=pending_totp,pending_totp=NULL,last_totp=? WHERE id=?'
        ).run(Math.floor(Date.now() / 30000) + delta, u.id);
        db.prepare('DELETE FROM sessions WHERE user_id=? AND hash!=?').run(u.id, req.session.hash);
        audit(db, u.username, 'totp-enable', 'account');
        res.json({ ok: true });
    });
    app.post('/api/totp/disable', async (req, res) => {
        const u = await sessionUser(req);
        db.prepare('UPDATE users SET totp=NULL,pending_totp=NULL,last_totp=-1 WHERE id=?').run(
            u.id
        );
        audit(db, u.username, 'totp-disable', 'account');
        res.json({ ok: true });
    });
    app.get('/api/metrics', async (_req, res) => res.json(await metrics()));
    app.get('/api/inventory', async (_req, res) => res.json(await helper('inventory')));
    app.get('/api/services', async (_req, res) => res.json((await helper('inventory')).services));
    app.post('/api/services/:id', async (req, res) => {
        const operation = z
            .enum(['start', 'stop', 'restart', 'enable', 'disable'])
            .parse(req.body.operation);
        if (req.body.confirmed !== true) throw new Error('נדרש אישור לכל הפורטים של השירות');
        const resource = req.params.id.startsWith('uc:')
            ? 'project:' + req.params.id.slice(3)
            : 'service:' + req.params.id;
        const id = queue.add(
            resource,
            async (stage) => {
                stage('מעדכן שירות');
                await helper('service', { service: req.params.id, operation, confirmed: true });
                audit(db, req.session.username, 'service-' + operation, req.params.id);
            },
            'service-' + operation
        );
        res.status(202).json({ job: id });
    });
    app.get('/api/logs/:id', async (req, res) =>
        res.json({
            text: redact(await helper('logs', { service: req.params.id })),
            time: new Date().toISOString(),
        })
    );
    app.get('/api/logs/:id/download', async (req, res) => {
        res.type('text/plain')
            .attachment('service-redacted.log')
            .send(redact(await helper('logs', { service: req.params.id })));
    });
    app.get('/api/firewall', async (_req, res) => res.json(await helper('firewall-status')));
    app.post('/api/firewall', async (req, res) => {
        const input = z
            .object({
                port: z.number().int().min(1).max(65535),
                protocol: z.enum(['tcp', 'udp']),
                source: z.string().max(64),
                operation: z.enum(['allow', 'remove']),
                confirmed: z.literal(true),
                worldConfirmed: z.boolean(),
            })
            .parse(req.body);
        const result = await helper('firewall-change', input);
        audit(db, req.session.username, 'firewall-' + input.operation, String(input.port));
        res.json(result);
    });
    for (const action of ['confirm', 'rollback'])
        app.post('/api/firewall/' + action, async (req, res) => {
            const transaction = z
                .string()
                .regex(/^[a-f0-9]{32}$/)
                .parse(req.body.transaction);
            res.json(await helper('firewall-' + action, { transaction }));
            audit(db, req.session.username, 'firewall-' + action, transaction);
        });
    app.get('/api/github/status', async (_req, res) => res.json(await helper('github-status')));
    app.post('/api/github/configure', async (req, res) => {
        await sessionUser(req);
        const input = z
            .object({
                appId: z.string().regex(/^[1-9][0-9]{0,18}$/),
                installationId: z.string().regex(/^[1-9][0-9]{0,18}$/),
                pemPath: z.literal('/etc/ubuntu-control/github/app.pem').optional(),
            })
            .parse(req.body);
        const result = await helper('github-configure', input);
        audit(db, req.session.username, 'github-configure', 'installation');
        res.json(result);
    });
    app.post('/api/github/check', async (req, res) => {
        const result = await helper('github-check');
        audit(db, req.session.username, 'github-check', 'installation');
        res.json(result);
    });
    app.get('/api/github/repositories', async (_req, res) =>
        res.json(await helper('github-repositories'))
    );
    app.post('/api/github/refresh', async (req, res) => {
        const result = await helper('github-repositories');
        audit(db, req.session.username, 'github-refresh', 'repositories');
        res.json(result);
    });
    app.post('/api/github/disconnect', async (req, res) => {
        await sessionUser(req);
        const result = await helper('github-disconnect');
        audit(db, req.session.username, 'github-disconnect', 'installation');
        res.json(result);
    });
    app.post('/api/github/import', async (req, res) => {
        const input = z
            .object({
                id: projectInput.shape.id,
                name: projectInput.shape.name,
                repositoryId: z.number().int().positive().safe(),
                confirmed: z.literal(true),
                kind: z.enum(['node', 'docker']).default('node'),
                service: z.string().max(100).optional(),
                health_port: z.number().int().min(1024).max(65535).optional(),
            })
            .parse(req.body);
        const job = queue.add('project:' + input.id, async (stage) => {
            stage('מאמת הרשאות GitHub ויוצר פרויקט');
            const p = await helper('github-import', input);
            if (!path.isAbsolute(p.root) || !p.root.startsWith(config.projects + path.sep))
                throw new Error('Project outside configured root');
            db.prepare(
                `INSERT INTO projects(id,name,root,service,kind,repo,branch,health_port,auth,github_repository_id) VALUES(?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET repo=excluded.repo,branch=excluded.branch,auth=excluded.auth,github_repository_id=excluded.github_repository_id`
            ).run(
                input.id,
                input.name,
                p.root,
                p.service || null,
                p.kind || 'node',
                p.repo,
                p.branch,
                p.health_port || null,
                'github-app',
                p.github_repository_id
            );
            stage('מוריד מאגר באמצעות GitHub App');
            await helper('project-clone', { project: input.id, confirmed: true }, stage);
            db.prepare('UPDATE projects SET last_sync=CURRENT_TIMESTAMP WHERE id=?').run(input.id);
            audit(db, req.session.username, 'github-import', input.id);
        });
        res.status(202).json({ job });
    });
    app.get('/api/projects', async (req, res) => {
        await reconcileProjects(db, helper).catch(() => {});
        const state = req.query.state === 'archived' ? 'archived' : 'active';
        res.json(
            db
                .prepare('SELECT * FROM projects')
                .all()
                .map(projectView)
                .filter((p) => p.lifecycle === state)
        );
    });
    app.get('/api/projects/authorized', async (_req, res) =>
        res.json(await helper('project-authorized'))
    );
    app.post('/api/projects', async (req, res) => {
        const input = projectInput.parse(req.body);
        if (db.prepare('SELECT id FROM projects WHERE id=?').get(input.id))
            return res.status(409).json({ error: 'פרויקט בשם תיקייה זה כבר קיים. בחרו שם אחר.' });
        const p = await helper('project-create', input);
        if (!path.isAbsolute(p.root) || !p.root.startsWith(config.projects + path.sep))
            throw new Error('Project outside configured root');
        db.prepare(
            'INSERT INTO projects(id,name,root,service,kind,repo,branch,health_port) VALUES(?,?,?,?,?,?,?,?)'
        ).run(
            input.id,
            input.name,
            p.root,
            p.service || null,
            p.kind || 'node',
            p.repo || null,
            p.branch || 'main',
            p.health_port || null
        );
        audit(db, req.session.username, 'project-register', input.id);
        res.status(201).json({ ok: true });
    });
    app.param('project', (req, res, next, id) => {
        const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
        if (!p) return res.status(404).json({ error: 'הפרויקט לא נמצא' });
        req.project = p;
        const view = projectView(p);
        const relative = String(req.query.path || req.body?.path || '');
        if (
            /\/(?:files|file|directory|download)\/?$/.test(req.path) &&
            (view.writableDirectories || []).some(
                (dir) => relative === dir || relative.startsWith(dir + '/')
            )
        )
            return res.status(403).json({
                error: 'תיקיית נתונים מוגנת; ניהול קבצי מקור אינו מאפשר גישה לנתוני היישום',
            });
        if (
            view.lifecycle !== 'active' &&
            /^\/api\/projects\/[^/]+\/(?:files|file|directory|download|git|preview|clone|deploy|pull|env)\/?$/.test(
                req.path
            )
        )
            return res.status(409).json({ error: 'הפרויקט בארכיון. יש לשחזר אותו תחילה.' });
        next();
    });
    registerLifecycle({
        app,
        db,
        helper,
        queue,
        sessionUser,
        networkStatus,
        origin: config.origin,
        origins: () => config.origins || [config.origin],
    });
    registerNetwork({ app, db, helper, queue, sessionUser, config, networkStatus });
    app.get('/api/projects/:project/qr', async (req, res) =>
        res.json(await helper('project-qr', { project: req.project.id }))
    );
    app.get('/api/projects/:project/releases', async (req, res) =>
        res.json(await helper('project-releases', { project: req.project.id }))
    );
    app.post('/api/projects/:project/rollback', async (req, res) => {
        if (req.body.confirmed !== true) throw new Error('Explicit confirmation required');
        const release = z
            .string()
            .regex(/^\d+-[a-f0-9]{10}$/)
            .parse(req.body.release);
        const id = queue.add('project:' + req.project.id, async (stage) => {
            stage('Restoring release');
            await helper('project-rollback', { project: req.project.id, release, confirmed: true });
            audit(db, req.session.username, 'project-rollback', req.project.id);
        });
        res.status(202).json({ job: id });
    });
    app.get('/api/projects/:project/git', async (req, res) =>
        res.json(await helper('project-status', { project: req.project.id }))
    );
    app.post('/api/projects/:project/preview', async (req, res) =>
        res.json(await helper('project-preview', { project: req.project.id }))
    );
    for (const action of ['clone', 'deploy', 'pull'])
        app.post('/api/projects/:project/' + action, async (req, res) => {
            if (req.body.confirmed !== true) throw new Error('נדרש אישור מפורש להרצת קוד הפרויקט');
            const expected =
                action === 'deploy'
                    ? z
                          .string()
                          .regex(/^[a-f0-9]{40}$/)
                          .parse(req.body.expected)
                    : undefined;
            const p = req.project;
            const id = queue.add('project:' + p.id, async (stage) => {
                stage(
                    action === 'clone'
                        ? 'מוריד מאגר'
                        : action === 'pull'
                          ? 'מושך קוד ללא פריסה'
                          : 'בונה גרסה ובודק תקינות'
                );
                await helper(
                    'project-' + action,
                    { project: p.id, confirmed: true, expected },
                    stage
                );
                db.prepare('UPDATE projects SET last_sync=CURRENT_TIMESTAMP WHERE id=?').run(p.id);
                audit(db, req.session.username, 'project-' + action, p.id);
            });
            res.status(202).json({ job: id });
        });
    app.post('/api/projects/:project/env', async (req, res) => {
        await sessionUser(req);
        if (queue.locks.has('project:' + req.project.id))
            return res.status(409).json({ error: 'הפרויקט נמצא בפעולה אחרת' });
        const values = z.record(z.string(), z.string().max(8192)).parse(req.body.values);
        await helper('project-env', { project: req.project.id, values });
        audit(db, req.session.username, 'project-env', req.project.id);
        res.json({ ok: true });
    });
    app.get('/api/projects/:project/files', async (req, res) =>
        res.json(await listFiles(req.project.root, String(req.query.path || '')))
    );
    app.get('/api/projects/:project/file', async (req, res) =>
        res.json({ content: await readFile(req.project.root, String(req.query.path || '')) })
    );
    app.get('/api/projects/:project/download', async (req, res) => {
        const rel = String(req.query.path || '');
        const data = await readFile(req.project.root, rel);
        res.type('text/plain').attachment(path.basename(rel)).send(data);
    });
    app.post('/api/projects/:project/file', async (req, res) => {
        if (queue.locks.has('project:' + req.project.id)) throw new Error('הפרויקט נמצא בעדכון');
        const input = z.object({ path: z.string(), content: z.string() }).parse(req.body);
        await writeFile(req.project.root, input.path, input.content);
        audit(db, req.session.username, 'file-write', req.project.id);
        res.json({ ok: true });
    });
    app.post('/api/projects/:project/directory', async (req, res) => {
        if (queue.locks.has('project:' + req.project.id))
            throw new Error('Project is being updated');
        await createDirectory(req.project.root, z.string().min(1).parse(req.body.path));
        audit(db, req.session.username, 'directory-create', req.project.id);
        res.json({ ok: true });
    });
    app.delete('/api/projects/:project/file', async (req, res) => {
        if (req.body.confirmed !== true) throw new Error('נדרש אישור מחיקה');
        const rel = z.string().min(1).parse(req.body.path);
        if (queue.locks.has('project:' + req.project.id))
            throw new Error('Project is being updated');
        await deleteEntry(req.project.root, rel);
        audit(db, req.session.username, 'file-delete', req.project.id);
        res.json({ ok: true });
    });
    app.get('/api/jobs', (_req, res) =>
        res.json(
            db
                .prepare('SELECT * FROM jobs ORDER BY created DESC,rowid DESC LIMIT 50')
                .all()
                .map(({ error_details, ...row }) => ({
                    ...row,
                    details: storedDetails(error_details),
                    events: db
                        .prepare(
                            'SELECT * FROM (SELECT * FROM job_events WHERE job=? ORDER BY id DESC LIMIT 12) ORDER BY id'
                        )
                        .all(row.id),
                }))
        )
    );
    app.get('/api/jobs/:id/events', (req, res) => {
        const cursor = Math.max(0, Number(req.query.cursor) || 0);
        const job = db.prepare('SELECT id,status,stage FROM jobs WHERE id=?').get(req.params.id);
        if (!job) return res.status(404).json({ error: 'המשימה לא נמצאה' });
        const first = db.prepare('SELECT MIN(id) AS id FROM job_events WHERE job=?').get(job.id).id;
        res.json({
            job,
            gap: !!cursor && first > cursor + 1,
            events: db
                .prepare('SELECT * FROM job_events WHERE job=? AND id>? ORDER BY id LIMIT 300')
                .all(job.id, cursor),
        });
    });
    app.get('/api/audit', (_req, res) =>
        res.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all())
    );
    app.get('/api/settings', (_req, res) => {
        const setting = db.prepare("SELECT value FROM settings WHERE key='preferences'").get();
        res.json({
            origin: config.origin,
            host: config.host,
            port: config.port,
            idleMinutes: 15,
            preferences: setting
                ? JSON.parse(setting.value)
                : { refresh: 5, diskAlert: 90, memoryAlert: 90 },
            integrations:
                'Credentials and privileges are configured locally in /etc/ubuntu-control/helper.json',
        });
    });
    app.post('/api/settings', (req, res) => {
        const preferences = z
            .object({
                refresh: z.number().int().min(3).max(60),
                diskAlert: z.number().min(50).max(99),
                memoryAlert: z.number().min(50).max(99),
            })
            .parse(req.body);
        db.prepare(
            "INSERT INTO settings(key,value) VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        ).run(JSON.stringify(preferences));
        audit(db, req.session.username, 'settings-update', 'preferences');
        res.json({ ok: true });
    });
    app.post('/api/backups', async (req, res) => {
        await sessionUser(req);
        const id = randomUUID();
        const file = path.join(config.data, 'backup-' + id + '.sqlite');
        await backup(db, file);
        try {
            const bytes = await fs.readFile(file);
            const payload = seal(bytes.toString('base64'), config.key);
            await fs.mkdir(path.join(config.data, 'backups'), { recursive: true, mode: 0o700 });
            await fs.writeFile(path.join(config.data, 'backups', id + '.enc'), payload, {
                mode: 0o600,
            });
            audit(db, req.session.username, 'backup-create', id);
            res.json({ id });
        } finally {
            await fs.unlink(file).catch(() => {});
        }
    });
    app.get('/api/backups', async (_req, res) => {
        const entries = await fs.readdir(path.join(config.data, 'backups')).catch(() => []);
        res.json(entries.filter((n) => /^[a-f0-9-]+\.enc$/.test(n)));
    });
    app.get('/api/backups/:id', async (req, res) => {
        if (!/^[a-f0-9-]+\.enc$/.test(req.params.id)) throw new Error('Invalid backup');
        res.type('application/octet-stream')
            .attachment(req.params.id)
            .send(await fs.readFile(path.join(config.data, 'backups', req.params.id)));
    });
    app.use('/api', (_req, res) => res.status(404).json({ error: 'הפעולה אינה קיימת' }));
    app.use(express.static(path.resolve('dist'), { index: false }));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.resolve('dist/index.html')));
    app.use((err, req, res, _next) => {
        const status = err instanceof z.ZodError ? 400 : err.status || 400;
        const requestId = randomUUID();
        audit(db, req.session?.username, 'request-error', req.path, 'failed ' + requestId);
        const details = sanitizeDetails(err.details) || {
            code: err instanceof z.ZodError ? 'VALIDATION_ERROR' : err.code || 'REQUEST_FAILED',
            stage: 'api',
            hint: 'בדקו את הודעת השגיאה. ניתן לצרף את מזהה הבקשה ואת הדוח לבירור.',
        };
        details.requestId = requestId;
        if (err instanceof z.ZodError)
            details.stderr = err.issues
                .slice(0, 24)
                .map((issue) => issue.path.join('.') + ': ' + issue.message)
                .join('\n');
        res.status(status).json({
            error:
                err instanceof z.ZodError
                    ? 'נתונים לא תקינים. בדקו את השדות.'
                    : redact(err.message || 'הפעולה נכשלה'),
            details,
        });
    });
    return { app, queue };
}
