import { test, expect, type Locator } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
// @ts-ignore The backend intentionally uses native ESM without TypeScript compilation.
import { openDatabase } from '../../server/db.mjs';
// @ts-ignore
import { createApp } from '../../server/app.mjs';
import argon2 from 'argon2';
let server: http.Server, dir: string, db: any, base: string;
let runtimeGate: Promise<void> | null = null,
    releaseRuntime: (() => void) | undefined;
const rootRecords = new Map<string, any>(),
    environments = new Map<string, Record<string, string>>();
async function expandDetails(details: Locator) {
    if ((await details.getAttribute('open')) === null)
        await details.locator(':scope > summary').click();
}
test.beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-ui-'));
    db = openDatabase(dir);
    db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run(
        'test-admin',
        await argon2.hash('test-only-long-password')
    );
    server = http.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + (server.address() as any).port;
    const { app } = await createApp({
        db,
        config: {
            data: dir,
            dev: true,
            origin: base,
            key: 'cd'.repeat(32),
            projects: dir,
            host: '127.0.0.1',
            port: 3080,
        },
        helper: async (action: string, args: any, progress?: (event: any) => void) => {
            if (action === 'project-port-check')
                return {
                    port: args.port,
                    status: args.port === 3001 ? 'occupied' : 'available',
                    listeners: args.port === 3001 ? [{ process: 'other-node', pid: 4321 }] : [],
                };
            if (action === 'project-start' && runtimeGate) {
                progress?.({ stage: 'npm-install', text: 'installing test dependencies' });
                await runtimeGate;
            }
            if (action === 'network-status')
                return {
                    ip: '192.0.2.20',
                    domain: 'control.example.test',
                    email: 'test@example.test',
                    management: false,
                    projects: {},
                    certificates: {},
                    prepared: false,
                };
            if (action === 'project-env-preview' || action === 'project-env-import') {
                const imported = Object.fromEntries(
                    args.text
                        .trim()
                        .split('\n')
                        .map((line: string) => {
                            const index = line.indexOf('=');
                            return [line.slice(0, index), line.slice(index + 1)];
                        })
                );
                if (action === 'project-env-import')
                    environments.set(args.project, {
                        ...environments.get(args.project),
                        ...imported,
                    } as Record<string, string>);
                return {
                    keys: Object.keys(
                        action === 'project-env-import' ? environments.get(args.project)! : imported
                    ),
                    publicBuild: [],
                    restartRequired: action === 'project-env-import',
                };
            }
            if (action === 'project-records') return [...rootRecords.values()];
            if (action === 'project-state')
                return {
                    ...rootRecords.get(args.project),
                    observed: {
                        active:
                            rootRecords.get(args.project)?.desired === 'running'
                                ? 'active'
                                : 'inactive',
                    },
                };
            if (action === 'project-options')
                return {
                    scripts: ['start', 'build', 'test'],
                    entries: ['index.mjs'],
                    git: false,
                    dockerfile: false,
                    lockfiles: [],
                };
            if (
                action === 'inventory' &&
                [...rootRecords.values()].some((record) => record.runtime)
            )
                return {
                    ports: [],
                    services: [...rootRecords.values()]
                        .filter((record) => record.runtime)
                        .map((record) => ({
                            id: record.service,
                            status: record.desired === 'running' ? 'active' : 'inactive',
                        })),
                };
            if (action === 'project-env-values')
                return {
                    keys: Object.keys(environments.get(args.project) || {}),
                    publicBuild: [],
                    values: environments.get(args.project) || {},
                };
            if (action === 'project-env-meta')
                return {
                    keys: Object.keys(environments.get(args.project) || {}),
                    publicBuild: [],
                    restartRequired: false,
                };
            if (action === 'project-env-patch') {
                const values = { ...environments.get(args.project), ...args.set };
                for (const key of args.unset) delete values[key];
                environments.set(args.project, values);
                return {
                    keys: Object.keys(values),
                    publicBuild: args.publicBuild || [],
                    restartRequired: true,
                };
            }
            if (action === 'project-log-history')
                return [
                    {
                        type: 'project-log',
                        cursor: 's=one',
                        time: new Date().toISOString(),
                        level: 'info',
                        text: 'filtered runtime log',
                    },
                ];
            if (
                [
                    'project-runtime',
                    'project-start',
                    'project-stop',
                    'project-restart',
                    'project-activate',
                    'project-archive',
                    'project-restore',
                    'project-updates',
                ].includes(action)
            ) {
                const p = { ...rootRecords.get(args.project) };
                if (action === 'project-runtime')
                    Object.assign(p, {
                        runtime: args.runtime,
                        service: 'uc:' + args.project,
                        ownership: 'managed',
                        desired: 'stopped',
                    });
                if (['project-start', 'project-restart', 'project-activate'].includes(action))
                    Object.assign(p, {
                        desired: 'running',
                        activeCommit: 'a'.repeat(40),
                        preparedCommit: 'a'.repeat(40),
                        deployment: 'healthy',
                    });
                if (action === 'project-stop') p.desired = 'stopped';
                if (action === 'project-archive')
                    Object.assign(p, {
                        lifecycle: 'archived',
                        updates: 'manual',
                        desired: 'stopped',
                    });
                if (action === 'project-restore')
                    Object.assign(p, {
                        lifecycle: 'active',
                        updates: 'manual',
                        desired: 'stopped',
                    });
                if (action === 'project-updates') p.updates = args.mode;
                rootRecords.set(args.project, p);
                return p;
            }
            if (
                action === 'github-status' ||
                action === 'github-check' ||
                action === 'github-configure'
            )
                return {
                    appId: '123',
                    installationId: '456',
                    enabled: true,
                    pemPath: '/etc/ubuntu-control/github/app.pem',
                    connection: 'connected',
                    checkedAt: '2026-11-14T00:00:00Z',
                };
            if (action === 'github-repositories')
                return [
                    {
                        id: 7,
                        name: 'private-app',
                        full_name: 'owner/private-app',
                        description: 'Private application',
                        private: true,
                        default_branch: 'stable',
                        updated_at: '2026-11-14T00:00:00Z',
                        archived: false,
                    },
                    {
                        id: 8,
                        name: 'public-app',
                        full_name: 'owner/public-app',
                        description: 'Public application',
                        private: false,
                        default_branch: 'main',
                        updated_at: '2026-11-13T00:00:00Z',
                        archived: false,
                    },
                ];
            if (action === 'github-import') {
                const root = path.join(dir, args.id);
                await fs.mkdir(root, { recursive: true });
                const record = {
                    id: args.id,
                    root,
                    kind: 'node',
                    repo: 'https://github.com/owner/private-app.git',
                    branch: 'stable',
                    auth: 'github-app',
                    github_repository_id: 7,
                };
                rootRecords.set(args.id, record);
                return record;
            }
            if (action === 'project-clone') {
                await fs.writeFile(
                    path.join(dir, args.project, 'README.txt'),
                    'Mock GitHub import for browser QA'
                );
                return {};
            }
            if (action === 'project-pull')
                throw Object.assign(new Error('אימות Git מול המאגר נכשל.'), {
                    details: {
                        code: 'GIT_AUTH_FAILED',
                        stage: 'git-fetch',
                        user: 'ubuntu-projects',
                        cwd: '/srv/ubuntu-projects/private-app',
                        exitCode: 128,
                        command: ['git', 'fetch', 'origin'],
                        stderr: 'fatal: Authentication failed token=ghs_DO_NOT_DISPLAY',
                        hint: 'בדקו הרשאות GitHub App.',
                    },
                });
            if (action === 'project-create') {
                const root = path.join(dir, args.id);
                await fs.mkdir(root);
                const record = {
                    id: args.id,
                    root,
                    kind: args.kind,
                    repo: args.repo || null,
                    branch: args.branch || 'main',
                    service: null,
                    health_port: null,
                };
                rootRecords.set(args.id, record);
                return record;
            }
            throw Object.assign(
                new Error('System helper is not installed in this Windows UI test'),
                { status: 503 }
            );
        },
    });
    server.on('request', app);
});
test.afterAll(async () => {
    releaseRuntime?.();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
});
test('desktop login, real API session, RTL navigation, honest system errors and mobile layout', async ({
    page,
}) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(base);
    await expect(page.getByRole('heading', { name: 'ברוכים הבאים בחזרה' })).toBeVisible();
    await page.locator('input[name=username]').fill('test-admin');
    await page.locator('input[name=password]').fill('test-only-long-password');
    await page.getByRole('button', { name: 'כניסה מאובטחת' }).click();
    await expect(page.getByRole('heading', { name: 'סקירת השרת' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByText('נתוני Ubuntu אינם זמינים')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'תעבורת רשת' })).toBeVisible();
    await expect(page.getByText('פג תוקף ההתחברות. יש להתחבר מחדש.')).toHaveCount(0);
    await page.getByRole('button', { name: 'פורטים ושירותים', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'פורטים ושירותים', exact: true })).toBeVisible();
    await expect(page.getByText('אין פורטים להצגה')).toBeVisible();
    await page.getByRole('button', { name: 'פרויקטים', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'הפרויקטים שלי' })).toBeVisible();
    await page.getByRole('button', { name: 'הוספת פרויקט' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('מזהה מתוך helper.json')).toHaveCount(0);
    await page.locator('input[name=id]').fill('first-project');
    await page.locator('input[name=name]').fill('פרויקט ראשון');
    await page.getByRole('button', { name: 'אישור ושמירה' }).click();
    await expect(page.getByRole('heading', { name: 'פרויקט ראשון' })).toBeVisible();
    await page.getByRole('button', { name: 'הוספת פרויקט', exact: true }).click();
    await page.locator('input[name=id]').fill('second-project');
    await page.locator('input[name=name]').fill('פרויקט שני');
    await page.getByRole('button', { name: 'אישור ושמירה' }).click();
    await expect(page.getByRole('heading', { name: 'פרויקט שני' })).toBeVisible();
    await page.getByRole('button', { name: 'קבצים', exact: true }).first().click();
    await expect(page.getByText('בחרו קובץ לעריכה')).toBeVisible();
    await page.getByRole('button', { name: 'קובץ חדש' }).click();
    await page.locator('input[name=name]').fill('hello.txt');
    await page.getByRole('button', { name: 'אישור ושמירה' }).click();
    await page.getByRole('textbox', { name: 'עריכת תוכן הקובץ' }).fill('hello from the browser');
    await page.getByRole('button', { name: 'שמירה', exact: true }).click();
    await expect
        .poll(async () => fs.readFile(path.join(dir, 'first-project', 'hello.txt'), 'utf8'))
        .toBe('hello from the browser');
    await page.getByRole('button', { name: 'הגדרות ואבטחה', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'התחברות ואבטחה' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'GitHub App', exact: true })).not.toBeVisible();
    await page.getByRole('button', { name: 'גישה ופרסום', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'כתובות שרת ופרסום ציבורי' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'התחברות ואבטחה' })).not.toBeVisible();
    await page.getByRole('button', { name: 'GitHub', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'GitHub App', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'בדיקת חיבור', exact: true }).click();
    await expect(page.getByLabel('GitHub App ID')).toHaveValue('123');
    await page.getByRole('button', { name: 'פרויקטים', exact: true }).click();
    await page.getByRole('button', { name: 'ייבוא מ־GitHub', exact: true }).click();
    await expect(page.getByText('owner/private-app', { exact: true })).toBeVisible();
    await page.getByLabel('סינון מאגרים').selectOption('private');
    await expect(page.getByText('owner/public-app', { exact: true })).toHaveCount(0);
    await page.getByLabel('חיפוש מאגרי GitHub').fill('private');
    await page.getByRole('button').filter({ hasText: 'owner/private-app' }).click();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'ייבוא המאגר', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'הפרויקטים שלי', exact: true })).toBeVisible();
    await expect
        .poll(async () =>
            fs.readFile(path.join(dir, 'private-app', 'README.txt'), 'utf8').catch(() => '')
        )
        .toContain('Mock GitHub import');
    await page.getByRole('button', { name: 'פרויקטים', exact: true }).click();
    await page.getByRole('button', { name: 'רענון נתונים', exact: true }).click();
    const imported = page
        .locator('.project-card')
        .filter({ has: page.getByRole('heading', { name: 'private-app', exact: true }) });
    await expect(imported).toBeVisible();
    await expandDetails(imported.locator('.project-manage'));
    await expandDetails(imported.locator('.project-source-details'));
    await imported.getByRole('button', { name: 'משיכת קוד בלבד', exact: true }).click();
    await page.getByRole('button', { name: 'אישור מפורש', exact: true }).click();
    await page.getByRole('button', { name: 'משימות רקע', exact: true }).click();
    await page.getByRole('button', { name: /^דורשות טיפול/ }).click();
    await expect(page.getByText('אימות Git מול המאגר נכשל.', { exact: true })).toBeVisible();
    await page.getByText('פרטי השגיאה והמלצה לטיפול', { exact: true }).click();
    await expect(page.getByText('GIT_AUTH_FAILED', { exact: true })).toBeVisible();
    await expect(page.getByText('git-fetch', { exact: true })).toBeVisible();
    await expect(page.getByText('ghs_DO_NOT_DISPLAY', { exact: false })).toHaveCount(0);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'הורדת דוח', exact: true }).click();
    const report = await downloadEvent;
    const reportPath = await report.path();
    const reportText = await fs.readFile(reportPath!, 'utf8');
    expect(reportText).toContain('GIT_AUTH_FAILED');
    expect(reportText).not.toContain('ghs_DO_NOT_DISPLAY');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'סקירת השרת', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'משימות רקע', exact: true }).click();
    await page.getByText('פרטי השגיאה והמלצה לטיפול', { exact: true }).click();
    await expect(page.getByText('GIT_AUTH_FAILED', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'הגדרות ואבטחה', exact: true }).click();
    await page.getByRole('button', { name: 'החלפת ערכת צבעים' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'לוח בקרה', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'סקירת השרת' })).toBeVisible();
    await page.getByRole('button', { name: 'הגדרות ואבטחה', exact: true }).click();
    await page.getByRole('button', { name: 'גישה ופרסום', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'כתובות שרת ופרסום ציבורי' })).toBeVisible();
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    ).toBeTruthy();
    expect(errors).toEqual([]);
});

test('compact project cards expose primary actions, safe links, truthful publication and responsive layout', async ({
    page,
}) => {
    const runtime = {
        kind: 'node',
        mode: 'npm',
        script: 'start',
        health: 'http',
        listenAddress: '0.0.0.0',
        port: 3000,
    };
    const projects = ['running', 'stopped', 'failed', 'unknown', 'unconfigured'].map((id) => ({
        id,
        name: id,
        root: '/srv/ubuntu-projects/' + id + '-long-path'.repeat(12),
        kind: 'node',
        lifecycle: 'active',
        service: id === 'unconfigured' ? null : 'uc:' + id,
        runtime:
            id === 'unconfigured'
                ? null
                : id === 'running'
                  ? { ...runtime, listenAddress: '127.0.0.1' }
                  : runtime,
        ownership: 'managed',
        repo: 'https://github.com/example/' + 'long-repository-name'.repeat(8),
    }));
    const archived = { ...projects[0], id: 'archived', name: 'archived', lifecycle: 'archived' };
    let known = true,
        accessFailure = false;
    let publicationAttempted = false,
        projectReads = 0,
        accessReads = 0;
    let publicationRequest: Record<string, any> = {};
    const publicationDiagnostic = {
        code: 'NGINX_BIND_PERMISSION',
        stage: 'proxy-validation',
        stderr: 'nginx: bind() to 192.0.2.20:80 failed (13: Permission denied)',
        hint: 'Review the helper publication capability configuration.',
    };
    let projectJobs = [
        {
            id: 'queued-card',
            resource: 'project:stopped',
            action: 'project-start',
            status: 'queued',
            stage: 'queued',
        },
        {
            id: 'building-card',
            resource: 'project:running',
            action: 'project-activate',
            status: 'running',
            stage: 'npm-build',
        },
        {
            id: 'failed-card',
            resource: 'project:failed',
            action: 'project-start',
            status: 'failed',
            stage: 'health',
        },
    ];
    await page.route('**/api/projects?state=archived', (route) =>
        route.fulfill({ json: [archived] })
    );
    await page.route('**/api/projects', (route) => {
        projectReads++;
        return route.fulfill({ json: projects });
    });
    await page.route('**/api/inventory', (route) =>
        route.fulfill({
            json: {
                services: [
                    { id: 'uc:running', status: 'active' },
                    { id: 'uc:stopped', status: 'inactive' },
                    { id: 'uc:failed', status: 'failed' },
                ],
                ports: [],
            },
        })
    );
    await page.route('**/api/jobs', (route) =>
        route.fulfill({
            json: projectJobs,
        })
    );
    await page.route('**/api/network', (route) =>
        route.fulfill({
            json: {
                ip: '192.0.2.20',
                domain: '',
                email: 'test@example.test',
                projects: {},
                prepared: true,
            },
        })
    );
    await page.route('**/api/projects/running/publication', (route) => {
        publicationAttempted = true;
        publicationRequest = route.request().postDataJSON();
        return route.fulfill({ status: 202, json: { job: 'publication-test' } });
    });
    await page.route('**/api/jobs/publication-test/events', (route) =>
        route.fulfill({
            json: {
                job: {
                    id: 'publication-test',
                    status: 'failed',
                    error: 'Nginx validation failed',
                    details: publicationDiagnostic,
                },
                events: [],
            },
        })
    );
    await page.route('**/api/project-access*', (route) => {
        accessReads++;
        return accessFailure
            ? route.fulfill({ status: 503, json: { error: 'unavailable' } })
            : route.fulfill({
                  json: {
                      addresses: [{ address: '192.0.2.10' }, { address: '192.0.2.20' }],
                      managementHosts: ['192.0.2.10', 'control.example.test'],
                      publicationStatusKnown: known,
                      publications: known ? { running: { url: 'https://app.example.test/' } } : {},
                  },
              });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(base);
    await page.locator('input[name=username]').fill('test-admin');
    await page.locator('input[name=password]').fill('test-only-long-password');
    await page.getByRole('button', { name: 'כניסה מאובטחת' }).click();
    await page.getByRole('button', { name: 'פרויקטים', exact: true }).click();
    const cards = page.locator('.project-card');
    await expect(cards).toHaveCount(5);
    const card = cards.filter({ has: page.getByRole('heading', { name: 'running', exact: true }) });
    for (const label of [
        'פרסום באינטרנט',
        'הגדרות הפעלה',
        'עצירה',
        'הפעלה מחדש',
        'העבר לארכיון',
        'קבצים',
        'משתני סביבה',
    ]) {
        await expect(card.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    await expect(card.locator('.project-primary-actions > button')).toHaveCount(10);
    await expect(card.getByRole('button', { name: 'סנכרן עם הגיטהב', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'הרץ פקודה', exact: true })).toBeVisible();
    await expect(card.locator('.project-manage')).not.toHaveAttribute('open');
    await expect(
        card.getByRole('button', { name: 'קונסול הפרויקט', exact: true })
    ).not.toBeVisible();
    await expect(card.getByText('פועל', { exact: true })).toBeVisible();
    await expect(card.getByText('מפורסם באינטרנט', { exact: true })).toBeVisible();
    await expect(card.locator('.project-server-ip')).toContainText('192.0.2.10');
    await expect(card.getByRole('link', { name: /כניסה לפרויקט/ })).toHaveAttribute(
        'href',
        'https://app.example.test/'
    );
    await expect(card.locator('.project-path')).toHaveAttribute('dir', 'ltr');
    await expect(card.locator('.repo-link')).toHaveAttribute('target', '_blank');
    await expect(card.getByRole('button', { name: 'עצירה', exact: true })).toBeDisabled();
    const stopped = cards.filter({
        has: page.getByRole('heading', { name: 'stopped', exact: true }),
    });
    await expect(stopped.getByText('כבוי', { exact: true })).toBeVisible();
    await expect(stopped.getByText('לא מפורסם', { exact: true })).toBeVisible();
    await expect(stopped.getByRole('link', { name: /כניסה לפרויקט/ })).toHaveAttribute(
        'href',
        'http://192.0.2.20:3000/'
    );
    await expect(
        cards
            .filter({ has: page.getByRole('heading', { name: 'failed', exact: true }) })
            .getByText('נכשל', { exact: true })
    ).toBeVisible();
    await expect(
        cards
            .filter({ has: page.getByRole('heading', { name: 'unknown', exact: true }) })
            .getByText('לא ידוע', { exact: true })
    ).toBeVisible();
    const unconfigured = cards.filter({
        has: page.getByRole('heading', { name: 'unconfigured', exact: true }),
    });
    await expect(unconfigured.getByText('לא מוגדר', { exact: true })).toBeVisible();
    await expect(unconfigured.getByText('אין כרגע כתובת גישה', { exact: true })).toBeVisible();
    await expect(unconfigured.getByRole('button', { name: 'עצירה', exact: true })).toBeDisabled();
    await expect(
        unconfigured.getByRole('button', { name: 'פרסום באינטרנט', exact: true })
    ).toBeDisabled();
    const boxes = await cards.evaluateAll((elements) =>
        elements.map((element) => {
            const r = element.getBoundingClientRect();
            return { x: r.x, y: r.y };
        })
    );
    expect(boxes[0].y).toBe(boxes[1].y);
    expect(boxes[0].x).not.toBe(boxes[1].x);
    await expandDetails(card.locator('.project-manage'));
    await expect(card.getByRole('button', { name: 'קונסול הפרויקט', exact: true })).toBeVisible();
    await card.locator('.project-manage > summary').click();
    // A successful newer operation must not resurrect an older failure.
    projectJobs = projectJobs.filter(
        (job) => !['project:running', 'project:stopped'].includes(job.resource)
    );
    projectJobs.unshift({
        id: 'older-failure',
        resource: 'project:running',
        action: 'project-start',
        status: 'failed',
        stage: 'health',
    });
    projectJobs.unshift({
        id: 'newer-success',
        resource: 'project:running',
        action: 'project-start',
        status: 'done',
        stage: 'done',
    });
    await page.getByRole('button', { name: 'רענון נתונים', exact: true }).click();
    await expect(card.locator('.project-job-status')).toHaveCount(0);
    let pullBody: any, commandBody: any;
    await page.route('**/api/projects/running/options', (route) =>
        route.fulfill({ json: { scripts: ['start', 'dev'] } })
    );
    for (const operation of ['sync', 'command']) {
        await page.route(`**/api/projects/running/${operation}`, (route) => {
            if (operation === 'sync') {
                pullBody = route.request().postDataJSON();
                (projects[0] as any).source_sync_json = JSON.stringify({
                    checkedAt: new Date().toISOString(),
                    commit: 'b'.repeat(40),
                    changed: true,
                    mode: 'live',
                    running: true,
                });
            } else commandBody = route.request().postDataJSON();
            projectJobs.unshift({
                id: operation + '-card',
                resource: 'project:running',
                action: 'project-' + operation,
                status: 'done',
                stage: 'done',
            });
            return route.fulfill({ status: 202, json: { job: operation + '-card' } });
        });
    }
    await card.getByRole('button', { name: 'סנכרן עם הגיטהב', exact: true }).click();
    let commandDialog = page.getByRole('dialog');
    await expect(commandDialog).toContainText('main יימשך לתיקיית הפרויקט');
    await commandDialog.getByRole('button', { name: 'אישור הפעולה', exact: true }).click();
    await expect(commandDialog).not.toBeVisible();
    expect(pullBody).toEqual({ confirmed: true });
    await expect(card.locator('.source-sync-result')).toContainText('קוד חדש נמשך לתיקיית המקור');
    await expect(card.locator('.source-sync-result')).toContainText(
        'האתר עודכן לגרסה הזו ועבר בדיקת תקינות'
    );
    await expect(card.locator('.source-sync-result')).toContainText('bbbbbbbbbbbb');
    (projects[0] as any).source_sync_json = JSON.stringify({
        checkedAt: new Date().toISOString(),
        commit: 'b'.repeat(40),
        changed: false,
    });
    await page.getByRole('button', { name: 'רענון נתונים', exact: true }).click();
    await expect(card.locator('.source-sync-result')).toContainText('לא היו שינויים למשוך');
    await card.getByRole('button', { name: 'הרץ פקודה', exact: true }).click();
    commandDialog = page.getByRole('dialog');
    await expect(commandDialog.getByRole('combobox', { name: 'פקודה', exact: true })).toHaveValue(
        'start'
    );
    await commandDialog.getByRole('combobox', { name: 'פקודה', exact: true }).selectOption('dev');
    await expect(commandDialog.getByRole('button', { name: 'הרצה', exact: true })).toBeDisabled();
    await commandDialog.getByRole('combobox', { name: 'פקודה', exact: true }).selectOption('start');
    await commandDialog.getByRole('button', { name: 'הרצה', exact: true }).click();
    await expect(commandDialog).not.toBeVisible();
    expect(commandBody).toEqual({ confirmed: true, script: 'start' });
    await expect(card).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'הוספת פרויקט', exact: true }).first()
    ).toBeVisible();
    await expect(stopped.getByRole('button', { name: 'עצירה', exact: true })).toBeDisabled();
    await expect(stopped.getByRole('button', { name: 'הפעלה מחדש', exact: true })).toBeDisabled();
    await expect(
        stopped.getByRole('button', { name: 'פרסום באינטרנט', exact: true })
    ).toBeDisabled();
    await expect(card.getByRole('button', { name: 'עצירה', exact: true })).toBeEnabled();
    await expect(card.getByRole('button', { name: 'הפעלה מחדש', exact: true })).toBeEnabled();
    await card.getByRole('button', { name: 'פרסום באינטרנט', exact: true }).click();
    const publishDialog = page.getByRole('dialog', { name: 'פרסום הפרויקט', exact: true });
    await expect(publishDialog.getByLabel('סיסמה נוכחית')).toHaveCount(0);
    await publishDialog.getByLabel('דומיין לפרויקט (אופציונלי)').fill('forms');
    await expect(publishDialog.getByText(/https:\/\/forms\.haimdadon\.co\.il/)).toBeVisible();
    await expect(publishDialog.getByLabel('פורט ציבורי')).toHaveValue('443');
    await publishDialog.getByRole('checkbox', { name: /אני מאשר/ }).check();
    await publishDialog.getByRole('button', { name: 'פתיחה לאינטרנט', exact: true }).click();
    await expect(
        publishDialog.getByRole('alert').filter({ hasText: 'Nginx validation failed' })
    ).toBeVisible();
    expect(publicationAttempted).toBe(true);
    expect(publicationRequest.domain).toBe('forms.haimdadon.co.il');
    expect(publicationRequest.password).toBeUndefined();
    await expandDetails(publishDialog.locator('.error-details'));
    await expect(publishDialog.getByText('NGINX_BIND_PERMISSION', { exact: true })).toBeVisible();
    await expect(
        publishDialog.getByText(publicationDiagnostic.stderr, { exact: true })
    ).toBeVisible();
    await publishDialog.getByRole('button', { name: 'סגירה', exact: true }).click();
    known = false;
    await page.getByRole('button', { name: 'רענון נתונים', exact: true }).click();
    await expect(card.getByText('מצב הפרסום לא זמין', { exact: true })).toBeVisible();
    accessFailure = true;
    await page.getByRole('button', { name: 'רענון נתונים', exact: true }).click();
    await expect(card.getByText('אין כרגע כתובת גישה', { exact: true })).toBeVisible();
    await page.clock.install();
    const beforeHidden = { projects: projectReads, access: accessReads };
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward(45000);
    expect(projectReads).toBe(beforeHidden.projects);
    expect(accessReads).toBe(beforeHidden.access);
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => projectReads).toBeGreaterThan(beforeHidden.projects);
    await expect.poll(() => accessReads).toBeGreaterThan(beforeHidden.access);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await cards.evaluateAll((elements) =>
        elements.slice(0, 2).map((element) => element.getBoundingClientRect().x)
    );
    expect(mobile[0]).toBe(mobile[1]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
    );
    await page.getByRole('button', { name: /^ארכיון/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards.getByText('בארכיון', { exact: true })).toBeVisible();
    await expect(cards.getByRole('button', { name: 'שחזור מהארכיון', exact: true })).toBeVisible();
    await expect(cards.getByRole('button', { name: 'מחיקה לצמיתות', exact: true })).toBeVisible();
    await expect(cards.locator('.project-primary-actions')).toHaveCount(0);
});

test('project runtime, private environment metadata, console and archive restoration', async ({
    page,
}) => {
    const errors: string[] = [];
    const importTypes: string[] = [];
    page.on('request', (request) => {
        if (request.url().endsWith('/env/import'))
            importTypes.push(request.headers()['content-type']);
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/project-access*', (route) =>
        route.fulfill({
            json: {
                addresses: [{ address: '192.0.2.20', interface: 'tailscale0' }],
                managementHosts: [],
                publicationStatusKnown: true,
                publications: {},
            },
        })
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(base);
    await page.locator('input[name=username]').fill('test-admin');
    await page.locator('input[name=password]').fill('test-only-long-password');
    await page.getByRole('button', { name: 'כניסה מאובטחת' }).click();
    await page.getByRole('button', { name: 'פרויקטים', exact: true }).click();
    await page.getByRole('button', { name: 'הוספת פרויקט', exact: true }).first().click();
    await page.locator('input[name=id]').fill('lifecycle-demo');
    await page.locator('input[name=name]').fill('מחזור חיים');
    await page.getByRole('button', { name: 'אישור ושמירה' }).click();
    const card = page
        .locator('.project-card')
        .filter({ has: page.getByRole('heading', { name: 'מחזור חיים', exact: true }) });
    await expect(card.getByRole('button', { name: 'הגדרות הפעלה', exact: true })).toBeVisible();
    await expect(
        card.getByRole('button', { name: 'קונסול הפרויקט', exact: true })
    ).not.toBeVisible();
    await expandDetails(card.locator('.project-manage'));
    await card.getByRole('button', { name: 'הגדרות הפעלה', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('script להפעלה')).toHaveValue('start');
    await expect(dialog.getByLabel('התקנת תלויות')).toHaveValue('install');
    await expect(dialog.getByRole('combobox', { name: 'script בדיקות', exact: true })).toHaveValue(
        ''
    );
    await expect(dialog.getByText('הפורט פנוי בבדיקה הנוכחית')).toBeVisible();
    await dialog.getByLabel('פורט הפעלה').fill('3001');
    await expect(dialog.getByText(/הפורט תפוס בידי תהליך אחר/)).toContainText('PID 4321');
    await dialog.getByLabel('פורט הפעלה').fill('3000');
    await expect(dialog.getByText('הפורט פנוי בבדיקה הנוכחית')).toBeVisible();
    await dialog.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
    });
    await expect(dialog.getByRole('button', { name: 'סגירה', exact: true })).toBeInViewport();
    await dialog.getByLabel('תיקיות נתונים נוספות').fill('data\npublic/nested/uploads');
    await dialog.getByLabel('בדיקת תקינות').selectOption('http');
    await dialog.getByLabel('התקנת תלויות').selectOption('allow-install');
    await dialog.getByRole('checkbox', { name: 'גישה דרך IP ופורט של השרת' }).check();
    await dialog.getByRole('button', { name: 'שמירת הגדרות הפעלה' }).click();
    await expect(page.getByRole('heading', { name: 'הפרויקטים שלי', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^פאנל/ }).click();
    await expect(page.getByRole('dialog', { name: 'פאנל משימות רקע' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'הפרויקטים שלי', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'סגירת פאנל' }).click();
    await page.getByRole('button', { name: 'פרויקטים', exact: true }).click();
    await expandDetails(card.locator('.project-manage'));
    await card.getByRole('button', { name: 'הגדרות הפעלה', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'script בדיקות', exact: true }).selectOption('test');
    await dialog.getByRole('button', { name: 'שמירת הגדרות הפעלה' }).click();
    await card.getByRole('button', { name: 'הגדרות הפעלה', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'script בדיקות', exact: true })).toHaveValue(
        'test'
    );
    await dialog.getByRole('button', { name: 'סגירה', exact: true }).click();
    await expandDetails(card.locator('.project-manage'));
    await expect(card.getByLabel('עדכונים עבור מחזור חיים')).toHaveValue('manual');
    await expect(card.getByRole('button', { name: 'פרסום באינטרנט', exact: true })).toBeDisabled();
    expect(rootRecords.get('lifecycle-demo')?.runtime.storageDirectories).toEqual([
        'data',
        'public/nested/uploads',
    ]);
    runtimeGate = new Promise<void>((resolve) => {
        releaseRuntime = resolve;
    });
    await card.getByRole('button', { name: 'הפעלת פרויקט', exact: true }).click();
    await dialog.getByRole('button', { name: 'אישור הפעולה', exact: true }).click();
    await expandDetails(card.locator('.project-manage'));
    await expect(card.locator('.lifecycle-actions .primary')).toBeDisabled();
    await expect(card.locator('.lifecycle-actions .primary')).toContainText(
        /ממתין בתור|מתקין תלויות/
    );
    await expect(card.getByRole('button', { name: 'קונסול הפרויקט', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'לוח בקרה', exact: true }).click();
    await page.getByRole('button', { name: 'פרויקטים', exact: true }).click();
    await expandDetails(card.locator('.project-manage'));
    await expect(card.locator('.lifecycle-actions .primary')).toBeDisabled();
    releaseRuntime?.();
    runtimeGate = null;
    await expect(card.getByRole('button', { name: 'הפעלת פרויקט', exact: true })).toBeDisabled({
        timeout: 10000,
    });
    await expect(card.getByRole('link', { name: 'כניסה לפרויקט' })).toHaveAttribute(
        'href',
        'http://192.0.2.20:3000/'
    );
    await expandDetails(card.locator('.project-manage'));
    await card.getByRole('button', { name: 'כתובת פתיחה', exact: true }).click();
    await dialog.getByLabel('כתובת האפליקציה').fill('http://192.0.2.10:3000/');
    await dialog.getByRole('button', { name: 'שמירת כתובת' }).click();
    await expect(card.getByRole('link', { name: 'כניסה לפרויקט' })).toHaveAttribute(
        'href',
        'http://192.0.2.10:3000/'
    );
    await card.getByRole('button', { name: 'משתני סביבה', exact: true }).click();
    await dialog.getByRole('button', { name: 'הוספת משתנה' }).click();
    await dialog.getByLabel('שם משתנה 0').fill('API_KEY');
    await dialog.getByLabel('ערך API_KEY').fill('browser-test-private-value');
    await dialog.getByRole('button', { name: 'שמירת משתני סביבה' }).click();
    await expect(dialog.getByLabel('ערך API_KEY')).toHaveValue('browser-test-private-value');
    await expect(dialog.getByLabel('ערך API_KEY')).toHaveAttribute('type', 'text');
    await expect(dialog.getByLabel('ערך API_KEY')).toHaveAttribute('autocomplete', 'off');
    await expect(dialog.getByLabel('סיסמה נוכחית')).toHaveCount(0);
    await expect(dialog.getByText('browser-test-private-value')).toHaveCount(0);
    await dialog.getByLabel('העלאת קובץ ENV (מיזוג)').setInputFiles({
        name: '.env',
        mimeType: 'text/plain',
        buffer: Buffer.from('API_KEY=uploaded-private-value\nEMPTY=\n'),
    });
    await expect(dialog.getByText(/API_KEY \(החלפה\)/)).toBeVisible();
    await expect(dialog.getByText('uploaded-private-value')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'שמירת משתני סביבה' }).click();
    await expect(dialog.getByLabel('ערך EMPTY')).toHaveValue('');
    expect(environments.get('lifecycle-demo')?.API_KEY).toBe('uploaded-private-value');
    expect(importTypes).toEqual(['text/plain;charset=UTF-8']);
    await dialog.getByRole('button', { name: 'סגירה', exact: true }).click();
    await expandDetails(card.locator('.project-manage'));
    await card.getByRole('button', { name: 'קונסול הפרויקט', exact: true }).click();
    await expect(page.getByText('filtered runtime log')).toBeVisible();
    await page.getByRole('button', { name: 'פרויקטים', exact: true }).click();
    db.prepare(
        "INSERT INTO jobs(id,resource,status,error,error_details) VALUES(?,?,'failed',?,?)"
    ).run(
        'missing-lockfile-ui',
        'project:lifecycle-demo',
        'חסר קובץ נעילת תלויות של npm',
        JSON.stringify({
            code: 'NPM_LOCKFILE_MISSING',
            stage: 'dependency-install',
            hint: 'הוסיפו package-lock.json או בחרו npm install',
        })
    );
    let logReads = 0;
    await page.route('**/api/projects/lifecycle-demo/logs', (route) =>
        route.fulfill({
            json:
                logReads++ === 0
                    ? []
                    : [
                          {
                              cursor: 's=fallback',
                              time: new Date().toISOString(),
                              level: 'info',
                              text: 'HTTP fallback log',
                          },
                      ],
        })
    );
    await page.getByRole('button', { name: 'רענון נתונים', exact: true }).click();
    await expandDetails(card.locator('.project-manage'));
    await card.getByRole('button', { name: 'קונסול הפרויקט', exact: true }).click();
    await expect(page.getByText('חסר קובץ נעילת תלויות של npm', { exact: true })).toBeVisible();
    await expect(page.getByText('ממתין ללוגים מהפרויקט…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('HTTP fallback log')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'פרויקטים', exact: true }).click();
    await expandDetails(card.locator('.project-manage'));
    await card.getByRole('button', { name: 'העבר לארכיון', exact: true }).click();
    await dialog.getByLabel('להמשך הקלידו lifecycle-demo').fill('lifecycle-demo');
    await dialog.getByRole('button', { name: 'אישור הפעולה', exact: true }).click();
    await page.getByRole('button', { name: 'פרויקטים', exact: true }).click();
    await page.getByRole('button', { name: /^ארכיון/ }).click();
    await expect(card.getByRole('button', { name: 'מחיקה לצמיתות', exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'שחזור מהארכיון', exact: true }).click();
    await dialog.getByRole('button', { name: 'אישור הפעולה', exact: true }).click();
    await page.getByRole('button', { name: 'פרויקטים', exact: true }).click();
    await page.getByRole('button', { name: /^פרויקטים פעילים/ }).click();
    await expandDetails(card.locator('.project-manage'));
    await expect(card.getByLabel('עדכונים עבור מחזור חיים')).toHaveValue('manual');
    await expect(card.getByText(/שירות: כבוי/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('main > header')).toBeInViewport();
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    ).toBeTruthy();
    expect(errors).toEqual([]);
});
