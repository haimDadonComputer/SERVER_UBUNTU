import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config, validateConfig } from './config.mjs';
import { openDatabase } from './db.mjs';
import { createApp } from './app.mjs';
import { helperCall } from './helper-client.mjs';
import { sessionFromRequest, redact } from './security.mjs';
import { metrics } from './metrics.mjs';
import { ProjectUpdater } from './project-updater.mjs';
import { reconcileProjects } from './project-lifecycle.mjs';
import { installProjectLogs } from './project-log-stream.mjs';
validateConfig();
const db = openDatabase(config.data),
    helper = (a, b) => helperCall(config.socket, a, b);
const { app, queue } = await createApp({ db, config, helper });
await reconcileProjects(db, helper).catch(() => {});
const updater = new ProjectUpdater({ db, helper, queue });
updater.start();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
const stopProjectLogs = installProjectLogs({ wss, db, socketPath: config.socket });
server.on('upgrade', (req, socket, head) => {
    if (
        req.url !== '/ws' ||
        req.headers.origin !== config.origin ||
        !sessionFromRequest(req, db) ||
        wss.clients.size >= 30
    ) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws, req) => {
    ws.request = req;
    ws.on('error', () => {});
    ws.on('message', (data) => {
        try {
            const input = JSON.parse(data.toString());
            if (
                input.type === 'logs' &&
                typeof input.service === 'string' &&
                input.service.length <= 100
            ) {
                ws.service = input.service;
                ws.lastLog = null;
            }
            if (input.type === 'unsubscribe') ws.service = null;
        } catch {
            ws.close(1008);
        }
    });
});
let busy = false,
    lastSnapshot = 0;
const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
        if (!wss.clients.size) return;
        const setting = db.prepare("SELECT value FROM settings WHERE key='preferences'").get();
        const refresh = setting ? JSON.parse(setting.value).refresh : 5;
        if (Date.now() - lastSnapshot < refresh * 1000) return;
        lastSnapshot = Date.now();
        const m = await metrics();
        let inv;
        try {
            inv = await helper('inventory');
        } catch (e) {
            inv = { error: e.message };
        }
        const logCache = new Map();
        for (const ws of wss.clients) {
            if (!sessionFromRequest(ws.request, db)) {
                ws.close(1008, 'Session expired');
                continue;
            }
            if (ws.readyState !== 1 || ws.bufferedAmount > 1e6) continue;
            ws.send(JSON.stringify({ type: 'snapshot', metrics: m, inventory: inv }));
            if (ws.service) {
                try {
                    if (!logCache.has(ws.service))
                        logCache.set(
                            ws.service,
                            redact(await helper('logs', { service: ws.service }))
                        );
                    const text = logCache.get(ws.service);
                    if (text !== ws.lastLog) {
                        ws.send(
                            JSON.stringify({
                                type: 'logs',
                                service: ws.service,
                                text,
                                time: new Date().toISOString(),
                            })
                        );
                        ws.lastLog = text;
                    }
                } catch {
                    ws.send(
                        JSON.stringify({ type: 'log-error', error: 'לא ניתן לקרוא את הלוגים' })
                    );
                }
            }
        }
    } finally {
        busy = false;
    }
}, 1000);
server.listen(config.port, config.host, () =>
    console.log(`Ubuntu Control listening on ${config.host}:${config.port}`)
);
function shutdown() {
    stopProjectLogs();
    updater.stop();
    clearInterval(timer);
    for (const ws of wss.clients) ws.close(1001);
    server.close(async () => {
        await queue.tail;
        db.close();
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
