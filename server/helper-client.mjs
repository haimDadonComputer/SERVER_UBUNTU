import net from 'node:net';
import { sanitizeDetails } from './diagnostics.mjs';
export function helperCall(socket, action, args = {}, onEvent) {
    return new Promise((resolve, reject) => {
        const c = net.createConnection(socket);
        c.setEncoding('utf8');
        let data = '';
        let settled = false;
        c.setTimeout(
            ['project-deploy', 'project-start', 'project-restart', 'project-activate'].includes(
                action
            )
                ? 2400000
                : action.startsWith('network-')
                  ? 600000
                  : action === 'project-rollback'
                    ? 300000
                    : 180000
        );
        c.on('connect', () => c.write(JSON.stringify({ action, args }) + '\n'));
        c.on('data', (b) => {
            data += b;
            if (data.length > 8e6) return c.destroy(new Error('Helper response too large'));
            while (data.includes('\n')) {
                const newline = data.indexOf('\n'),
                    line = data.slice(0, newline);
                data = data.slice(newline + 1);
                try {
                    const r = JSON.parse(line);
                    if (r.event) {
                        onEvent?.(r.event);
                        continue;
                    }
                    settled = true;
                    c.end();
                    if (!r.ok)
                        reject(
                            Object.assign(new Error(r.error), {
                                status: 400,
                                details: sanitizeDetails(r.details),
                            })
                        );
                    else resolve(r.data);
                } catch (e) {
                    settled = true;
                    c.destroy();
                    reject(e);
                }
            }
        });
        c.on('end', () => {
            if (!settled)
                c.destroy(
                    Object.assign(new Error('Incomplete helper response'), { code: 'HELPER_EOF' })
                );
        });
        c.on('timeout', () => c.destroy(new Error('System helper timed out')));
        c.on('error', (error) =>
            reject(
                Object.assign(
                    new Error('שכבת המערכת אינה זמינה. יש לבדוק שה־helper הותקן ב־Ubuntu.'),
                    {
                        status: 503,
                        details: {
                            code: error.code || 'HELPER_CONNECTION',
                            stage: 'helper-connection',
                            cwd: process.cwd(),
                            stderr: error.message,
                            hint: 'בדקו ששירות ubuntu-control-helper פעיל ושה־socket נגיש למשתמש Web.',
                        },
                    }
                )
            )
        );
    });
}
