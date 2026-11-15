import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { configurePublicAccess } from '../integrations/forms-prompt/public-access.mjs';

test('forms adapter keeps local default and allows only the explicit public origin behind loopback proxy', async () => {
    for (const origin of ['', 'https://forms.example.com']) {
        const app = express();
        configurePublicAccess(app, origin);
        app.get('/', (_req, res) => res.json({ ok: true }));
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        try {
            const endpoint = `http://127.0.0.1:${server.address().port}/`;
            assert.equal((await fetch(endpoint)).status, 200);
            const request = (host, originHeader, extra = {}) =>
                new Promise((resolve, reject) =>
                    http
                        .get(
                            endpoint,
                            {
                                headers: {
                                    Host: host,
                                    'X-Forwarded-Proto': 'https',
                                    ...extra,
                                    ...(originHeader ? { Origin: originHeader } : {}),
                                },
                            },
                            (response) => {
                                response.resume();
                                resolve({ status: response.statusCode });
                            }
                        )
                        .on('error', reject)
                );
            assert.equal(
                (await request('forms.example.com', 'https://forms.example.com')).status,
                origin ? 200 : 403
            );
            assert.equal((await request('evil.example.com')).status, 403);
            assert.equal(
                (await request('forms.example.com', 'https://evil.example.com')).status,
                403
            );
            assert.equal(
                (
                    await request('evil.example.com', undefined, {
                        'X-Forwarded-Host': 'forms.example.com',
                    })
                ).status,
                403
            );
        } finally {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    }
    for (const origin of [
        'http://forms.example.com',
        'https://user:pass@forms.example.com',
        'https://forms.example.com/path',
    ])
        assert.throws(() => configurePublicAccess(express(), origin));
});
