import { redact } from './security.mjs';
const fields = new Set([
    'code',
    'stage',
    'action',
    'user',
    'uid',
    'cwd',
    'exitCode',
    'timeoutSeconds',
    'command',
    'stdout',
    'stderr',
    'hint',
    'time',
    'launcher',
    'httpStatus',
    'requestId',
    'retryAfter',
]);
export function sanitizeDetails(value, depth = 0) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return null;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (!fields.has(key)) continue;
        if (Array.isArray(item))
            result[key] = item.slice(0, 80).map((v) => redact(String(v)).slice(0, 1000));
        else if (item && typeof item === 'object') result[key] = sanitizeDetails(item, depth + 1);
        else if (typeof item === 'number' || item === null) result[key] = item;
        else result[key] = redact(String(item)).slice(-12000);
    }
    return result;
}
export function storedDetails(value) {
    try {
        return sanitizeDetails(JSON.parse(value));
    } catch {
        return null;
    }
}
