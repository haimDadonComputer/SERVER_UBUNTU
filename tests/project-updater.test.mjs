import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../server/db.mjs';
import { Queue } from '../server/queue.mjs';
import { ProjectUpdater } from '../server/project-updater.mjs';
import { projectView, reconcileProjects } from '../server/project-lifecycle.mjs';

async function fixture(t, adapter) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-updater-')),
        db = openDatabase(dir),
        queue = new Queue(db);
    let now = 1800000000000;
    const calls = [];
    const helper = async (a, b) => {
        calls.push([a, b]);
        return adapter(a, b);
    };
    const updater = new ProjectUpdater({ db, helper, queue, clock: () => now });
    t.after(async () => {
        updater.stop();
        await queue.tail;
        db.close();
        await fs.rm(dir, { recursive: true, force: true });
    });
    const insert = (id, state = {}) =>
        db
            .prepare(
                'INSERT INTO projects(id,name,root,kind,repo,lifecycle_json,update_state) VALUES(?,?,?,?,?,?,?)'
            )
            .run(
                id,
                id,
                '/' + id,
                'node',
                'https://github.com/o/r.git',
                JSON.stringify({
                    id,
                    lifecycle: 'active',
                    updates: 'auto',
                    runtime: { kind: 'node' },
                    ...state,
                }),
                JSON.stringify({ nextCheck: now - 1 })
            );
    const row = (id) => projectView(db.prepare('SELECT * FROM projects WHERE id=?').get(id));
    const check = async (id) => {
        const p = row(id);
        await updater.check(p, JSON.parse(p.update_state));
        await queue.tail;
    };
    return { db, queue, updater, calls, insert, row, check, advance: () => (now += 60000) };
}
test('unchanged SHA and ETag responses do not rebuild; polling remains one minute', async (t) => {
    const f = await fixture(t, async () => ({ notModified: true, etag: '"version"' }));
    f.insert('demo', { preparedCommit: 'a'.repeat(40) });
    const p = f.row('demo');
    f.db
        .prepare('UPDATE projects SET update_state=? WHERE id=?')
        .run(JSON.stringify({ remoteCommit: p.preparedCommit, etag: '"version"' }), 'demo');
    await f.check('demo');
    assert.deepEqual(
        f.calls.map((c) => c[0]),
        ['project-head']
    );
    assert.equal(f.calls[0][1].etag, '"version"');
    const state = JSON.parse(f.row('demo').update_state);
    assert.equal(state.nextCheck - Date.parse(state.checkedAt), 60000);
});
test('changed SHA queues a deployment, while manually stopped state stays under helper authority', async (t) => {
    const sha = 'b'.repeat(40);
    const f = await fixture(t, async (a) =>
        a === 'project-head'
            ? { sha }
            : {
                  id: 'demo',
                  lifecycle: 'active',
                  updates: 'auto',
                  runtime: { kind: 'node' },
                  desired: 'stopped',
                  preparedCommit: sha,
                  deployment: 'prepared-stopped',
              }
    );
    f.insert('demo', { preparedCommit: 'a'.repeat(40), desired: 'stopped' });
    await f.check('demo');
    assert.deepEqual(
        f.calls.map((c) => c[0]),
        ['project-head', 'project-activate']
    );
    assert.equal(f.row('demo').desired, 'stopped');
    assert.equal(f.row('demo').preparedCommit, sha);
    await f.check('demo');
    assert.equal(f.calls.filter((c) => c[0] === 'project-activate').length, 1);
});
test('failed commit is not rebuilt every minute and a new SHA permits retry', async (t) => {
    let sha = 'b'.repeat(40);
    const f = await fixture(t, async (a) => {
        if (a === 'project-head') return { sha };
        if (a === 'project-records') return [];
        throw new Error('build failed');
    });
    f.insert('demo');
    await f.check('demo');
    await f.check('demo');
    assert.equal(f.calls.filter((c) => c[0] === 'project-activate').length, 1);
    sha = 'c'.repeat(40);
    await f.check('demo');
    assert.equal(f.calls.filter((c) => c[0] === 'project-activate').length, 2);
});
test('network failures back off and honor GitHub retry hints without exposing token strings', async (t) => {
    const f = await fixture(t, async () => {
        throw Object.assign(new Error('Bearer ghs_PRIVATE'), { details: { retryAfter: '180' } });
    });
    f.insert('demo');
    await f.check('demo');
    let state = JSON.parse(f.row('demo').update_state);
    assert.equal(state.nextCheck - Date.parse(state.checkedAt), 180000);
    assert.ok(!state.error.includes('ghs_PRIVATE'));
    for (let i = 0; i < 5; i++) await f.check('demo');
    state = JSON.parse(f.row('demo').update_state);
    assert.equal(state.nextCheck - Date.parse(state.checkedAt), 900000);
});
test('manual and archived projects are never checked, and network concurrency is capped at two', async (t) => {
    const pending = [];
    const f = await fixture(t, () => new Promise((r) => pending.push(r)));
    f.insert('manual', { updates: 'manual' });
    f.insert('archived', { lifecycle: 'archived' });
    for (const id of ['one', 'two', 'three']) f.insert(id);
    await f.updater.tick();
    assert.equal(pending.length, 2);
    assert.equal(f.updater.checking.size, 2);
    assert.ok(f.calls.every((c) => ['one', 'two'].includes(c[1].project)));
    f.updater.stop();
    pending.forEach((r) => r({ notModified: true }));
    await new Promise((r) => setImmediate(r));
    assert.equal(f.updater.checking.size, 0);
});
test('queued update coalesces remote changes and refuses duplicates', async (t) => {
    const f = await fixture(t, async (a, b) =>
        a === 'project-head'
            ? { sha: 'b'.repeat(40) }
            : {
                  id: 'demo',
                  lifecycle: 'active',
                  updates: 'auto',
                  runtime: { kind: 'node' },
                  preparedCommit: b.expected,
              }
    );
    f.insert('demo');
    let release;
    const gate = new Promise((r) => (release = r));
    f.queue.add('other', async () => gate);
    const p = f.row('demo');
    await f.updater.check(p, JSON.parse(p.update_state));
    await f.updater.check(p, JSON.parse(f.row('demo').update_state));
    const state = JSON.parse(f.row('demo').update_state);
    state.remoteCommit = 'c'.repeat(40);
    f.db
        .prepare('UPDATE projects SET update_state=? WHERE id=?')
        .run(JSON.stringify(state), 'demo');
    release();
    await f.queue.tail;
    assert.equal(f.calls.filter((c) => c[0] === 'project-activate').length, 1);
    assert.equal(f.row('demo').preparedCommit, 'c'.repeat(40));
});
test('root records reconcile archived/deleted projects while legacy records default to manual', async (t) => {
    const f = await fixture(t, () => []);
    f.insert('demo');
    f.insert('gone');
    await reconcileProjects(f.db, async () => [
        { id: 'demo', lifecycle: 'archived', updates: 'manual' },
        { id: 'gone', lifecycle: 'deleted' },
    ]);
    assert.equal(f.row('demo').lifecycle, 'archived');
    assert.equal(f.db.prepare('SELECT id FROM projects WHERE id=?').get('gone'), undefined);
    assert.equal(projectView({ id: 'legacy' }).updates, 'manual');
});
