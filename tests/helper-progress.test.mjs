import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { helperCall } from '../server/helper-client.mjs';

test('helper transport handles split progress frames, final diagnostics and premature EOF', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-helper-stream-'));
    const socket =
        process.platform === 'win32'
            ? '\\\\.\\pipe\\uc-progress-' + randomUUID()
            : path.join(directory, 'helper.sock');
    const server = net.createServer((connection) => {
        connection.once('data', (data) => {
            const request = JSON.parse(data.toString());
            if (request.action === 'closed') {
                connection.end();
                return;
            }
            connection.write('{"event":{"sta');
            connection.write('ge":"npm-install","text":"filtered"}}\n');
            if (request.action === 'failed')
                connection.end(
                    JSON.stringify({
                        ok: false,
                        error: 'failed',
                        details: { code: 'COMMAND_FAILED', stderr: 'password=hidden-value' },
                    }) + '\n'
                );
            else connection.end(JSON.stringify({ ok: true, data: { ready: true } }) + '\n');
        });
    });
    await new Promise((resolve) => server.listen(socket, resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const events = [];
    assert.deepEqual(await helperCall(socket, 'ok', {}, (event) => events.push(event)), {
        ready: true,
    });
    assert.deepEqual(events, [{ stage: 'npm-install', text: 'filtered' }]);
    await assert.rejects(
        helperCall(socket, 'failed'),
        (error) =>
            error.details.code === 'COMMAND_FAILED' &&
            !JSON.stringify(error.details).includes('hidden-value')
    );
    await assert.rejects(
        helperCall(socket, 'closed'),
        (error) => error.details.code === 'HELPER_EOF'
    );
});
