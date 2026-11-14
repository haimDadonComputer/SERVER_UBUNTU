import os from 'node:os';
import fs from 'node:fs/promises';
let previousCpu = null,
    previousNetwork = null;
export async function metrics() {
    const cpus = os.cpus();
    const total = cpus.reduce((a, c) => a + Object.values(c.times).reduce((a, b) => a + b, 0), 0);
    const idle = cpus.reduce((a, c) => a + c.times.idle, 0);
    const cpu =
        previousCpu && total > previousCpu.total
            ? 100 * (1 - (idle - previousCpu.idle) / (total - previousCpu.total))
            : null;
    previousCpu = { total, idle };
    let availableMemory = os.freemem();
    let disk = null,
        network = null;
    if (process.platform === 'linux') {
        try {
            const info = await fs.readFile('/proc/meminfo', 'utf8');
            const available = info.match(/^MemAvailable:\s+(\d+) kB/m);
            if (available) availableMemory = Number(available[1]) * 1024;
        } catch {}
        try {
            const s = await fs.statfs('/');
            disk = {
                total: s.blocks * s.bsize,
                free: s.bavail * s.bsize,
                used: (s.blocks - s.bfree) * s.bsize,
            };
        } catch {}
        try {
            const text = await fs.readFile('/proc/net/dev', 'utf8');
            let rx = 0,
                tx = 0;
            for (const line of text.split('\n').slice(2)) {
                const [iface, data] = line.split(':');
                if (!data || iface.trim() === 'lo') continue;
                const n = data.trim().split(/\s+/).map(Number);
                rx += n[0];
                tx += n[8];
            }
            const now = Date.now();
            network = {
                rx,
                tx,
                rxRate: previousNetwork
                    ? Math.max(0, ((rx - previousNetwork.rx) * 1000) / (now - previousNetwork.time))
                    : null,
                txRate: previousNetwork
                    ? Math.max(0, ((tx - previousNetwork.tx) * 1000) / (now - previousNetwork.time))
                    : null,
            };
            previousNetwork = { rx, tx, time: now };
        } catch {}
    }
    return {
        hostname: os.hostname(),
        platform: process.platform,
        cpu,
        memory: { total: os.totalmem(), used: os.totalmem() - availableMemory },
        disk,
        network,
        uptime: os.uptime(),
        time: new Date().toISOString(),
    };
}
