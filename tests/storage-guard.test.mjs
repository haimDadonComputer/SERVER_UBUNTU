import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile),
    guard = path.resolve('helper/storage_guard.cjs');
test('storage policy permits file CRUD and trusted modules but rejects uploaded CommonJS and ESM code', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-storage-policy-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const uploads = path.join(directory, 'uploads');
    await fs.mkdir(uploads);
    await fs.writeFile(path.join(uploads, 'payload.cjs'), 'throw Error("UPLOADED_CODE_EXECUTED")');
    await fs.writeFile(path.join(uploads, 'payload.mjs'), 'throw Error("UPLOADED_CODE_EXECUTED")');
    await fs.writeFile(path.join(directory, 'trusted.cjs'), 'module.exports="trusted"');
    const env = { ...process.env, UC_STORAGE_ROOTS: JSON.stringify([uploads]) };
    const result = await execute(
        process.execPath,
        [
            '--require',
            guard,
            '-e',
            `const fs=require('node:fs');fs.writeFileSync('uploads/file','one');fs.writeFileSync('uploads/file','two');if(fs.readFileSync('uploads/file','utf8')!=='two')throw Error('CRUD');fs.unlinkSync('uploads/file');console.log(require('./trusted.cjs'));`,
        ],
        { cwd: directory, env }
    );
    assert.match(result.stdout, /trusted/);
    for (const script of ["require('./uploads/payload.cjs')", "import('./uploads/payload.mjs')"]) {
        await assert.rejects(
            execute(process.execPath, ['--require', guard, '-e', script], { cwd: directory, env }),
            (error) =>
                error.stderr.includes('UC_STORAGE_CODE_BLOCKED') &&
                !error.stderr.includes('Error: UPLOADED_CODE_EXECUTED')
        );
    }
});
