import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../server/db.mjs';
import { hash } from '../server/security.mjs';
import { installProjectLogs } from '../server/project-log-stream.mjs';

test('console shares one source, resumes cursors, bounds slow viewers and reauthenticates subscriptions', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-stream-')),
        db = openDatabase(dir);
    const socketPath =
        process.platform === 'win32'
            ? '\\\\.\\pipe\\uc-stream-' + process.pid
            : path.join(dir, 'helper.sock');
    db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run('admin', 'unused');
    const now = Date.now();
    db.prepare('INSERT INTO sessions(hash,user_id,csrf,created,touched) VALUES(?,1,?,?,?)').run(
        hash('test-session'),
        'csrf',
        now,
        now
    );
    db.prepare('INSERT INTO projects(id,name,root,kind) VALUES(?,?,?,?)').run(
        'demo',
        'Demo',
        '/demo',
        'node'
    );
    const wss = new EventEmitter();
    wss.clients = new Set();
    const peers = [];
    const requests = [];
    const server = net.createServer((conn) => {
        peers.push(conn);
        conn.on('data', (data) => requests.push(JSON.parse(data.toString())));
    });
    server.listen(socketPath);
    await once(server, 'listening');
    const stop = installProjectLogs({ wss, db, socketPath });
    t.after(async () => {
        stop();
        peers.forEach((s) => s.destroy());
        await new Promise((r) => server.close(r));
        db.close();
        await fs.rm(dir, { recursive: true, force: true });
    });
    function viewer(cookie = 'uc_session=test-session') {
        const ws = new EventEmitter();
        Object.assign(ws, {
            readyState: 1,
            bufferedAmount: 0,
            frames: [],
            send(text) {
                this.frames.push(JSON.parse(text));
            },
            close(code) {
                this.code = code;
                this.readyState = 3;
                this.emit('close');
            },
        });
        wss.clients.add(ws);
        wss.emit('connection', ws, { headers: { cookie } });
        return ws;
    }
    const subscribe = (ws, cursor) =>
        ws.emit('message', JSON.stringify({ type: 'project-logs', project: 'demo', cursor }));
    const flush = async () => {
        for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    };
    const a = viewer();
    subscribe(a, 's=old');
    await flush();
    assert.equal(peers.length, 1);
    assert.equal(requests[0].args.cursor, 's=old');
    peers[0].write(
        JSON.stringify({
            type: 'project-log',
            text: 'token=ghs_PRIVATE',
            cursor: 's=first',
            time: '2026-11-15T00:00:00Z',
            level: 'info',
        }) + '\n'
    );
    await flush();
    assert.ok(!JSON.stringify(a.frames).includes('ghs_PRIVATE'));
    const b = viewer();
    subscribe(b, 's=first');
    await flush();
    assert.equal(peers.length, 1);
    assert.equal(b.frames.length, 0);
    a.bufferedAmount = 600000;
    peers[0].write(
        JSON.stringify({ type: 'project-log', text: 'second', cursor: 's=second' }) + '\n'
    );
    await flush();
    a.bufferedAmount = 0;
    peers[0].write(
        JSON.stringify({ type: 'project-log', text: 'third', cursor: 's=third' }) + '\n'
    );
    await flush();
    assert.ok(a.frames.some((r) => r.type === 'project-log-gap'));
    assert.ok(b.frames.some((r) => r.cursor === 's=third' && r.project === 'demo'));
    a.emit('message', JSON.stringify({ type: 'project-unsubscribe' }));
    assert.ok(!peers[0].destroyed);
    b.emit('message', JSON.stringify({ type: 'project-unsubscribe' }));
    await flush();
    const invalid = viewer('');
    subscribe(invalid);
    await flush();
    assert.equal(invalid.code, 1008);
    assert.equal(peers.length, 1);
    db.prepare('DELETE FROM sessions').run();
    subscribe(a);
    assert.equal(a.code, 1008);
});
