import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.mjs';
import { unseal } from '../server/security.mjs';
const [source, target] = process.argv.slice(2);
if (!source || !target || !/^[a-f0-9]{64}$/i.test(config.key))
    throw new Error(
        'Usage: node --env-file=... scripts/restore.mjs encrypted.enc NEW_OUTPUT.sqlite'
    );
const bytes = Buffer.from(unseal(await fs.readFile(source, 'utf8'), config.key), 'base64');
if (bytes.subarray(0, 16).toString() !== 'SQLite format 3\0')
    throw new Error('Invalid SQLite backup');
await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
const db = new DatabaseSync(target);
try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
        throw new Error('Database integrity check failed');
    db.exec('DELETE FROM sessions');
    console.log(
        'Restored to a separate file; sessions revoked. Stop the application before any manual replacement.'
    );
} finally {
    db.close();
}
