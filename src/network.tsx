import React, { useEffect, useState } from 'react';
import { ErrorDetails } from './diagnostics';
type Data = Record<string, any>;
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export function NetworkSettings({
    api,
    totpEnabled,
    project,
    onQueued,
}: {
    api: Api;
    totpEnabled: boolean;
    project?: Data;
    onQueued?: () => void;
}) {
    const [state, setState] = useState<Data | null>(null),
        [fields, setFields] = useState<Data>({ ip: '', domain: '', email: '' });
    const [password, setPassword] = useState(''),
        [code, setCode] = useState(''),
        [busy, setBusy] = useState(false),
        [error, setError] = useState(''),
        [details, setDetails] = useState<Data | null>(null),
        [notice, setNotice] = useState('');
    const [port, setPort] = useState(project?.runtime?.port || 3000),
        [https, setHttps] = useState(true),
        [confirmed, setConfirmed] = useState(false);
    async function refresh() {
        const data = await api('/network');
        setState(data);
        return data;
    }
    useEffect(() => {
        void refresh()
            .then((data) => {
                setFields({ ip: data.ip, domain: data.domain, email: data.email });
                const p = project && data.projects[project.id];
                if (p) {
                    setPort(p.port);
                    setHttps(p.https);
                }
            })
            .catch((e) => setError(e.message));
    }, [project?.id]);
    async function submit(path: string, method: string, body: Data) {
        setBusy(true);
        setError('');
        setNotice('');
        try {
            const result = await api(path, method, {
                ...body,
                password,
                ...(totpEnabled ? { code } : {}),
            });
            setPassword('');
            setCode('');
            setConfirmed(false);
            setNotice(
                result.job
                    ? 'הפעולה נוספה לפאנל המשימות. רעננו את המצב לאחר סיומה.'
                    : 'ההגדרות נשמרו'
            );
            if (result.job) onQueued?.();
            await refresh();
        } catch (e) {
            setError((e as Error).message);
            setDetails((e as Data).details);
        } finally {
            setBusy(false);
        }
    }
    const publication = project && state?.projects?.[project.id];
    return (
        <section className="panel network-settings">
            <div className="panel-heading">
                <h2>{project ? 'פרסום הפרויקט באינטרנט' : 'כתובות שרת ופרסום ציבורי'}</h2>
                <button
                    type="button"
                    onClick={() => void refresh().catch((e) => setError(e.message))}
                >
                    רענון מצב
                </button>
            </div>
            {!project && (
                <>
                    {['ip', 'domain', 'email'].map((key, i) => (
                        <label key={key}>
                            {['IP ציבורי לפרויקטים', 'דומיין נפרד לניהול', 'דוא״ל לתעודות'][i]}
                            <input
                                value={fields[key]}
                                onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
                            />
                        </label>
                    ))}
                </>
            )}
            {project && (
                <>
                    <p>כתובת השרת: {state?.ip || 'יש להגדיר IP בהגדרות ואבטחה'}</p>
                    <p>
                        מצב פרסום: {publication ? 'מופעל' : 'פרטי'} · מאזין מקומי של ה־proxy:{' '}
                        {publication?.listening ? 'פעיל' : 'לא אומת'}
                    </p>
                    {publication && (
                        <a href={publication.url} target="_blank" rel="noreferrer">
                            {publication.url}
                        </a>
                    )}
                    <label>
                        פורט ציבורי
                        <input
                            type="number"
                            min="1024"
                            max="65535"
                            value={port}
                            onChange={(e) => setPort(Number(e.target.value))}
                        />
                    </label>
                    <label className="checkbox-label">
                        <input
                            type="checkbox"
                            checked={https}
                            onChange={(e) => setHttps(e.target.checked)}
                        />
                        HTTPS עם תעודה ציבורית
                    </label>
                    <p>
                        ה־proxy יאזין ב־IP הציבורי בפורט {port} ויפנה ל־localhost:
                        {project.runtime?.port || '—'}. הפרויקט צריך להיות מוגדר להאזנה מקומית.
                    </p>
                </>
            )}
            <p>
                הכנת פרסום:{' '}
                {state?.prepared
                    ? 'מוכנה'
                    : 'נדרש sudo bash /opt/ubuntu-control/scripts/setup-publication.sh'}
            </p>
            <p>נגישות מרשת חיצונית: טרם אומתה. יש לבדוק גם את חומת האש של Contabo.</p>
            {!project && (
                <>
                    <p>
                        ניהול ציבורי: {state?.management ? 'https://' + state.domain : 'כבוי'} ·
                        גישת Tailscale נשמרת
                    </p>
                    {Object.entries(state?.certificates || {}).map(([kind, value]) => (
                        <p key={kind}>
                            {kind}: {(value as Data).status} ·{' '}
                            {(value as Data).validity || 'אין מידע על תוקף'}
                        </p>
                    ))}
                    <pre className="code">{state?.renewal}</pre>
                </>
            )}
            <label>
                סיסמה נוכחית
                <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
            </label>
            {totpEnabled && (
                <label>
                    קוד TOTP
                    <input
                        inputMode="numeric"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                    />
                </label>
            )}
            <label className="checkbox-label">
                <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                />
                אני מאשר/ת שינוי בתצורת הפרסום ובכללי חומת האש שבניהול המערכת
            </label>
            {project ? (
                <div className="project-controls">
                    <button
                        disabled={busy || !confirmed || !password}
                        onClick={() =>
                            void submit(`/projects/${project.id}/publication`, 'POST', {
                                enabled: true,
                                confirmed: true,
                                port,
                                https,
                            })
                        }
                    >
                        פתיחה לאינטרנט
                    </button>
                    <button
                        disabled={busy || !confirmed || !password || !publication}
                        onClick={() =>
                            void submit(`/projects/${project.id}/publication`, 'POST', {
                                enabled: false,
                                confirmed: true,
                            })
                        }
                    >
                        ביטול פרסום
                    </button>
                </div>
            ) : (
                <div className="project-controls">
                    <button
                        disabled={busy || !password}
                        onClick={() => void submit('/network', 'PATCH', fields)}
                    >
                        שמירת כתובות
                    </button>
                    <button
                        disabled={busy || !password || !confirmed || !state?.domain}
                        onClick={() =>
                            void submit('/network/management', 'POST', {
                                enabled: true,
                                confirmed: true,
                                https: true,
                            })
                        }
                    >
                        הפעלת ניהול ציבורי
                    </button>
                    <button
                        disabled={busy || !password || !confirmed || !state?.management}
                        onClick={() =>
                            void submit('/network/management', 'POST', {
                                enabled: false,
                                confirmed: true,
                            })
                        }
                    >
                        ביטול ניהול ציבורי
                    </button>
                    {['ip', 'management'].map((kind) => (
                        <button
                            key={kind}
                            disabled={busy || !password || !confirmed}
                            onClick={() =>
                                void submit('/network/certificates/test', 'POST', {
                                    kind,
                                    confirmed: true,
                                })
                            }
                        >
                            בדיקת תעודת {kind} ב־staging
                        </button>
                    ))}
                </div>
            )}
            {notice && <p role="status">{notice}</p>}
            {error && (
                <p role="alert" className="danger-text">
                    {error}
                </p>
            )}
            <ErrorDetails details={details} />
        </section>
    );
}
