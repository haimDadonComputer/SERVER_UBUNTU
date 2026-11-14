import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../server/db.mjs';
import { Queue } from '../server/queue.mjs';
import { sanitizeDetails, storedDetails } from '../server/diagnostics.mjs';
test('diagnostic fields and quoted secrets are sanitized and bounded', () => {
    const details = sanitizeDetails({
        code: 'GIT_AUTH_FAILED',
        stderr: 'password="two word secret" token=ghs_example.payload.signature',
        command: ['git', 'clone', 'https://user:password@github.com/a/b'],
        token: 'NO',
        privateKey: 'NO',
        stdout: 'x'.repeat(20000),
    });
    const data = JSON.stringify(details);
    assert.ok(!data.includes('two word secret'));
    assert.ok(!data.includes('ghs_example'));
    assert.ok(!data.includes('user:password'));
    assert.ok(!data.includes('NO'));
    assert.equal(details.stdout.length, 12000);
});
test('failed job diagnostics survive a database reopen without secret fields', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-details-'));
    let db = openDatabase(dir);
    t.after(async () => {
        db.close();
        await fs.rm(dir, { recursive: true, force: true });
    });
    const queue = new Queue(db);
    const id = queue.add('project:example', async () => {
        throw Object.assign(new Error('Git clone failed'), {
            details: {
                code: 'GIT_AUTH_FAILED',
                stage: 'git-clone',
                exitCode: 128,
                user: 'ubuntu-projects',
                cwd: '/srv/ubuntu-projects/example',
                stderr: 'fatal: Authentication failed token=ghs_private.secret',
                token: 'DO-NOT-STORE',
            },
        });
    });
    await queue.tail;
    db.close();
    db = openDatabase(dir);
    const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    const details = storedDetails(row.error_details);
    assert.equal(row.status, 'failed');
    assert.equal(details.exitCode, 128);
    assert.equal(details.stage, 'git-clone');
    assert.ok(!row.error_details.includes('ghs_private'));
    assert.ok(!row.error_details.includes('DO-NOT-STORE'));
    assert.equal(storedDetails('{invalid'), null);
});
