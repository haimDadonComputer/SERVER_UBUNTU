// Integration for FORMS_PROMPT, not middleware for the management application.
export function configurePublicAccess(app, configuredOrigin = process.env.PUBLIC_ORIGIN || '') {
    let publicOrigin = '';
    if (configuredOrigin) {
        const parsed = new URL(configuredOrigin);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
            parsed.pathname !== '/' || parsed.search || parsed.hash) {
            throw new Error('PUBLIC_ORIGIN must be one HTTPS origin without credentials, path or query');
        }
        publicOrigin = parsed.origin;
        // Nginx must replace Host and all forwarded headers. The server itself
        // remains bound to 127.0.0.1; never trust arbitrary remote proxies.
        app.set('trust proxy', 'loopback');
    }
    app.use((req, res, next) => {
        let requested;
        try { requested = new URL(`${req.protocol}://${req.headers.host}`); }
        catch { return res.status(403).json({ message: 'שם מארח לא מורשה' }); }
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(requested.hostname);
        if (requested.username || requested.password || (!local && requested.origin !== publicOrigin)) {
            return res.status(403).json({ message: 'גישה מקומית בלבד או מכתובת ציבורית מאושרת' });
        }
        if (req.headers.origin && req.headers.origin !== requested.origin) {
            return res.status(403).json({ message: 'מקור הבקשה אינו מורשה' });
        }
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'no-referrer');
        next();
    });
}
