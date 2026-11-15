import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { seal, unseal, redact, sessionFromRequest, hash } from '../server/security.mjs';
import { safeRelative, writeFile, readFile, listFiles, deleteEntry } from '../server/files.mjs';
import { openDatabase } from '../server/db.mjs';
import { DatabaseSync } from 'node:sqlite';
import { Queue } from '../server/queue.mjs';
test('AES-GCM encryption authenticates ciphertext and key', () => {
    const key = 'a1'.repeat(32);
    const encrypted = seal('private value', key);
    assert.equal(unseal(encrypted, key), 'private value');
    assert.ok(!encrypted.includes('private'));
    assert.throws(() => unseal(encrypted, 'b2'.repeat(32)));
    const p = encrypted.split('.');
    p[1] = '00'.repeat(16);
    assert.throws(() => unseal(p.join('.'), key));
});
test('GitHub schema migration preserves existing projects and settings', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-migration-'));
    const old = new DatabaseSync(path.join(root, 'control.sqlite'));
    old.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,root TEXT UNIQUE NOT NULL,service TEXT,kind TEXT NOT NULL,repo TEXT,branch TEXT,health_port INTEGER,last_sync TEXT);
     CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    old.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)').run(
        'existing',
        'Existing',
        '/srv/ubuntu-projects/existing',
        'existing-service',
        'node',
        'git@github.com:owner/repo.git',
        'main',
        3000,
        '2026-11-14'
    );
    old.prepare('INSERT INTO settings VALUES(?,?)').run('existing-config', 'preserved');
    old.close();
    const db = openDatabase(root);
    t.after(async () => {
        db.close();
        await fs.rm(root, { recursive: true, force: true });
    });
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get('existing');
    assert.equal(p.auth, 'deploy-key');
    assert.equal(p.github_repository_id, null);
    assert.equal(p.lifecycle_json, '{}');
    assert.equal(p.update_state, '{}');
    assert.equal(p.launch_url, '');
    assert.equal(p.service, 'existing-service');
    assert.equal(p.last_sync, '2026-11-14');
    assert.equal(p.repo, 'git@github.com:owner/repo.git');
    assert.equal(
        db.prepare('SELECT value FROM settings WHERE key=?').get('existing-config').value,
        'preserved'
    );
});
test('redact common secrets, bearer credentials and GitHub tokens', () => {
    const result = redact(
        'password=hunter2 token=abcdef Authorization: Bearer abcdef ghp_abcdefghij https://name:secret@github.com/a/b'
    );
    for (const value of ['hunter2', 'abcdef', 'ghp_abcdefghij', 'name:secret'])
        assert.ok(!result.includes(value));
});
test('redact dotted installation tokens and signed JWTs', () => {
    const input = 'ghs_123.payload.signature eyJhbGciOiJSUzI1NiJ9.payload.signature';
    const result = redact(input);
    assert.ok(!result.includes('payload'));
    assert.ok(!result.includes('signature'));
});
test('reject traversal and protected runtime/secrets paths', () => {
    for (const value of [
        '../etc/passwd',
        'a/../../x',
        '/etc/passwd',
        'a\\..\\x',
        '.env',
        'config/.env.local',
        '.git/config',
        'shared/whatsapp/qr.json',
        'private.key',
        'secret.txt',
        'node_modules/x',
        'current/index.js',
        'public/UpLoAds/private.txt',
        'assets/upload/image.png',
    ])
        assert.throws(() => safeRelative(value), value);
    assert.equal(safeRelative('src/index.ts'), 'src/index.ts');
});
test('file adapter edits ordinary text and protects secrets/symlinks/hardlinks', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-files-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await writeFile(root, 'hello.txt', 'hello');
    assert.equal(await readFile(root, 'hello.txt'), 'hello');
    await fs.writeFile(path.join(root, '.env'), 'hidden');
    assert.deepEqual(
        (await listFiles(root)).map((e) => e.name),
        ['hello.txt']
    );
    await assert.rejects(() => readFile(root, '.env'));
    await assert.rejects(() => writeFile(root, 'big.txt', 'x'.repeat(1024 * 1024 + 1)));
    await fs.link(path.join(root, 'hello.txt'), path.join(root, 'hard.txt'));
    await assert.rejects(() => writeFile(root, 'hard.txt', 'bad'));
    assert.equal(await fs.readFile(path.join(root, 'hello.txt'), 'utf8'), 'hello');
    if (process.platform !== 'win32') {
        await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
        await assert.rejects(() => writeFile(root, 'escape/evil.txt', 'bad'));
        await assert.rejects(() => readFile(root, 'escape/hello.txt'));
    }
    await deleteEntry(root, 'hard.txt');
    await deleteEntry(root, 'hello.txt');
    await assert.rejects(() => deleteEntry(root, ''));
});
test('session expiry is idle-based and not renewed by background reads', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-db-'));
    const db = openDatabase(root);
    t.after(async () => {
        db.close();
        await fs.rm(root, { recursive: true, force: true });
    });
    db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run('admin', 'hash');
    const now = Date.now();
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(
        hash('raw'),
        1,
        'csrf',
        now,
        now - 16 * 60e3
    );
    const req = { headers: { cookie: 'uc_session=raw' } };
    assert.equal(sessionFromRequest(req, db), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(
        hash('raw'),
        1,
        'csrf',
        now,
        now - 60000
    );
    const before = sessionFromRequest(req, db).touched;
    assert.equal(sessionFromRequest(req, db).touched, before);
});
test('queue serializes jobs, prevents duplicates and records failures', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-queue-'));
    const db = openDatabase(root),
        queue = new Queue(db);
    t.after(async () => {
        db.close();
        await fs.rm(root, { recursive: true, force: true });
    });
    let release;
    const blocker = new Promise((r) => {
        release = r;
    });
    const id = queue.add('service:a', async (stage) => {
        stage('waiting');
        await blocker;
        throw new Error('password=secret');
    });
    assert.throws(() => queue.add('service:a', async () => {}));
    const queued = queue.add('project:queued', async (stage) => stage('starting'), 'project-start');
    assert.equal(
        db.prepare('SELECT action FROM jobs WHERE id=?').get(queued).action,
        'project-start'
    );
    release();
    await queue.tail;
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    assert.equal(job.status, 'failed');
    assert.ok(!job.error.includes('secret'));
    assert.equal(queue.locks.size, 0);
});
test('job progress is bounded, redacted and keeps stage timestamps', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-progress-')),
        db = openDatabase(root),
        queue = new Queue(db);
    t.after(async () => {
        db.close();
        await fs.rm(root, { recursive: true, force: true });
    });
    const id = queue.add('project:demo', async (stage) => {
        for (let i = 0; i < 350; i++)
            stage({ stage: 'step-' + i, text: 'token=ghs_DO_NOT_DISPLAY' });
    });
    await queue.tail;
    const events = db.prepare('SELECT * FROM job_events WHERE job=?').all(id);
    assert.equal(events.length, 300);
    assert.ok(events.every((e) => e.time));
    assert.ok(!JSON.stringify(events).includes('ghs_DO_NOT_DISPLAY'));
    assert.ok(db.prepare('SELECT started FROM jobs WHERE id=?').get(id).started);
});
