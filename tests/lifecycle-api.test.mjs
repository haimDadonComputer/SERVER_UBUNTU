import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import argon2 from 'argon2';
import { createApp } from '../server/app.mjs';
import { openDatabase } from '../server/db.mjs';

test('lifecycle API preserves authentication, CSRF, secret reauthentication and serialized mutations', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-lifecycle-api-')),
        db = openDatabase(dir),
        password = 'test-only-long-password';
    db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run(
        'admin',
        await argon2.hash(password)
    );
    db.prepare('INSERT INTO projects(id,name,root,kind) VALUES(?,?,?,?)').run(
        'demo',
        'Demo',
        dir,
        'node'
    );
    let record = { id: 'demo', lifecycle: 'active', updates: 'manual' },
        calls = [],
        release;
    let gate = Promise.resolve();
    const helper = async (action, args) => {
        calls.push([action, args]);
        if (action === 'project-port-check')
            return {
                port: args.port,
                listenAddress: args.listenAddress,
                status: 'available',
                listeners: [],
            };
        if (action === 'project-env-meta')
            return { keys: ['API_KEY'], publicBuild: [], restartRequired: false };
        if (action === 'project-env-patch')
            return { keys: Object.keys(args.set), publicBuild: [], restartRequired: true };
        if (action === 'project-env-import' || action === 'project-env-preview')
            return { keys: ['API_KEY'], publicBuild: [], restartRequired: true };
        if (action.startsWith('network-'))
            return {
                ip: '8.8.8.8',
                domain: 'control.example.com',
                email: 'admin@example.com',
                management: ['network-management', 'network-project'].includes(action),
                projects: {},
            };
        if (action === 'project-records') return [record];
        if (action === 'project-log-history')
            return [
                { time: '2026-11-15T00:00:00Z', level: 'info', text: 'filtered line', cursor: 'a' },
            ];
        if (action === 'project-runtime') {
            await gate;
            record = { ...record, runtime: args.runtime };
        }
        if (action === 'project-archive') record = { ...record, lifecycle: 'archived' };
        if (action === 'project-restore')
            record = { ...record, lifecycle: 'active', updates: 'manual', desired: 'stopped' };
        if (action === 'project-purge') record = { ...record, lifecycle: 'deleted' };
        return record;
    };
    const config = {
        data: dir,
        dev: true,
        origin: 'http://lifecycle-test',
        key: 'ab'.repeat(32),
        projects: dir,
    };
    const { app, queue } = await createApp({ db, config, helper });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
        release?.();
        await queue.tail;
        await new Promise((r) => server.close(r));
        db.close();
        await fs.rm(dir, { recursive: true, force: true });
    });
    let cookie = '',
        csrf = '';
    const request = (url, method = 'GET', body, headers = {}) =>
        fetch('http://127.0.0.1:' + server.address().port + '/api' + url, {
            method,
            headers: {
                Origin: config.origin,
                'Content-Type': 'application/json',
                Cookie: cookie,
                'X-CSRF-Token': csrf,
                ...headers,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    assert.equal((await request('/projects/demo/env')).status, 401);
    assert.equal((await request('/project-access')).status, 401);
    assert.equal((await request('/projects/demo/port-check?port=3000')).status, 401);
    let response = await request('/login', 'POST', { username: 'admin', password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrf = (await response.json()).csrf;
    assert.equal((await request('/project-access')).status, 200);
    assert.equal(
        (await (await request('/projects/demo/port-check?port=3000')).json()).status,
        'available'
    );
    assert.equal((await request('/projects/demo/port-check?port=22')).status, 400);
    assert.equal(
        (await request('/projects/demo/port-check?port=3000&listenAddress=evil.test')).status,
        400
    );
    assert.equal(
        (
            await request('/projects/demo/env/import', 'POST', {
                text: 'API_KEY=private-value',
                password: 'wrong',
            })
        ).status,
        403
    );
    response = await request('/projects/demo/env/import', 'POST', {
        text: 'API_KEY=private-value',
        password,
    });
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes('private-value'));
    assert.equal(
        (
            await request('/network', 'PATCH', {
                ip: '8.8.8.8',
                domain: 'control.example.com',
                email: 'admin@example.com',
                password: 'wrong',
            })
        ).status,
        403
    );
    response = await request('/network/management', 'POST', {
        enabled: true,
        confirmed: true,
        password,
    });
    assert.equal(response.status, 202);
    await queue.tail;
    assert.ok(config.origins.includes('https://control.example.com'));
    assert.ok(config.origins.includes(config.origin));
    assert.equal(
        (
            await request('/projects/demo/publication', 'POST', {
                enabled: true,
                confirmed: true,
                domain: 'control.example.com',
                password,
            })
        ).status,
        400
    );
    response = await request('/projects/demo/publication', 'POST', {
        enabled: true,
        confirmed: true,
        domain: 'forms.example.com',
        port: 443,
        https: true,
        password,
    });
    assert.equal(response.status, 202);
    await queue.tail;
    assert.ok(
        calls.some(
            ([action, args]) =>
                action === 'network-project' &&
                args.domain === 'forms.example.com' &&
                args.port === 443
        )
    );
    assert.ok(!config.origins.includes('https://forms.example.com'));
    assert.equal(
        (
            await request(
                '/projects/demo/env/import',
                'POST',
                { text: 'API_KEY=x', password },
                { 'X-CSRF-Token': 'wrong' }
            )
        ).status,
        403
    );
    assert.equal(
        (
            await request('/projects/demo/link', 'PATCH', {
                url: 'https://control.example.com:9000/',
            })
        ).status,
        400
    );
    for (const url of [
        'javascript:alert(1)',
        'https://user:secret@example.test',
        'http://lifecycle-test:9000/app',
    ])
        assert.equal((await request('/projects/demo/link', 'PATCH', { url })).status, 400);
    assert.equal(
        (
            await request(
                '/projects/demo/link',
                'PATCH',
                { url: 'http://192.0.2.10:3000/' },
                { 'X-CSRF-Token': 'bad' }
            )
        ).status,
        403
    );
    assert.equal(
        (await request('/projects/demo/link', 'PATCH', { url: 'http://192.0.2.10:3000/' })).status,
        200
    );
    assert.equal(
        db.prepare('SELECT launch_url FROM projects WHERE id=?').get('demo').launch_url,
        'http://192.0.2.10:3000/'
    );
    assert.equal(
        (
            await request(
                '/projects/demo/start',
                'POST',
                { confirmed: true },
                { 'X-CSRF-Token': 'bad' }
            )
        ).status,
        403
    );
    assert.equal(
        (
            await request('/projects/demo/env', 'PATCH', {
                password: 'wrong',
                set: { API_KEY: 'sensitive-value' },
            })
        ).status,
        403
    );
    response = await request('/projects/demo/env');
    assert.deepEqual((await response.json()).keys, ['API_KEY']);
    response = await request('/projects/demo/env', 'PATCH', {
        password,
        set: { API_KEY: 'sensitive-value' },
    });
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes('sensitive-value'));
    assert.equal(
        calls.some((c) => c[1]?.password),
        false
    );
    gate = new Promise((r) => (release = r));
    const runtime = {
        kind: 'node',
        mode: 'npm',
        script: 'start',
        health: 'process',
        port: null,
        autostart: false,
    };
    response = await request('/projects/demo/runtime', 'PATCH', { runtime });
    assert.equal(response.status, 202);
    assert.equal((await request('/projects/demo/start', 'POST', { confirmed: true })).status, 409);
    assert.equal(
        (await request('/projects/demo/archive', 'POST', { confirmed: true, confirmName: 'demo' }))
            .status,
        409
    );
    assert.equal(
        (await request('/projects/demo/env', 'PATCH', { password, set: { API_KEY: 'new-value' } }))
            .status,
        409
    );
    release();
    await queue.tail;
    const lifecycle = await (await request('/projects/demo/lifecycle')).json();
    assert.equal(lifecycle.lastJob.resource, 'project:demo');
    assert.equal(lifecycle.lastJob.status, 'done');
    assert.equal(
        JSON.parse(
            db.prepare('SELECT lifecycle_json FROM projects WHERE id=?').get('demo').lifecycle_json
        ).lastJob,
        undefined
    );
    assert.equal(
        (await request('/projects/demo/archive', 'POST', { confirmed: true, confirmName: 'wrong' }))
            .status,
        400
    );
    response = await request('/projects/demo/archive', 'POST', {
        confirmed: true,
        confirmName: 'demo',
    });
    assert.equal(response.status, 202);
    await queue.tail;
    assert.equal((await (await request('/projects?state=archived')).json())[0].id, 'demo');
    assert.equal((await request('/projects/demo/files')).status, 409);
    response = await request('/projects/demo/restore', 'POST', { confirmed: true });
    assert.equal(response.status, 202);
    await queue.tail;
    assert.equal((await (await request('/projects')).json())[0].desired, 'stopped');
    response = await request('/projects/demo/logs/download?q=missing');
    assert.equal(await response.text(), '');
    assert.equal(
        (
            await request('/projects/demo', 'DELETE', {
                confirmed: true,
                confirmName: 'demo',
                password: 'wrong',
            })
        ).status,
        403
    );
    response = await request('/projects/demo/archive', 'POST', {
        confirmed: true,
        confirmName: 'demo',
    });
    await queue.tail;
    response = await request('/projects/demo', 'DELETE', {
        confirmed: true,
        confirmName: 'demo',
        password,
    });
    assert.equal(response.status, 202);
    await queue.tail;
    assert.equal(db.prepare('SELECT id FROM projects WHERE id=?').get('demo'), undefined);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n >= 4);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n >= 4);
});
