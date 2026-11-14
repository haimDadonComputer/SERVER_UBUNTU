import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import argon2 from 'argon2';
import { createApp } from '../server/app.mjs';
import { openDatabase } from '../server/db.mjs';
import { totp } from '../server/security.mjs';
test('authentication, CSRF, TOTP, service allowlist adapter and encrypted backup', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-api-'));
    const db = openDatabase(dir);
    const config = {
        data: dir,
        dev: true,
        origin: 'http://localhost:5173',
        key: 'ab'.repeat(32),
        projects: dir,
        host: '127.0.0.1',
        port: 3080,
    };
    const calls = [];
    db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run(
        'admin',
        await argon2.hash('a long test password', { type: argon2.argon2id })
    );
    const { app, queue } = await createApp({
        db,
        config,
        helper: async (a, b) => {
            calls.push([a, b]);
            if (a === 'service' && b.service === 'allowed') return { state: 'active' };
            if (a === 'service') throw new Error('Not allowlisted');
            if (a === 'inventory') return { ports: [], services: [] };
            return {};
        },
    });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
        await new Promise((r) => server.close(r));
        db.close();
        await fs.rm(dir, { recursive: true, force: true });
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    let cookie = '',
        csrf = '';
    async function request(url, method = 'GET', body, extra = {}) {
        return fetch(base + '/api' + url, {
            method,
            headers: {
                Origin: config.origin,
                'Content-Type': 'application/json',
                Cookie: cookie,
                'X-CSRF-Token': csrf,
                ...extra,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    }
    assert.equal((await request('/inventory')).status, 401);
    assert.equal(
        (
            await request(
                '/login',
                'POST',
                { username: 'admin', password: 'a long test password' },
                { Origin: 'https://evil.test' }
            )
        ).status,
        403
    );
    assert.equal(
        (await request('/login', 'POST', { username: 'admin', password: 'wrong' })).status,
        401
    );
    let response = await request('/login', 'POST', {
        username: 'admin',
        password: 'a long test password',
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
    csrf = (await response.json()).csrf;
    assert.equal((await request('/inventory')).status, 200);
    assert.equal(
        (
            await request(
                '/services/allowed',
                'POST',
                { operation: 'restart', confirmed: true },
                { 'X-CSRF-Token': 'bad' }
            )
        ).status,
        403
    );
    assert.equal(
        (await request('/services/allowed', 'POST', { operation: 'restart', confirmed: false }))
            .status,
        400
    );
    response = await request('/services/allowed', 'POST', {
        operation: 'restart',
        confirmed: true,
    });
    assert.equal(response.status, 202);
    await queue.tail;
    assert.equal(db.prepare('SELECT status FROM jobs').get().status, 'done');
    assert.equal(calls.at(-1)[0], 'service');
    response = await request('/services/not-allowed', 'POST', {
        operation: 'restart',
        confirmed: true,
    });
    assert.equal(response.status, 202);
    await queue.tail;
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='failed'").get().n, 1);
    response = await request('/totp/setup', 'POST', { password: 'a long test password' });
    const secret = (await response.json()).secret;
    assert.ok(secret);
    response = await request('/totp/enable', 'POST', { code: totp(secret).generate() });
    assert.equal(response.status, 200);
    assert.equal(
        (await request('/backups', 'POST', { password: 'a long test password' })).status,
        400
    );
    // A later TOTP time step is used to avoid intentionally rejected replay.
    const timestamp = Date.now() + 30000;
    const code = totp(secret).generate({ timestamp });
    response = await request('/backups', 'POST', { password: 'a long test password', code });
    assert.equal(response.status, 200);
    const backup = (await response.json()).id;
    const encrypted = await fs.readFile(path.join(dir, 'backups', backup + '.enc'), 'utf8');
    assert.ok(!encrypted.includes('SQLite'));
    assert.ok(!encrypted.includes(secret));
    await request('/logout', 'POST', {});
    assert.equal((await request('/inventory')).status, 401);
    response = await request('/login', 'POST', {
        username: 'admin',
        password: 'a long test password',
    });
    assert.equal(response.status, 401);
});
test('five bad attempts produce a persistent login lockout', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-lock-'));
    const db = openDatabase(dir);
    const { app } = await createApp({
        db,
        config: { data: dir, dev: true, origin: 'http://local', key: 'ab'.repeat(32) },
        helper: async () => {},
    });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
        await new Promise((r) => server.close(r));
        db.close();
        await fs.rm(dir, { recursive: true, force: true });
    });
    for (let i = 0; i < 6; i++) {
        const r = await fetch('http://127.0.0.1:' + server.address().port + '/api/login', {
            method: 'POST',
            headers: { Origin: 'http://local', 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'unknown', password: 'wrong' }),
        });
        assert.equal(r.status, i < 5 ? 401 : 429);
    }
    assert.equal(db.prepare('SELECT count FROM attempts').get().count, 5);
});
