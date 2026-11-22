import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../server/db.mjs';
import { Queue } from '../server/queue.mjs';
import { createNetworkStatus } from '../server/network-status.mjs';

test('independent stops bypass a blocked build while builds and duplicate resources stay serialized', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-lanes-'));
    const db = openDatabase(root),
        queue = new Queue(db);
    let release,
        stopped,
        secondBuild = false;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const stopDone = new Promise((resolve) => {
        stopped = resolve;
    });
    try {
        queue.add('project:a', async () => gate, 'project-activate');
        queue.add(
            'project:c',
            async () => {
                secondBuild = true;
            },
            'project-start'
        );
        const stop = queue.add('project:b', async () => stopped(), 'project-stop');
        assert.throws(() => queue.add('project:a', async () => {}, 'project-stop'));
        await stopDone;
        assert.equal(secondBuild, false);
        release();
        await queue.tail;
        assert.equal(secondBuild, true);
        assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(stop).status, 'done');
        assert.equal(queue.locks.size, 0);
    } finally {
        release();
        await queue.tail;
        db.close();
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('control concurrency is bounded at two and failed controls release their reservations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-control-'));
    const db = openDatabase(root),
        queue = new Queue(db);
    let release,
        count = 0,
        ready;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const started = new Promise((resolve) => {
        ready = resolve;
    });
    try {
        for (let i = 0; i < 3; i++)
            queue.add(
                'project:' + i,
                async () => {
                    if (++count === 2) ready();
                    await gate;
                    throw new Error('test failure');
                },
                'project-stop'
            );
        await started;
        assert.equal(count, 2);
        release();
        await queue.tail;
        assert.equal(count, 3);
        assert.equal(queue.locks.size, 0);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='failed'").get().n, 3);
    } finally {
        release();
        await queue.tail;
        db.close();
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('network status coalesces readers, expires, refreshes explicitly and never serves stale success after failure', async () => {
    let now = 0,
        calls = 0,
        fail = false;
    const status = createNetworkStatus(
        async () => {
            calls++;
            if (fail) throw new Error('probe unavailable');
            return { projects: {}, sequence: calls };
        },
        { clock: () => now }
    );
    const [first, second] = await Promise.all([status.get(), status.get()]);
    assert.equal(calls, 1);
    assert.equal(first, second);
    now = 4999;
    await status.get();
    assert.equal(calls, 1);
    now = 5000;
    fail = true;
    await assert.rejects(status.get(), /unavailable/);
    fail = false;
    await status.get();
    assert.equal(calls, 3);
    await status.get({ fresh: true });
    assert.equal(calls, 4);
});

test('mutation invalidation prevents an old in-flight status response from restoring stale state', async () => {
    let release,
        calls = 0;
    const old = new Promise((resolve) => {
        release = resolve;
    });
    const status = createNetworkStatus(async () =>
        ++calls === 1 ? old : { projects: { new: {} } }
    );
    const pending = status.get();
    await Promise.resolve();
    status.invalidate();
    const current = await status.get();
    release({ projects: { old: {} } });
    assert.deepEqual(await pending, current);
    assert.deepEqual(await status.get(), current);
    assert.equal(calls, 2);
});

test('additive job indexes preserve history and remove scans/sorts from list and per-project queries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-indexes-'));
    let db = openDatabase(root);
    try {
        db.exec('DROP INDEX jobs_created; DROP INDEX jobs_resource');
        for (let i = 0; i < 3; i++)
            db.prepare("INSERT INTO jobs(id,resource,status) VALUES(?,?,'done')").run(
                'job-' + i,
                'project:a'
            );
        db.close();
        db = openDatabase(root);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 3);
        const queries = [
            'SELECT * FROM jobs ORDER BY created DESC,rowid DESC LIMIT 50',
            "SELECT * FROM jobs WHERE resource='project:a' ORDER BY rowid DESC LIMIT 1",
        ];
        for (const query of queries) {
            const plan = db
                .prepare('EXPLAIN QUERY PLAN ' + query)
                .all()
                .map((row) => row.detail)
                .join(' ');
            assert.match(plan, /USING INDEX jobs_/);
            assert.doesNotMatch(plan, /TEMP B-TREE|^SCAN jobs$/);
            assert.equal(db.prepare(query).all()[0].id, 'job-2');
        }
    } finally {
        db.close();
        await fs.rm(root, { recursive: true, force: true });
    }
});
