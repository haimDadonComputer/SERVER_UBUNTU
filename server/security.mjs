import crypto from 'node:crypto';
import * as OTPAuth from 'otpauth';
export const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const token = () => crypto.randomBytes(32).toString('hex');
export function equal(a, b) {
    return (
        typeof a === 'string' &&
        typeof b === 'string' &&
        a.length === b.length &&
        crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
    );
}
export function seal(value, key) {
    const iv = crypto.randomBytes(12),
        c = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return [iv.toString('hex'), c.getAuthTag().toString('hex'), data.toString('hex')].join('.');
}
export function unseal(value, key) {
    const [iv, tag, data] = value.split('.');
    const c = crypto.createDecipheriv(
        'aes-256-gcm',
        Buffer.from(key, 'hex'),
        Buffer.from(iv, 'hex')
    );
    c.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([c.update(Buffer.from(data, 'hex')), c.final()]).toString();
}
export function totp(secret, label = 'Ubuntu Control') {
    return new OTPAuth.TOTP({
        issuer: 'Ubuntu Control',
        label,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret),
    });
}
export function redact(text) {
    return String(text)
        .replace(/(?:otpauth:\/\/|-----BEGIN [^-]*PRIVATE KEY-----)[\s\S]*/gi, '[REDACTED]')
        .replace(/(bearer\s+)[\w.\-]+/gi, '$1[REDACTED]')
        .replace(
            /(?<![\w-])((?:["']?[\w-]{0,80}(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|qr|session)[\w-]{0,80}["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
            '$1[REDACTED]'
        )
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
        .replace(
            /\b(?:gh[pousr]_[\w.\-]+|github_pat_[\w.\-]+|eyJ[\w\-]+\.[\w\-]+\.[\w\-]+)\b/g,
            '[REDACTED]'
        );
}
export function sessionFromRequest(req, db, { touch = false } = {}) {
    const raw = (req.headers.cookie || '')
        .split(';')
        .map((x) => x.trim())
        .find((x) => x.startsWith('uc_session='))
        ?.slice(11);
    if (!raw) return null;
    const s = db
        .prepare(
            'SELECT sessions.*,users.username FROM sessions JOIN users ON users.id=user_id WHERE hash=?'
        )
        .get(hash(raw));
    const now = Date.now();
    if (!s || now - s.touched > 15 * 60e3 || now - s.created > 8 * 3600e3) {
        if (s) db.prepare('DELETE FROM sessions WHERE hash=?').run(s.hash);
        return null;
    }
    if (touch) db.prepare('UPDATE sessions SET touched=? WHERE hash=?').run(now, s.hash);
    return s;
}
