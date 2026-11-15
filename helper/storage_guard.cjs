'use strict';
// A policy for normal Node module loading, not a sandbox for hostile app code.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { registerHooks } = require('node:module');
const roots = JSON.parse(process.env.UC_STORAGE_ROOTS || '[]').map((p) => path.resolve(p));
function forbidden(filename) {
    if (typeof filename !== 'string') return false;
    const candidates = [path.resolve(filename)];
    try {
        candidates.push(fs.realpathSync(filename));
    } catch {}
    return candidates.some((candidate) =>
        roots.some((root) => candidate === root || candidate.startsWith(root + path.sep))
    );
}
registerHooks({
    resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (result.url.startsWith('file:') && forbidden(fileURLToPath(result.url)))
            throw Object.assign(
                new Error('Application modules cannot be loaded from writable storage'),
                { code: 'UC_STORAGE_CODE_BLOCKED' }
            );
        return result;
    },
    load(url, context, next) {
        if (url.startsWith('file:') && forbidden(fileURLToPath(url)))
            throw Object.assign(
                new Error('Application modules cannot be loaded from writable storage'),
                { code: 'UC_STORAGE_CODE_BLOCKED' }
            );
        return next(url, context);
    },
});
