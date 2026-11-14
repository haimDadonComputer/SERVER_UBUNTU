import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
// @ts-ignore The backend intentionally uses native ESM without TypeScript compilation.
import { openDatabase } from '../../server/db.mjs';
// @ts-ignore
import { createApp } from '../../server/app.mjs';
import argon2 from 'argon2';
let server: http.Server, dir: string, db: any, base: string;
test.beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uc-ui-'));
    db = openDatabase(dir);
    db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run(
        'test-admin',
        await argon2.hash('test-only-long-password')
    );
    server = http.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + (server.address() as any).port;
    const { app } = await createApp({
        db,
        config: {
            data: dir,
            dev: true,
            origin: base,
            key: 'cd'.repeat(32),
            projects: dir,
            host: '127.0.0.1',
            port: 3080,
        },
        helper: async () => {
            throw Object.assign(
                new Error('System helper is not installed in this Windows UI test'),
                { status: 503 }
            );
        },
    });
    server.on('request', app);
});
test.afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
});
test('desktop login, real API session, RTL navigation, honest system errors and mobile layout', async ({
    page,
}) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(base);
    await expect(page.getByRole('heading', { name: 'ברוכים הבאים בחזרה' })).toBeVisible();
    await page.locator('input[name=username]').fill('test-admin');
    await page.locator('input[name=password]').fill('test-only-long-password');
    await page.getByRole('button', { name: 'כניסה מאובטחת' }).click();
    await expect(page.getByRole('heading', { name: 'סקירת השרת' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByText('נתוני Ubuntu אינם זמינים')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'תעבורת רשת' })).toBeVisible();
    await expect(page.getByText('פג תוקף ההתחברות. יש להתחבר מחדש.')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'פורטים ושירותים', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'פורטים ושירותים', exact: true })).toBeVisible();
    await expect(page.getByText('אין פורטים להצגה')).toBeVisible();
    await page.getByRole('button', { name: 'פרויקטים', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'הפרויקטים שלי' })).toBeVisible();
    await page.getByRole('button', { name: 'הוספת פרויקט' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'ביטול', exact: true }).click();
    await page.getByRole('button', { name: 'הגדרות ואבטחה', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'התחברות ואבטחה' })).toBeVisible();
    await page.getByRole('button', { name: 'החלפת ערכת צבעים' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'לוח בקרה', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'סקירת השרת' })).toBeVisible();
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    ).toBeTruthy();
    await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
});
