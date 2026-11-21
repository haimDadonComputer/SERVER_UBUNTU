type Data = Record<string, any>;

/** Resolve links without changing runtime/publication configuration. */
export function projectAccess(
    project: Data,
    addresses: Data[],
    publication: Data | undefined,
    managementHosts: string[],
    currentHost: string
) {
    const normalize = (host: string) => host.toLowerCase().replace(/\.$/, '');
    const reserved = [...managementHosts, currentHost].map(normalize);
    const safe = (value: unknown) => {
        if (typeof value !== 'string' || !value) return '';
        try {
            const url = new URL(value);
            const host = normalize(url.hostname);
            if (
                !['http:', 'https:'].includes(url.protocol) ||
                url.username ||
                url.password ||
                host === 'localhost' ||
                host.endsWith('.localhost') ||
                host === '[::1]' ||
                /^127\./.test(host) ||
                host === '0.0.0.0' ||
                reserved.some((name) => host === name || host.endsWith('.' + name))
            )
                return '';
            return url.href;
        } catch {
            return '';
        }
    };
    for (const candidate of [publication?.url, project.launch_url]) {
        const url = safe(candidate);
        if (url) return { url, reason: '' };
    }
    const runtime = project.runtime;
    if (
        runtime?.health === 'http' &&
        runtime.listenAddress === '0.0.0.0' &&
        Number.isInteger(runtime.port) &&
        runtime.port >= 1024 &&
        runtime.port <= 65535
    ) {
        for (const entry of addresses) {
            const address = entry.address;
            if (
                typeof address !== 'string' ||
                !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) ||
                address.split('.').some((part) => Number(part) > 255)
            )
                continue;
            const url = safe(`http://${address}:${runtime.port}/`);
            if (url) return { url, reason: '' };
        }
    }
    return {
        url: '',
        reason:
            project.lifecycle === 'archived'
                ? 'הפרויקט בארכיון'
                : !runtime
                  ? 'טרם הוגדרה סביבת הפעלה'
                  : runtime.health !== 'http'
                    ? 'הפרויקט מוגדר כתהליך ללא כתובת Web'
                    : runtime.listenAddress !== '0.0.0.0'
                      ? 'הפרויקט מאזין מקומית בשרת; ניתן להשתמש בפרסום באינטרנט'
                      : 'לא התקבלה כתובת שרת מתאימה לגישה',
    };
}
