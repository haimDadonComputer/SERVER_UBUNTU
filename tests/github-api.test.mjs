import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import argon2 from 'argon2';
import { createApp } from '../server/app.mjs';
import { openDatabase } from '../server/db.mjs';
test('GitHub routes require authentication, CSRF and reauthentication; imports use queued scoped actions', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-github-api-')),
        db = openDatabase(dir);
    db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run(
        'admin',
        await argon2.hash('test-long-password')
    );
    let calls = [],
        finish;
    const gate = new Promise((resolve) => {
        finish = resolve;
    });
    const config = {
        data: dir,
        dev: true,
        origin: 'http://github-test',
        key: 'ab'.repeat(32),
        projects: dir,
    };
    const { app, queue } = await createApp({
        db,
        config,
        helper: async (action, args) => {
            calls.push([action, args]);
            if (action === 'github-status' || action === 'github-configure')
                return {
                    enabled: true,
                    appId: '123',
                    installationId: '456',
                    pemPath: '/etc/ubuntu-control/github/app.pem',
                };
            if (action === 'github-import') {
                await gate;
                return {
                    root: path.join(dir, args.id),
                    repo: 'https://github.com/owner/private.git',
                    branch: 'main',
                    github_repository_id: 7,
                    kind: 'node',
                };
            }
            if (action === 'project-clone') return {};
            return [];
        },
    });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
        finish();
        await queue.tail;
        await new Promise((r) => server.close(r));
        db.close();
        await fs.rm(dir, { recursive: true, force: true });
    });
    let cookie = '',
        csrf = '';
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = (url, method = 'GET', body, headers = {}) =>
        fetch(base + '/api' + url, {
            method,
            headers: {
                Origin: config.origin,
                'Content-Type': 'application/json',
                Cookie: cookie,
                'X-CSRF-Token': csrf,
                ...headers,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    assert.equal((await request('/github/status')).status, 401);
    let response = await request('/login', 'POST', {
        username: 'admin',
        password: 'test-long-password',
    });
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrf = (await response.json()).csrf;
    assert.equal(
        (
            await request('/github/configure', 'POST', {
                appId: '123',
                installationId: '456',
                password: 'wrong',
            })
        ).status,
        403
    );
    assert.equal(
        (
            await request('/github/configure', 'POST', {
                appId: '123',
                installationId: '456',
                password: 'test-long-password',
                pemPath: '/etc/shadow',
            })
        ).status,
        400
    );
    response = await request('/github/configure', 'POST', {
        appId: '123',
        installationId: '456',
        password: 'test-long-password',
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.stringify(calls).includes('test-long-password'), false);
    assert.equal(
        (await request('/github/check', 'POST', {}, { 'X-CSRF-Token': 'wrong' })).status,
        403
    );
    response = await request('/github/status');
    assert.ok(!(await response.text()).includes('PRIVATE KEY'));
    const input = {
        id: 'my-import',
        name: 'Imported private repository',
        repositoryId: 7,
        confirmed: true,
    };
    assert.equal(
        (await request('/github/import', 'POST', { ...input, confirmed: false })).status,
        400
    );
    assert.equal((await request('/github/import', 'POST', input)).status, 202);
    assert.equal((await request('/github/import', 'POST', input)).status, 409);
    finish();
    await queue.tail;
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get('my-import');
    assert.equal(p.auth, 'github-app');
    assert.equal(p.github_repository_id, 7);
    assert.ok(
        calls.some(([action, args]) => action === 'project-clone' && args.project === 'my-import')
    );
    assert.ok(!calls.some(([action]) => action === 'repository-token'));
    assert.equal(
        db.prepare("SELECT status FROM jobs WHERE resource='project:my-import'").get().status,
        'done'
    );
});
