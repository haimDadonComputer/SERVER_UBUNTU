import net from 'node:net';
import { sanitizeDetails } from './diagnostics.mjs';
export function helperCall(socket, action, args = {}) {
    return new Promise((resolve, reject) => {
        const c = net.createConnection(socket);
        c.setEncoding('utf8');
        let data = '';
        c.setTimeout(action === 'project-deploy' ? 900000 : 180000);
        c.on('connect', () => c.write(JSON.stringify({ action, args }) + '\n'));
        c.on('data', (b) => {
            data += b;
            if (data.length > 8e6) c.destroy(new Error('Helper response too large'));
            if (data.includes('\n')) {
                c.end();
                try {
                    const r = JSON.parse(data.split('\n')[0]);
                    if (!r.ok)
                        reject(
                            Object.assign(new Error(r.error), {
                                status: 400,
                                details: sanitizeDetails(r.details),
                            })
                        );
                    else resolve(r.data);
                } catch (e) {
                    reject(e);
                }
            }
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
