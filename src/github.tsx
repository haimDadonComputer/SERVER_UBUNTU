import React, { useEffect, useState } from 'react';
import { GitBranch, RefreshCw, Loader2, Search } from 'lucide-react';
import { ErrorDetails } from './diagnostics';
type Data = Record<string, any>;
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export function GitHubSettings({ totpEnabled, api }: { totpEnabled: boolean; api: Api }) {
    const [state, setState] = useState<Data>({}),
        [appId, setAppId] = useState(''),
        [installationId, setInstallationId] = useState(''),
        [password, setPassword] = useState(''),
        [code, setCode] = useState(''),
        [busy, setBusy] = useState(false),
        [error, setError] = useState(''),
        [details, setDetails] = useState<Data | null>(null),
        [notice, setNotice] = useState('');
    function update(s: Data) {
        setState(s);
        setAppId(s.appId || '');
        setInstallationId(s.installationId || '');
    }
    useEffect(() => {
        api('/github/status')
            .then(update)
            .catch((e) => setError(e.message));
    }, []);
    async function execute(action: string) {
        if (busy) return;
        setBusy(true);
        setError('');
        setNotice('');
        try {
            if (action === 'configure')
                update(
                    await api('/github/configure', 'POST', {
                        appId,
                        installationId,
                        password,
                        ...(totpEnabled ? { code } : {}),
                    })
                );
            if (action === 'check') update(await api('/github/check', 'POST', {}));
            if (action === 'refresh') {
                const repos = await api('/github/refresh', 'POST', {});
                setNotice(`רשימת המאגרים רועננה: ${repos.length} מאגרים זמינים להתקנה.`);
            }
            if (action === 'disconnect') {
                update(
                    await api('/github/disconnect', 'POST', {
                        password,
                        ...(totpEnabled ? { code } : {}),
                    })
                );
                setNotice('החיבור נותק מקומית.');
            }
            setPassword('');
            setCode('');
        } catch (e) {
            setError((e as Error).message);
            setDetails((e as Data).details || null);
            api('/github/status')
                .then((s) => setState(s))
                .catch(() => {});
        } finally {
            setBusy(false);
        }
    }
    const labels: Data = {
        connected: 'מחובר',
        unchecked: 'טרם נבדק',
        disconnected: 'מנותק',
        'not-configured': 'טרם הוגדר',
        error: 'שגיאת חיבור',
    };
    return (
        <section className="panel">
            <div className="panel-heading">
                <h2>
                    <GitBranch size={19} />
                    GitHub App
                </h2>
                <span
                    className={'badge ' + (state.connection === 'connected' ? 'active' : 'unknown')}
                >
                    {labels[state.connection] || 'לא זמין'}
                </span>
            </div>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    void execute('configure');
                }}
            >
                <label>
                    App ID
                    <input
                        aria-label="GitHub App ID"
                        inputMode="numeric"
                        required
                        pattern="[1-9][0-9]*"
                        value={appId}
                        onChange={(e) => setAppId(e.target.value)}
                    />
                </label>
                <label>
                    Installation ID
                    <input
                        aria-label="GitHub Installation ID"
                        inputMode="numeric"
                        required
                        pattern="[1-9][0-9]*"
                        value={installationId}
                        onChange={(e) => setInstallationId(e.target.value)}
                    />
                </label>
                <label>
                    נתיב PEM (קבוע בשרת)
                    <input className="mono" readOnly value="/etc/ubuntu-control/github/app.pem" />
                </label>
                <p className="muted">
                    רק שירות GitHub הייעודי קורא את המפתח. בחירת All repositories מתבצעת בהתקנה
                    ב־GitHub; כאן מוצגים כל המאגרים הזמינים לה.
                </p>
                <label>
                    סיסמה נוכחית לשמירה או ניתוק
                    <input
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </label>
                {totpEnabled && (
                    <label>
                        קוד אימות דו־שלבי
                        <input
                            autoComplete="one-time-code"
                            value={code}
                            maxLength={6}
                            onChange={(e) => setCode(e.target.value)}
                        />
                    </label>
                )}
                <div className="project-controls">
                    <button className="primary" disabled={busy || !password}>
                        שמירת חיבור
                    </button>
                    <button
                        type="button"
                        className="secondary"
                        disabled={busy || !state.enabled}
                        onClick={() => void execute('check')}
                    >
                        בדיקת חיבור
                    </button>
                    <button
                        type="button"
                        className="secondary"
                        disabled={busy || !state.enabled}
                        onClick={() => void execute('refresh')}
                    >
                        <RefreshCw size={14} />
                        רענון מאגרים
                    </button>
                    <button
                        type="button"
                        className="text-btn"
                        disabled={busy || !state.enabled || !password}
                        onClick={() => void execute('disconnect')}
                    >
                        ניתוק GitHub App
                    </button>
                    {busy && <Loader2 size={16} className="spin" />}
                </div>
                <p className="muted">
                    בדיקה אחרונה:{' '}
                    {state.checkedAt
                        ? new Date(state.checkedAt).toLocaleString('he-IL')
                        : 'טרם נבדק'}
                </p>
                {error && (
                    <div className="alert error" role="alert">
                        <div className="grow">
                            {error}
                            <ErrorDetails details={details} />
                        </div>
                    </div>
                )}
                {state.error && !error && <div className="alert warning">{state.error}</div>}
                {notice && (
                    <div className="alert success" role="status">
                        {notice}
                    </div>
                )}
            </form>
        </section>
    );
}
export function GitHubImport({
    projects,
    services,
    onDone,
    api,
}: {
    projects: Data[];
    services: Data[];
    onDone: () => void;
    api: Api;
}) {
    const [repos, setRepos] = useState<Data[]>([]),
        [selected, setSelected] = useState<Data | null>(null),
        [query, setQuery] = useState(''),
        [filter, setFilter] = useState('all'),
        [sort, setSort] = useState('updated'),
        [id, setId] = useState(''),
        [name, setName] = useState(''),
        [kind, setKind] = useState('node'),
        [service, setService] = useState(''),
        [port, setPort] = useState(''),
        [busy, setBusy] = useState(false),
        [error, setError] = useState(''),
        [details, setDetails] = useState<Data | null>(null),
        [loading, setLoading] = useState(true),
        [confirmed, setConfirmed] = useState(false);
    async function refresh() {
        setLoading(true);
        setError('');
        try {
            setRepos(await api('/github/refresh', 'POST', {}));
        } catch (e) {
            setError((e as Error).message);
            setDetails((e as Data).details || null);
        } finally {
            setLoading(false);
        }
    }
    useEffect(() => {
        void refresh();
    }, []);
    const visible = repos
        .filter(
            (r) =>
                (r.full_name + ' ' + r.description).toLowerCase().includes(query.toLowerCase()) &&
                (filter === 'all' ||
                    (filter === 'private' && r.private) ||
                    (filter === 'public' && !r.private) ||
                    (filter === 'archived' && r.archived))
        )
        .sort((a, b) =>
            sort === 'name'
                ? a.full_name.localeCompare(b.full_name)
                : String(b.updated_at).localeCompare(String(a.updated_at))
        );
    return (
        <div className="github-import">
            <p className="muted">
                כל המאגרים שההתקנה רשאית לקרוא, כולל פרטיים. בחרו מאגר ותיקייה חדשה או תיקיית פרויקט
                קיימת וריקה. ייבוא מוריד קוד בלבד; פריסה והפעלה נעשות בנפרד.
            </p>
            <div className="toolbar">
                <label className="search">
                    <Search size={16} />
                    <input
                        aria-label="חיפוש מאגרי GitHub"
                        placeholder="חיפוש שם או תיאור…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                </label>
                <select
                    aria-label="סינון מאגרים"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                >
                    <option value="all">כל המאגרים</option>
                    <option value="private">פרטיים</option>
                    <option value="public">ציבוריים</option>
                    <option value="archived">בארכיון</option>
                </select>
                <select
                    aria-label="מיון מאגרים"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                >
                    <option value="updated">עודכנו לאחרונה</option>
                    <option value="name">לפי שם</option>
                </select>
                <button
                    type="button"
                    className="secondary"
                    disabled={loading || busy}
                    onClick={() => void refresh()}
                >
                    <RefreshCw size={14} />
                    רענון
                </button>
            </div>
            {loading ? (
                <p>
                    <Loader2 className="spin" size={17} />
                    טוען מאגרים…
                </p>
            ) : (
                <div className="github-repositories">
                    {visible.map((r) => (
                        <button
                            type="button"
                            key={r.id}
                            disabled={r.archived || busy}
                            className={
                                'github-repository ' + (selected?.id === r.id ? 'chosen' : '')
                            }
                            onClick={() => {
                                setSelected(r);
                                setId(
                                    r.name
                                        .toLowerCase()
                                        .replace(/[^a-z0-9-]/g, '-')
                                        .replace(/^[^a-z]+/, 'app-')
                                        .slice(0, 41)
                                );
                                setName(r.name);
                                setConfirmed(false);
                            }}
                        >
                            <strong className="mono">{r.full_name}</strong>
                            <span>{r.description || 'ללא תיאור'}</span>
                            <small>
                                {r.private ? 'פרטי' : 'ציבורי'} · {r.archived ? 'בארכיון · ' : ''}
                                {r.fork ? 'Fork · ' : ''}ענף {r.default_branch} ·{' '}
                                {r.updated_at
                                    ? new Date(r.updated_at).toLocaleDateString('he-IL')
                                    : 'ללא תאריך עדכון'}
                            </small>
                        </button>
                    ))}
                    {!visible.length && (
                        <p className="muted">
                            אין מאגרים להצגה. בדקו חיבור והרשאות GitHub App בהגדרות.
                        </p>
                    )}
                </div>
            )}
            {selected && (
                <form
                    onSubmit={async (e) => {
                        e.preventDefault();
                        if (busy || !confirmed) return;
                        setBusy(true);
                        setError('');
                        try {
                            await api('/github/import', 'POST', {
                                id,
                                name,
                                repositoryId: selected.id,
                                confirmed: true,
                                kind,
                                ...(service ? { service, health_port: Number(port) } : {}),
                            });
                            onDone();
                        } catch (e) {
                            setError((e as Error).message);
                            setDetails((e as Data).details || null);
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    <label>
                        שם תיקייה באנגלית
                        <input
                            name="github-folder"
                            required
                            pattern="[a-z][a-z0-9-]{1,40}"
                            value={id}
                            onChange={(e) => setId(e.target.value)}
                        />
                    </label>
                    <label>
                        שם לתצוגה
                        <input
                            name="github-project-name"
                            required
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </label>
                    {!projects.some((p) => p.id === id) && (
                        <>
                            <label>
                                סוג הפרויקט
                                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                                    <option value="node">Node.js</option>
                                    <option value="docker">Docker</option>
                                </select>
                            </label>
                            <label>
                                שירות לפריסה (לא חובה)
                                <select
                                    value={service}
                                    onChange={(e) => setService(e.target.value)}
                                >
                                    <option value="">ייבוא קוד בלבד</option>
                                    {services.map((s) => (
                                        <option value={s.id} key={s.id}>
                                            {s.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            {service && (
                                <label>
                                    פורט בדיקת תקינות
                                    <input
                                        type="number"
                                        min={1024}
                                        max={65535}
                                        required
                                        value={port}
                                        onChange={(e) => setPort(e.target.value)}
                                    />
                                </label>
                            )}
                        </>
                    )}
                    {projects.some((p) => p.id === id) && (
                        <p className="muted">
                            הפרויקט כבר קיים. הייבוא יתקבל רק אם התיקייה ריקה; קבצים קיימים לא
                            יימחקו.
                        </p>
                    )}
                    <label className="checkbox-label">
                        <input
                            type="checkbox"
                            checked={confirmed}
                            onChange={(e) => setConfirmed(e.target.checked)}
                        />
                        אני מאשר ייבוא מהמאגר הנבחר באמצעות הרשאת קריאה בלבד.
                    </label>
                    <button className="primary" disabled={busy || !confirmed}>
                        {busy ? <Loader2 size={15} className="spin" /> : <GitBranch size={15} />}
                        ייבוא המאגר
                    </button>
                </form>
            )}
            {error && (
                <div role="alert" className="alert error">
                    <div className="grow">
                        {error}
                        <ErrorDetails details={details} />
                    </div>
                </div>
            )}
        </div>
    );
}
