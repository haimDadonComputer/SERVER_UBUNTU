import React, { useEffect, useState } from 'react';
import { ErrorDetails } from './diagnostics';
import { stageLabel } from './jobs';
type Data = Record<string, any>;
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export function NetworkSettings({
    api,
    totpEnabled,
    project,
    onQueued,
    lastJob,
    canPublish = false,
    unavailableReason = '',
}: {
    api: Api;
    totpEnabled: boolean;
    project?: Data;
    onQueued?: () => void;
    lastJob?: Data;
    canPublish?: boolean;
    unavailableReason?: string;
}) {
    const [state, setState] = useState<Data | null>(null),
        [fields, setFields] = useState<Data>({ ip: '', domain: '', email: '' });
    const [requestBusy, setBusy] = useState(false),
        [error, setError] = useState(''),
        [details, setDetails] = useState<Data | null>(null),
        [notice, setNotice] = useState('');
    const [port, setPort] = useState(project?.runtime?.port || 3000),
        [https, setHttps] = useState(true),
        [confirmed, setConfirmed] = useState(false);
    const [networkJob, setNetworkJob] = useState<Data | null>(null);
    const [domain, setDomain] = useState('');
    const [statusError, setStatusError] = useState('');
    const busy = requestBusy || !!networkJob;
    useEffect(() => {
        if (lastJob?.status === 'failed') {
            setError(lastJob.error || 'פעולת הפרסום האחרונה נכשלה.');
            setDetails(lastJob.details || null);
        }
    }, [lastJob?.id]);
    useEffect(() => {
        if (!networkJob) return;
        let stopped = false;
        const timer = setInterval(
            () =>
                void api('/jobs/' + networkJob.id + '/events')
                    .then((data) => {
                        if (stopped) return;
                        setStatusError('');
                        if (['queued', 'running'].includes(data.job.status)) {
                            setNetworkJob(data.job);
                            return;
                        }
                        setNetworkJob(null);
                        if (data.job.status === 'done')
                            setNotice(
                                'פעולת הפרסום הושלמה. מצב הכתובת והבדיקה המקומית מוצג למטה; נגישות מבחוץ טרם אומתה.'
                            );
                        else {
                            setNotice('');
                            setError(data.job.error || 'פעולת הפרסום נכשלה.');
                            setDetails(data.job.details || null);
                        }
                        void refresh().catch(() => {});
                    })
                    .catch(() => {
                        if (!stopped)
                            setStatusError(
                                'לא ניתן לקבל כרגע את התקדמות הפעולה. המעקב ינסה להתחבר מחדש.'
                            );
                    }),
            1500
        );
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [networkJob?.id]);
    async function refresh() {
        try {
            const data = await api('/network');
            setState(data);
            setStatusError('');
            return data;
        } catch (error) {
            setState(null);
            setStatusError((error as Error).message);
            throw error;
        }
    }
    useEffect(() => {
        void refresh()
            .then((data) => {
                setFields({ ip: data.ip, domain: data.domain, email: data.email });
                const p = project && data.projects[project.id];
                if (p) {
                    setPort(p.port);
                    setHttps(p.https);
                    setDomain(
                        (p.domain || '').endsWith(
                            '.' + (data.projectDomainSuffix || 'haimdadon.co.il')
                        )
                            ? p.domain.slice(
                                  0,
                                  -(data.projectDomainSuffix || 'haimdadon.co.il').length - 1
                              )
                            : p.domain || ''
                    );
                }
            })
            .catch((e) => setError(e.message));
    }, [project?.id]);
    async function submit(path: string, method: string, body: Data) {
        if (busy) return;
        setBusy(true);
        setError('');
        setDetails(null);
        setNotice('');
        try {
            const result = await api(path, method, {
                ...body,
            });
            setConfirmed(false);
            setNotice(result.job ? 'הפעולה מתבצעת; המצב יתעדכן כאן אוטומטית.' : 'ההגדרות נשמרו');
            if (result.job) {
                setNetworkJob({ id: result.job, status: 'queued', stage: 'ממתין בתור' });
                onQueued?.();
            }
            await refresh();
        } catch (e) {
            setError((e as Error).message);
            setDetails((e as Data).details);
        } finally {
            setBusy(false);
        }
    }
    const publication = project && state?.projects?.[project.id];
    const domainSuffix = state?.projectDomainSuffix || 'haimdadon.co.il';
    const fullDomain = domain ? (domain.includes('.') ? domain : domain + '.' + domainSuffix) : '';
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
                        מצב פרסום: {!state ? 'לא זמין' : publication ? 'מוגדר' : 'לא מפורסם'} ·
                        האזנת Nginx:{' '}
                        {publication?.listening === true
                            ? 'זוהתה בשרת'
                            : publication?.listening === false
                              ? 'לא זוהתה'
                              : 'לא ידוע'}
                    </p>
                    {publication?.localCheck?.status === 'passed' && (
                        <p>
                            בדיקת HTTP דרך הפרסום עברה מהשרת ({publication.localCheck.httpStatus}) ·{' '}
                            {new Date(publication.localCheck.checkedAt).toLocaleString('he-IL')}
                        </p>
                    )}
                    {publication && (
                        <a href={publication.url} target="_blank" rel="noreferrer">
                            {publication.url}
                        </a>
                    )}
                    <label>
                        דומיין לפרויקט (אופציונלי)
                        <input
                            value={domain}
                            onChange={(e) => setDomain(e.target.value.trim().toLowerCase())}
                            placeholder="X"
                            autoComplete="off"
                            dir="ltr"
                        />
                        <small dir="ltr">
                            {domain.includes('.') ? 'כתובת מלאה' : '.' + domainSuffix}
                        </small>
                    </label>
                    {domain && (
                        <p>
                            נדרשת רשומת A אל {state?.ip}. הפרויקט יפורסם ב־https://{fullDomain}/
                            בפורט 443, בנפרד מדומיין הניהול.
                        </p>
                    )}
                    <label>
                        פורט ציבורי
                        <input
                            type="number"
                            min="1024"
                            max="65535"
                            value={domain ? 443 : port}
                            disabled={!!domain}
                            onChange={(e) => setPort(Number(e.target.value))}
                        />
                    </label>
                    <label className="checkbox-label">
                        <input
                            type="checkbox"
                            checked={!!domain || https}
                            disabled={!!domain}
                            onChange={(e) => setHttps(e.target.checked)}
                        />
                        HTTPS עם תעודה ציבורית
                    </label>
                    <p>
                        ה־proxy יאזין ב־IP הציבורי בפורט {domain ? 443 : port} ויפנה ל־localhost:
                        {project.runtime?.port || '—'}. הפרויקט צריך להיות מוגדר להאזנה מקומית.
                    </p>
                </>
            )}
            <p>
                הכנת פרסום:{' '}
                {state?.prepared ? 'מוכנה' : 'נדרש שדרוג המערכת להכנה אוטומטית של HTTPS'}
            </p>
            <p>נגישות מרשת חיצונית: טרם אומתה. יש לבדוק גם את חומת האש של Contabo.</p>
            {statusError && <p role="alert">מידע מצב הפרסום לא זמין: {statusError}</p>}
            {state?.probeDiagnostics?.map((diagnostic: Data, index: number) => (
                <ErrorDetails key={index} details={diagnostic} />
            ))}
            {!project && (
                <>
                    <p>
                        ניהול ציבורי:{' '}
                        {state?.management ? (
                            <a
                                href={'https://' + state.domain}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {'https://' + state.domain}
                            </a>
                        ) : (
                            'כבוי'
                        )}{' '}
                        · גישת Tailscale נשמרת
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
                        disabled={busy || !confirmed || !canPublish}
                        title={unavailableReason}
                        onClick={() =>
                            void submit(`/projects/${project.id}/publication`, 'POST', {
                                enabled: true,
                                confirmed: true,
                                port: domain ? 443 : port,
                                https: !!domain || https,
                                domain: fullDomain,
                            })
                        }
                    >
                        פתיחה לאינטרנט
                    </button>
                    <button
                        disabled={busy || !confirmed || !publication}
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
                        disabled={busy}
                        onClick={() => void submit('/network', 'PATCH', fields)}
                    >
                        שמירת כתובות
                    </button>
                    <button
                        disabled={busy || !confirmed || !state?.domain}
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
                        disabled={busy || !confirmed || !state?.management}
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
                            disabled={busy || !confirmed}
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
            {networkJob && (
                <p role="status">
                    {networkJob.status === 'queued' ? 'ממתין בתור' : stageLabel(networkJob.stage)}
                </p>
            )}
            {error && (
                <p role="alert" className="danger-text">
                    {error}
                </p>
            )}
            <ErrorDetails details={details} />
        </section>
    );
}
