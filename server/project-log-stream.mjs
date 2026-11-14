import net from 'node:net';
import { redact, sessionFromRequest } from './security.mjs';
import { sanitizeDetails } from './diagnostics.mjs';

export function installProjectLogs({ wss, db, socketPath }) {
    const sources = new Map();
    function unsubscribe(ws) {
        const source = sources.get(ws.projectLog);
        if (source) {
            source.clients.delete(ws);
            if (!source.clients.size) {
                source.socket.destroy();
                sources.delete(ws.projectLog);
            }
        }
        ws.projectLog = null;
    }
    function send(ws, data) {
        if (ws.readyState !== 1) return;
        if (!sessionFromRequest(ws.request, db)) {
            unsubscribe(ws);
            ws.close(1008, 'Session expired');
            return;
        }
        if (ws.bufferedAmount > 512000) {
            ws.logGap = true;
            return;
        }
        if (ws.logGap) {
            ws.send(
                JSON.stringify({
                    type: 'project-log-gap',
                    project: ws.projectLog,
                    text: 'החיבור איטי; חלק מההודעות דולגו.',
                })
            );
            ws.logGap = false;
        }
        ws.send(JSON.stringify(data));
    }
    function subscribe(ws, id, cursor) {
        unsubscribe(ws);
        if (!sessionFromRequest(ws.request, db)) {
            ws.close(1008, 'Session expired');
            return;
        }
        const row = db.prepare('SELECT id,lifecycle_json FROM projects WHERE id=?').get(id);
        if (!row) {
            send(ws, { type: 'project-log-error', project: id, error: 'הפרויקט לא נמצא' });
            return;
        }
        let state = {};
        try {
            state = JSON.parse(row.lifecycle_json || '{}');
        } catch {}
        if (state.lifecycle && state.lifecycle !== 'active') {
            send(ws, { type: 'project-log-error', project: id, error: 'הפרויקט אינו פעיל' });
            return;
        }
        ws.projectLog = id;
        let source = sources.get(id);
        if (source) {
            source.clients.add(ws);
            const offset = cursor ? source.ring.findIndex((r) => r.cursor === cursor) + 1 : 0;
            if (cursor && !offset)
                send(ws, {
                    type: 'project-log-gap',
                    project: ws.projectLog,
                    text: 'סמן ההודעות אינו בזיכרון; מוצגות ההודעות הזמינות.',
                });
            for (const record of source.ring.slice(offset || -200))
                send(ws, { ...record, project: id });
            return;
        }
        const socket = net.createConnection(socketPath);
        source = { socket, clients: new Set([ws]), ring: [] };
        sources.set(id, source);
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('connect', () =>
            socket.write(
                JSON.stringify({ action: 'project-log-stream', args: { project: id, cursor } }) +
                    '\n'
            )
        );
        socket.on('data', (chunk) => {
            buffer += chunk;
            if (buffer.length > 1000000) {
                socket.destroy(new Error('Log buffer limit'));
                return;
            }
            let pos;
            while ((pos = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, pos);
                buffer = buffer.slice(pos + 1);
                try {
                    let record = JSON.parse(line);
                    if (record.ok === false)
                        record = {
                            type: 'project-log-error',
                            project: id,
                            error: redact(record.error),
                            details: sanitizeDetails(record.details),
                        };
                    else if (record.type === 'project-log')
                        record = { ...record, text: redact(record.text) };
                    if (record.type === 'project-log') {
                        source.ring.push(record);
                        if (source.ring.length > 500) source.ring.shift();
                    }
                    for (const client of [...source.clients])
                        send(client, { ...record, project: id });
                } catch {}
            }
        });
        socket.on('error', () => {
            for (const client of source.clients)
                send(client, {
                    type: 'project-log-error',
                    project: id,
                    error: 'חיבור לוגי הפרויקט נסגר. נסו לפתוח מחדש את הקונסול.',
                });
        });
        socket.on('close', () => {
            if (sources.get(id) === source) {
                sources.delete(id);
                for (const client of source.clients) {
                    send(client, { type: 'project-log-reconnect', project: id });
                    client.projectLog = null;
                }
            }
        });
    }
    wss.on('connection', (ws, request) => {
        ws.request = request;
        ws.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                if (
                    data.type === 'project-logs' &&
                    typeof data.project === 'string' &&
                    /^[a-z][a-z0-9-]{1,40}$/.test(data.project) &&
                    (!data.cursor ||
                        (typeof data.cursor === 'string' && data.cursor.length <= 1024))
                )
                    subscribe(ws, data.project, data.cursor);
                if (data.type === 'project-unsubscribe') unsubscribe(ws);
            } catch {}
        });
        ws.on('close', () => unsubscribe(ws));
    });
    const expiry = setInterval(() => {
        for (const ws of wss.clients)
            if (ws.projectLog && !sessionFromRequest(ws.request, db)) {
                unsubscribe(ws);
                ws.close(1008, 'Session expired');
            }
    }, 5000);
    expiry.unref();
    return () => {
        clearInterval(expiry);
        for (const source of sources.values()) source.socket.destroy();
        sources.clear();
    };
}
