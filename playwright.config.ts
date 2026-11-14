import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: 'tests/ui',
    workers: 1,
    use: {
        browserName: 'chromium',
        ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
    },
    reporter: 'list',
});
