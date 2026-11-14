import 'dotenv/config';
import path from 'node:path';
export const config = {
    port: Number(process.env.PORT || 3080),
    host: process.env.HOST || '127.0.0.1',
    origin: process.env.PUBLIC_ORIGIN || 'http://localhost:5173',
    data: path.resolve(process.env.DATA_DIR || 'data'),
    socket: process.env.HELPER_SOCKET || '/run/ubuntu-control/helper.sock',
    projects: path.resolve(process.env.PROJECT_ROOT || 'data/projects'),
    dev: process.env.LOCAL_DEV === 'true',
    key: process.env.MASTER_KEY || '',
};
export function validateConfig() {
    if (!/^[a-f0-9]{64}$/i.test(config.key))
        throw new Error('MASTER_KEY must contain 64 hex characters');
    if (!config.dev && !config.origin.startsWith('https://'))
        throw new Error('HTTPS PUBLIC_ORIGIN required');
    if (!['127.0.0.1', '::1', 'localhost'].includes(config.host))
        throw new Error(
            'Loopback binding is required. Use a VPN HTTPS reverse proxy for remote access.'
        );
    if (process.platform === 'linux' && process.getuid() === 0)
        throw new Error('Web application must not run as root');
}
