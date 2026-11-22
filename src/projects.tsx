import React, { useEffect, useRef, useState } from 'react';
import {
    Play,
    Square,
    RotateCw,
    Settings,
    Terminal,
    Archive,
    RefreshCw,
    Trash2,
    X,
    Loader2,
    Save,
    ExternalLink,
    Folder,
} from 'lucide-react';
import { ErrorDetails } from './diagnostics';
import { NetworkSettings } from './network';
import { stageLabel } from './jobs';
import { projectAccess } from './project-access';
type Data = Record<string, any>;
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
function Popup({
    title,
    onClose,
    children,
}: {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
}) {
    return (
        <div className="modal-backdrop">
            <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
                <div className="panel-heading">
                    <h2>{title}</h2>
                    <button aria-label="סגירה" onClick={onClose}>
                        <X size={18} />
                    </button>
                </div>
                {children}
            </section>
        </div>
    );
}
export function ProjectActions({
    project: p,
    api,
    refresh,
    onQueued,
    console: openConsole,
    totpEnabled,
    serverAddresses = [],
    publication,
    jobs = [],
    managementHosts = null,
    publicationStatusKnown = false,
    onFiles,
    onEnvironment,
    children,
    serviceState = 'unknown',
}: {
    project: Data;
    api: Api;
    refresh: () => Promise<any>;
    onQueued: () => void;
    console: (id: string) => void;
    totpEnabled: boolean;
    serverAddresses?: Data[];
    publication?: Data;
    jobs?: Data[];
    managementHosts?: string[] | null;
    publicationStatusKnown?: boolean;
    onFiles?: () => void;
    onEnvironment?: () => void;
    children?: React.ReactNode;
    serviceState?: string;
}) {
    const [modal, setModal] = useState(''),
        [requestBusy, setBusy] = useState(false),
        [error, setError] = useState(''),
        [details, setDetails] = useState<Data | null>(null),
        [typed, setTyped] = useState('');
    const [launchUrl, setLaunchUrl] = useState(p.launch_url || '');
    const [pendingJob, setPendingJob] = useState<Data | null>(null);
    const running = jobs.find(
        (job) => job.resource === 'project:' + p.id && ['queued', 'running'].includes(job.status)
    );
    const observed = pendingJob && jobs.find((job) => job.id === pendingJob.id);
    const activeJob = running || (pendingJob && !observed ? pendingJob : null);
    const publicationJob = jobs.find(
        (job) => job.resource === 'project:' + p.id && job.action === 'network-project'
    );
    const busy = requestBusy || !!activeJob || !!p.recoveryPending;
    const trackedAction = useRef<string | null>(null);
    useEffect(() => {
        if (activeJob) {
            trackedAction.current = activeJob.id;
            return;
        }
        if (
            trackedAction.current &&
            jobs.some(
                (job) =>
                    job.id === trackedAction.current && !['queued', 'running'].includes(job.status)
            )
        ) {
            trackedAction.current = null;
            void refresh();
        }
    }, [activeJob?.id, jobs]);
    const processRunning = ['active', 'running'].includes(serviceState);
    const canStop = !!p.service && ['active', 'running', 'activating'].includes(serviceState);
    const canRestart = !!p.runtime && processRunning;
    const publicationReason =
        !p.runtime || p.ownership !== 'managed'
            ? 'נדרשת סביבת הפעלה מנוהלת'
            : p.runtime.health !== 'http' || !p.runtime.port
              ? 'נדרש פרויקט Web עם פורט מוגדר'
              : (p.runtime.listenAddress || '127.0.0.1') !== '127.0.0.1'
                ? 'יש לבחור האזנה מקומית בהגדרות ההפעלה לפני פרסום'
                : !processRunning
                  ? 'יש להפעיל את הפרויקט ולאמת את מצבו לפני פרסום'
                  : '';
    const serverIp =
        serverAddresses.find((entry) => entry.interface === 'configured-public')?.address ||
        serverAddresses[0]?.address;
    useEffect(() => {
        if (observed && !['queued', 'running'].includes(observed.status)) setPendingJob(null);
    }, [observed?.status]);
    useEffect(() => {
        if (!pendingJob) return;
        let stopped = false;
        const poll = () =>
            api('/jobs/' + pendingJob.id + '/events')
                .then((result) => {
                    if (stopped) return;
                    if (['queued', 'running'].includes(result.job.status))
                        setPendingJob((previous) =>
                            previous ? { ...previous, ...result.job } : null
                        );
                    else {
                        trackedAction.current = null;
                        setPendingJob(null);
                        void refresh();
                    }
                })
                .catch(() => {});
        const timer = setInterval(poll, 2000);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [pendingJob?.id]);
    const progress = (operation: string, label: string) =>
        activeJob?.action === 'project-' + operation ? (
            <>
                <Loader2 className="spin" size={14} />
                {activeJob.status === 'queued' ? 'ממתין בתור' : stageLabel(activeJob.stage)}
            </>
        ) : (
            label
        );
    const access =
        managementHosts === null
            ? { url: '', reason: 'מידע הגישה עדיין לא זמין' }
            : projectAccess(p, serverAddresses, publication, managementHosts, location.hostname);
    const projectUrl = access.url;
    async function action(path: string, method = 'POST', body: Data = { confirmed: true }) {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            const result = await api(`/projects/${p.id}/` + path, method, body);
            if (result.job)
                setPendingJob({
                    id: result.job,
                    resource: 'project:' + p.id,
                    action: 'project-' + path,
                    status: 'queued',
                    stage: 'ממתין בתור',
                });
            setModal('');
            await refresh();
            if (result.job) onQueued();
        } catch (e) {
            setError((e as Error).message);
            setDetails((e as Data).details);
        } finally {
            setBusy(false);
        }
    }
    const archived = p.lifecycle === 'archived';
    let updates: Data = {};
    let sourceSync: Data = {};
    try {
        updates = JSON.parse(p.update_state || '{}');
    } catch {}
    try {
        sourceSync = JSON.parse(p.source_sync_json || '{}') || {};
    } catch {}
    return (
        <>
            <div className="project-access-summary">
                <div className="project-server-ip" dir="ltr">
                    IP: {serverIp || 'לא זמין'}
                    {publication?.port || p.runtime?.port
                        ? ` · Port: ${publication?.port || p.runtime.port}`
                        : ''}
                </div>
                <span
                    className={
                        'publication-badge ' +
                        (!publicationStatusKnown
                            ? 'unknown'
                            : publication
                              ? 'published'
                              : 'private')
                    }
                    title="מצב תצורת הפרסום; נגישות חיצונית אינה נבדקת"
                >
                    {!publicationStatusKnown
                        ? 'מצב הפרסום לא זמין'
                        : publication
                          ? 'מפורסם באינטרנט'
                          : 'לא מפורסם'}
                </span>
                {!archived &&
                    (projectUrl ? (
                        <a
                            className="project-entry"
                            href={projectUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={projectUrl}
                        >
                            <ExternalLink size={14} />
                            כניסה לפרויקט
                            <span className="mono" dir="ltr">
                                {projectUrl}
                            </span>
                        </a>
                    ) : (
                        <div className="project-entry unavailable">
                            <span>אין כרגע כתובת גישה</span>
                            <small>{access.reason}</small>
                        </div>
                    ))}
            </div>
            {publicationJob?.status === 'failed' && (
                <div className="publication-failure" role="alert">
                    <p>פעולת הפרסום האחרונה נכשלה; מצב התהליך מוצג בנפרד.</p>
                    <p>{publicationJob.error}</p>
                    <ErrorDetails details={publicationJob.details} jobId={publicationJob.id} />
                </div>
            )}
            {!archived && sourceSync.checkedAt && (
                <div className="project-update-status source-sync-result" role="status">
                    <strong>תוצאת הסנכרון המוצלח האחרון</strong>
                    <span>
                        {sourceSync.changed === true
                            ? 'קוד חדש נמשך לתיקיית המקור.'
                            : sourceSync.changed === false
                              ? 'תיקיית המקור כבר מעודכנת; לא היו שינויים למשוך.'
                              : 'משיכת הקוד הסתיימה; לא התקבל מידע השוואה מלא.'}
                    </span>
                    <small>
                        {new Date(sourceSync.checkedAt).toLocaleString('he-IL')}
                        {sourceSync.commit && (
                            <>
                                {' '}
                                · קומיט: <b dir="ltr">{sourceSync.commit.slice(0, 12)}</b>
                            </>
                        )}
                    </small>
                    <small>
                        {sourceSync.mode === 'live'
                            ? sourceSync.running
                                ? 'האתר עודכן לגרסה הזו ועבר בדיקת תקינות.'
                                : 'הגרסה החדשה מוכנה; הפרויקט נשאר כבוי.'
                            : 'המשיכה אינה מפעילה קוד חדש באתר. להפעלת השינויים יש לבצע עדכון ופריסה.'}
                    </small>
                </div>
            )}
            <div className="project-actions">
                {archived ? (
                    <div className="project-controls lifecycle-actions">
                        <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => setModal('restore')}
                        >
                            <RotateCw size={14} />
                            שחזור מהארכיון
                        </button>
                        <button
                            className="text-btn danger-text"
                            disabled={busy}
                            onClick={() => setModal('purge')}
                        >
                            <Trash2 size={14} />
                            מחיקה לצמיתות
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="project-primary-actions">
                            <button
                                className="secondary"
                                disabled={busy || (!publication && !!publicationReason)}
                                title={!publication ? publicationReason : 'ניהול הפרסום הקיים'}
                                onClick={() => setModal('publication')}
                            >
                                <ExternalLink size={14} />
                                פרסום באינטרנט
                            </button>
                            <button
                                className="secondary"
                                disabled={busy}
                                onClick={() => setModal('runtime')}
                            >
                                <Settings size={14} />
                                הגדרות הפעלה
                            </button>
                            <button
                                className="secondary"
                                disabled={busy || !canStop}
                                title={
                                    !canStop
                                        ? 'עצירה זמינה רק לתהליך שפועל או נמצא בהפעלה'
                                        : undefined
                                }
                                onClick={() => setModal('stop')}
                            >
                                <Square size={14} />
                                {progress('stop', 'עצירה')}
                            </button>
                            <button
                                className="secondary"
                                disabled={busy || !canRestart}
                                title={
                                    !canRestart
                                        ? 'הפעלה מחדש זמינה רק לפרויקט פועל; לפרויקט כבוי השתמשו בהפעלת פרויקט'
                                        : undefined
                                }
                                onClick={() => setModal('restart')}
                            >
                                <RotateCw size={14} />
                                {progress('restart', 'הפעלה מחדש')}
                            </button>
                            <button
                                className="secondary"
                                disabled={busy || !p.runtime}
                                onClick={() => setModal('activate')}
                            >
                                <RefreshCw size={14} />
                                {progress('activate', 'עדכון ופריסה')}
                            </button>
                            <button
                                className="secondary danger-text"
                                disabled={busy}
                                onClick={() => setModal('archive')}
                            >
                                <Archive size={14} />
                                העבר לארכיון
                            </button>
                            {onFiles && (
                                <button className="secondary" onClick={onFiles}>
                                    <Folder size={14} />
                                    קבצים
                                </button>
                            )}
                            {onEnvironment && (
                                <button className="secondary" onClick={onEnvironment}>
                                    <Settings size={14} />
                                    משתני סביבה
                                </button>
                            )}
                            <button
                                className="secondary"
                                disabled={busy || !p.repo || !p.runtime}
                                title={
                                    !p.repo
                                        ? 'לא הוגדר מאגר GitHub לפרויקט'
                                        : !p.runtime
                                          ? 'נדרשות הגדרות הפעלה לעדכון האתר'
                                          : 'משיכת main, שמירת גיבוי ועדכון האתר'
                                }
                                onClick={() => setModal('sync')}
                            >
                                <RefreshCw size={14} />
                                {progress('sync', 'סנכרן עם הגיטהב')}
                            </button>
                            <button
                                className="secondary"
                                disabled={busy}
                                onClick={() => setModal('command')}
                            >
                                <Terminal size={14} />
                                {progress('command', 'הרץ פקודה')}
                            </button>
                        </div>
                        <details className="project-manage">
                            <summary>עוד</summary>
                            <div className="project-controls lifecycle-actions">
                                <button
                                    className="primary"
                                    disabled={
                                        busy || processRunning || serviceState === 'activating'
                                    }
                                    onClick={() => setModal(p.runtime ? 'start' : 'runtime')}
                                >
                                    <Play size={15} />
                                    {progress('start', 'הפעלת פרויקט')}
                                </button>
                                <button className="secondary" onClick={() => openConsole(p.id)}>
                                    <Terminal size={15} />
                                    קונסול הפרויקט
                                </button>
                                <button
                                    className="secondary"
                                    onClick={() => {
                                        setLaunchUrl(p.launch_url || projectUrl);
                                        setModal('link');
                                    }}
                                >
                                    כתובת פתיחה
                                </button>
                            </div>
                            <div className="project-update-status">
                                <label>
                                    עדכוני GitHub
                                    <select
                                        aria-label={'עדכונים עבור ' + p.name}
                                        value={p.updates || 'manual'}
                                        disabled={busy || !p.repo || !p.runtime}
                                        onChange={(e) =>
                                            void action('updates', 'PATCH', {
                                                mode: e.target.value,
                                            })
                                        }
                                    >
                                        <option value="manual">ידני — עדכון בלחיצה</option>
                                        <option value="auto">אוטומטי — בדיקה כל דקה</option>
                                    </select>
                                </label>
                                <small>
                                    שירות:{' '}
                                    {p.desired === 'running'
                                        ? 'נדרש לפעול'
                                        : p.runtime
                                          ? 'כבוי'
                                          : 'טרם הוגדר'}{' '}
                                    · פריסה:{' '}
                                    {(
                                        {
                                            healthy: 'תקינה',
                                            prepared: 'גרסה מוכנה',
                                            'prepared-stopped': 'מוכנה להפעלה',
                                            failed: 'נכשלה',
                                            'failed-rolled-back': 'נכשלה; הגרסה הקודמת שוחזרה',
                                            restored: 'שוחזרה',
                                        } as Data
                                    )[p.deployment] || 'טרם בוצעה'}
                                </small>
                                <details className="release-details">
                                    <summary>פרטי גרסה ועדכונים</summary>
                                    <div className="commit-grid">
                                        {[
                                            ['קומיט מרוחק', updates.remoteCommit || p.remoteCommit],
                                            ['גרסה מוכנה', p.preparedCommit],
                                            ['גרסה פעילה', p.activeCommit],
                                            ['קומיט שנכשל', p.failedCommit || updates.failedCommit],
                                        ].map(([label, value]) => (
                                            <span key={label}>
                                                {label}:{' '}
                                                <b className="mono">
                                                    {value ? String(value).slice(0, 14) : '—'}
                                                </b>
                                            </span>
                                        ))}
                                    </div>
                                    <small>
                                        בדיקה אחרונה:{' '}
                                        {updates.checkedAt || p.checkedAt
                                            ? new Date(
                                                  updates.checkedAt || p.checkedAt
                                              ).toLocaleString('he-IL')
                                            : 'טרם נבדק'}
                                    </small>
                                    {updates.remoteCommit &&
                                        updates.remoteCommit !== p.preparedCommit && (
                                            <small>
                                                ממתין לעדכון: {updates.remoteCommit.slice(0, 14)}
                                            </small>
                                        )}
                                </details>
                                {updates.error && <p className="danger-text">{updates.error}</p>}
                            </div>
                            {children}
                        </details>
                    </>
                )}
            </div>
            {error && (
                <div className="alert error">
                    <div className="grow">
                        {error}
                        <ErrorDetails details={details} />
                    </div>
                </div>
            )}
            {p.recoveryPending && (
                <p className="alert warning">
                    פעולה בפרויקט עדיין לא הסתיימה. אם המשימה נקטעה או שהמערכת הופעלה מחדש, בדקו את
                    יומן ubuntu-control-helper לפני ניסיון נוסף. הקונסול זמין לצפייה.
                </p>
            )}
            {modal === 'publication' && (
                <Popup title="פרסום הפרויקט" onClose={() => setModal('')}>
                    <NetworkSettings
                        api={api}
                        totpEnabled={totpEnabled}
                        project={p}
                        lastJob={publicationJob}
                        canPublish={!publicationReason}
                        unavailableReason={publicationReason}
                        onQueued={onQueued}
                    />
                </Popup>
            )}
            {modal === 'runtime' && (
                <RuntimeEditor
                    p={p}
                    api={api}
                    close={() => setModal('')}
                    saved={async () => {
                        setModal('');
                        await refresh();
                        onQueued();
                    }}
                />
            )}
            {modal === 'command' && (
                <ProjectCommand
                    p={p}
                    api={api}
                    busy={busy}
                    processRunning={processRunning}
                    close={() => setModal('')}
                    configure={() => setModal('runtime')}
                    run={(script) => action('command', 'POST', { confirmed: true, script })}
                    error={error}
                    details={details}
                />
            )}
            {modal === 'link' && (
                <Popup title="כתובת פתיחת הפרויקט" onClose={() => setModal('')}>
                    <p className="muted">
                        בחרו IP של השרת ופורט, או הזינו כתובת מותאמת. כדי לגשת דרך IP יש לבחור
                        בהגדרות ההפעלה האזנה דרך כתובת השרת. חומת האש אינה משתנה אוטומטית.
                    </p>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void action('link', 'PATCH', { url: launchUrl });
                        }}
                    >
                        {serverAddresses.length > 0 && (
                            <label>
                                IP של השרת
                                <select
                                    defaultValue=""
                                    onChange={(e) => {
                                        if (e.target.value)
                                            setLaunchUrl(
                                                `http://${e.target.value}:${p.runtime?.port || p.health_port || 3000}/`
                                            );
                                    }}
                                >
                                    <option value="">בחירת IP</option>
                                    {serverAddresses.map((a) => (
                                        <option key={a.address} value={a.address}>
                                            {a.address} ({a.interface})
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}
                        <label>
                            כתובת האפליקציה
                            <input
                                type="url"
                                dir="ltr"
                                placeholder="http://SERVER_IP:3000"
                                value={launchUrl}
                                onChange={(e) => setLaunchUrl(e.target.value)}
                            />
                        </label>
                        {p.runtime && p.runtime.listenAddress !== '0.0.0.0' && (
                            <p className="alert warning">
                                הפרויקט מוגדר כרגע ל־localhost בלבד. שמירת קישור אינה פותחת גישה
                                מרחוק; יש לשנות את ההאזנה בהגדרות ההפעלה ולהפעיל את הפרויקט.
                            </p>
                        )}
                        {error && <div className="alert error">{error}</div>}
                        <button className="primary" disabled={busy}>
                            שמירת כתובת
                        </button>
                    </form>
                </Popup>
            )}
            {modal && !['runtime', 'link', 'publication', 'command'].includes(modal) && (
                <Popup
                    title={
                        {
                            start: 'הפעלת פרויקט',
                            stop: 'עצירת פרויקט',
                            restart: 'הפעלה מחדש',
                            activate: 'עדכון ופריסה',
                            pull: 'סנכרן עם הגיטהב',
                            sync: 'סנכרן ועדכן את האתר',
                            archive: 'ארכוב פרויקט',
                            restore: 'שחזור פרויקט',
                            purge: 'מחיקה לצמיתות',
                        }[modal] || modal
                    }
                    onClose={() => setModal('')}
                >
                    <p className="muted">
                        {modal === 'sync'
                            ? 'main יימשך לתיקיית הפרויקט, ותישמר נקודת חזרה לקוד הקודם. האתר הפעיל יעודכן וייבדק; בכשל בפריסה המערכת תנסה להחזיר את הגרסה הקודמת. פרויקט כבוי יישאר כבוי. הכנת הגרסה כוללת התקנת תלויות ובנייה לפי ההגדרות.'
                            : modal === 'pull'
                              ? 'השינויים יימשכו מהענף שהוגדר ב־GitHub אל תיקיית המקור בשרת, ללא התקנת תלויות, בנייה או הפעלה מחדש. הגרסה הפעילה לא תשתנה. שינויים מקומיים או היסטוריה שהתפצלה יחסמו את המשיכה; לא תתבצע העלאה ל־GitHub.'
                              : modal === 'archive'
                                ? 'השירות ייעצר והעדכונים יושהו. הקוד, ההגדרות והנתונים יישמרו לשחזור.'
                                : modal === 'purge'
                                  ? 'כל משאבי הפרויקט שבארכיון יימחקו. היסטוריית הפעולות תישמר. אין אפשרות לבטל.'
                                  : modal === 'restore'
                                    ? 'הפרויקט יחזור עם הנתונים ומשתני הסביבה, במצב כבוי ובעדכון ידני.'
                                    : modal === 'activate'
                                      ? 'תיבנה גרסה חדשה. שירות שכבר פועל יופעל מחדש וייבדק; פרויקט כבוי יישאר כבוי.'
                                      : 'הפעולה תריץ או תעצור את קוד הפרויקט כמשתמש מוגבל. הפעלה ראשונה כוללת התקנת תלויות ובנייה.'}
                    </p>
                    {['archive', 'purge'].includes(modal) && (
                        <div className="project-update-status">
                            <strong>
                                {p.name} · {p.id}
                            </strong>
                            <span className="mono">{p.root}</span>
                            <span>שירות מושפע: {p.service || 'ללא שירות'}</span>
                            <span>
                                משתני סביבה, גרסאות קוד ונתונים קבועים{' '}
                                {modal === 'archive'
                                    ? 'יישמרו בארכיון ללא תפוגה.'
                                    : 'יימחקו לצמיתות.'}
                            </span>
                            {p.runtime?.kind === 'docker' && (
                                <span>כולל volume פרטי של Docker.</span>
                            )}
                            {p.service && !p.runtime && (
                                <span>
                                    אני מאשר לעצור את השירות החיצוני המשויך ולבטל הפעלה באתחול;
                                    השירות עצמו לא יימחק.
                                </span>
                            )}
                        </div>
                    )}
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (modal === 'purge')
                                void action('', 'DELETE', {
                                    confirmed: true,
                                    confirmName: typed,
                                });
                            else
                                void action(modal, 'POST', {
                                    confirmed: true,
                                    ...(modal === 'archive' ? { confirmName: typed } : {}),
                                });
                        }}
                    >
                        {['archive', 'purge'].includes(modal) && (
                            <label>
                                להמשך הקלידו {p.id}
                                <input
                                    required
                                    value={typed}
                                    onChange={(e) => setTyped(e.target.value)}
                                />
                            </label>
                        )}
                        {error && (
                            <div className="alert error">
                                <div>
                                    {error}
                                    <ErrorDetails details={details} />
                                </div>
                            </div>
                        )}
                        <div className="modal-buttons">
                            <button
                                className="primary"
                                disabled={
                                    busy || (['archive', 'purge'].includes(modal) && typed !== p.id)
                                }
                            >
                                {busy ? <Loader2 className="spin" size={15} /> : null}אישור הפעולה
                            </button>
                            <button
                                type="button"
                                className="secondary"
                                onClick={() => setModal('')}
                            >
                                ביטול
                            </button>
                        </div>
                    </form>
                </Popup>
            )}
        </>
    );
}

function ProjectCommand({
    p,
    api,
    busy,
    processRunning,
    close,
    configure,
    run,
    error,
    details,
}: {
    p: Data;
    api: Api;
    busy: boolean;
    processRunning: boolean;
    close: () => void;
    configure: () => void;
    run: (script: string) => Promise<void>;
    error: string;
    details: Data | null;
}) {
    const [scripts, setScripts] = useState<string[] | null>(null);
    const [script, setScript] = useState(p.runtime?.script || '');
    const [loadError, setLoadError] = useState('');
    const supported = p.ownership === 'managed' && p.runtime?.kind === 'node';
    useEffect(() => {
        if (!supported) return;
        let cancelled = false;
        api(`/projects/${p.id}/options`)
            .then((options) => {
                if (cancelled) return;
                setScripts(options.scripts);
                setScript((previous: string) =>
                    options.scripts.includes(previous)
                        ? previous
                        : options.scripts.includes('start')
                          ? 'start'
                          : options.scripts[0] || ''
                );
            })
            .catch((e) => {
                if (!cancelled) setLoadError(e.message);
            });
        return () => {
            cancelled = true;
        };
    }, [p.id, supported]);
    const changed = p.runtime?.mode !== 'npm' || p.runtime?.script !== script;
    return (
        <Popup title="הרץ פקודה" onClose={close}>
            {!supported ? (
                <>
                    <p>לבחירת פקודת npm יש להגדיר סביבת הפעלה מנוהלת מסוג Node.js.</p>
                    <button className="primary" onClick={configure}>
                        הגדרות הפעלה
                    </button>
                </>
            ) : (
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (script) void run(script);
                    }}
                >
                    <p className="muted">
                        בחרו פקודת הפעלה מתוך package.json. היא תישמר כפקודת ההפעלה של הפרויקט ותרוץ
                        כשירות מנוהל.
                    </p>
                    <label>
                        פקודה
                        <select
                            dir="ltr"
                            value={script}
                            disabled={busy || !scripts?.length}
                            onChange={(e) => setScript(e.target.value)}
                        >
                            {!scripts?.length && (
                                <option value="">
                                    {scripts ? 'לא נמצאו פקודות npm' : 'טוען פקודות…'}
                                </option>
                            )}
                            {scripts?.map((name) => (
                                <option key={name} value={name}>
                                    {name === 'start' ? 'npm start' : `npm run ${name}`}
                                </option>
                            ))}
                        </select>
                    </label>
                    {!!p.runtime.args?.length && (
                        <p dir="ltr">args: {JSON.stringify(p.runtime.args)}</p>
                    )}
                    <p className="muted">
                        {changed || !p.preparedCommit || p.runtimePending
                            ? 'הבחירה דורשת הכנת גרסה, כולל התקנת תלויות ובנייה לפי ההגדרות, ולאחר מכן הפעלה ובדיקת תקינות.'
                            : 'תופעל הגרסה המוכנה, ללא משיכת קוד או התקנה מחדש. כדי להפעיל קוד חדש השתמשו בעדכון ופריסה.'}
                    </p>
                    {processRunning && (
                        <p className="alert warning">
                            {changed
                                ? 'יש לעצור את הפרויקט לפני שינוי פקודת ההפעלה.'
                                : 'הפרויקט פועל; הרצת הפקודה תפעיל אותו מחדש.'}
                        </p>
                    )}
                    {(error || loadError) && (
                        <div className="alert error" role="alert">
                            {error || loadError}
                            <ErrorDetails details={details} />
                        </div>
                    )}
                    <button
                        className="primary"
                        disabled={busy || !scripts?.includes(script) || (changed && processRunning)}
                    >
                        {busy && <Loader2 className="spin" size={14} />}הרצה
                    </button>
                </form>
            )}
        </Popup>
    );
}

function RuntimeEditor({
    p,
    api,
    close,
    saved,
}: {
    p: Data;
    api: Api;
    close: () => void;
    saved: () => void;
}) {
    const [options, setOptions] = useState<Data | null>(null),
        [runtime, setRuntime] = useState<Data>(
            p.runtime || {
                kind: p.kind || 'node',
                mode: 'npm',
                script: 'start',
                entry: '',
                args: [],
                health: 'http',
                port: p.health_port || 3000,
                healthPath: '/',
                autostart: false,
                testScript: '',
                buildScript: '',
                dependencyInstall: 'install',
                listenAddress: '127.0.0.1',
                internalPort: 3000,
                dataPath: '/app/shared',
            }
        ),
        [args, setArgs] = useState(JSON.stringify(p.runtime?.args || [])),
        [replace, setReplace] = useState(false),
        [busy, setBusy] = useState(false),
        [error, setError] = useState(''),
        [details, setDetails] = useState<Data | null>(null);
    useEffect(() => {
        api(`/projects/${p.id}/options`)
            .then((data) => {
                setOptions(data);
                if (!p.runtime)
                    setRuntime((r) => ({
                        ...r,
                        script: data.scripts.includes('start') ? 'start' : data.scripts[0] || '',
                        entry: data.entries[0] || '',
                        testScript: '',
                        buildScript: data.scripts.includes('build') ? 'build' : '',
                    }));
            })
            .catch((e) => {
                setError(e.message);
                setDetails(e.details);
            });
    }, [p.id]);
    const set = (key: string, value: any) => setRuntime({ ...runtime, [key]: value });
    const [portState, setPortState] = useState<Data | null>(null);
    useEffect(() => {
        let stopped = false;
        const port = Number(runtime.port);
        setPortState(null);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
        const timer = setTimeout(() => {
            api(
                `/projects/${p.id}/port-check?port=${port}&listenAddress=${runtime.listenAddress || '127.0.0.1'}`
            )
                .then((result) => {
                    if (!stopped) setPortState(result);
                })
                .catch(() => {
                    if (!stopped) setPortState({ status: 'unknown' });
                });
        }, 350);
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [p.id, runtime.port, runtime.listenAddress]);
    return (
        <Popup title="הגדרות הפעלת הפרויקט" onClose={close}>
            <p className="muted">
                השירות נוצר אוטומטית. הפרויקט רץ ללא root, עם נתונים קבועים וסודות מחוץ לגרסאות
                הקוד. יש לעצור שירות פעיל לפני שינוי ההגדרות.
            </p>
            {options ? (
                <form
                    onSubmit={async (e) => {
                        e.preventDefault();
                        setBusy(true);
                        setError('');
                        try {
                            const parsed = JSON.parse(args);
                            if (!Array.isArray(parsed))
                                throw new Error('הארגומנטים חייבים להיות מערך JSON');
                            await api(`/projects/${p.id}/runtime`, 'PATCH', {
                                runtime: {
                                    ...runtime,
                                    args: parsed,
                                    port: runtime.port ? Number(runtime.port) : null,
                                },
                                replaceExternal: replace,
                            });
                            saved();
                        } catch (e) {
                            setError((e as Error).message);
                            setDetails((e as Data).details);
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    <label>
                        סוג הפעלה
                        <select value={runtime.kind} onChange={(e) => set('kind', e.target.value)}>
                            <option value="node">Node.js</option>
                            <option value="docker">Docker rootless</option>
                        </select>
                    </label>
                    {runtime.kind === 'node' ? (
                        <>
                            <label>
                                התקנת תלויות
                                <select
                                    value={runtime.dependencyInstall || 'install'}
                                    onChange={(e) => set('dependencyInstall', e.target.value)}
                                >
                                    <option value="install">npm install — ברירת מחדל</option>
                                    <option value="locked">npm ci — דורש קובץ נעילה</option>
                                    <option value="allow-install">
                                        npm install כאשר אין קובץ נעילה
                                    </option>
                                </select>
                            </label>
                            {!(options.lockfiles || []).some((f: string) =>
                                ['package-lock.json', 'npm-shrinkwrap.json'].includes(f)
                            ) && (
                                <p className="alert warning">
                                    לא נמצא קובץ נעילה של npm בתיקיית המקור. אפשר להוסיף
                                    package-lock.json למאגר, או לבחור במפורש npm install. ההתקנה
                                    תיצור קובץ נעילה רק בגרסת ההרצה ולא תדחוף שינויים ל־GitHub.
                                    {(options.lockfiles || []).length > 0
                                        ? ' זוהו קובצי נעילה אחרים: ' +
                                          options.lockfiles.join(', ') +
                                          '. בפרויקט המשתמש במנהל חבילות אחר מומלץ Dockerfile שמתקין באמצעותו.'
                                        : ''}
                                </p>
                            )}
                            <label>
                                דרך הפעלה
                                <select
                                    value={runtime.mode}
                                    onChange={(e) => set('mode', e.target.value)}
                                >
                                    <option value="npm">script מתוך package.json</option>
                                    <option value="entry">קובץ כניסה של Node</option>
                                </select>
                            </label>
                            {runtime.mode === 'npm' ? (
                                <label>
                                    script להפעלה
                                    <select
                                        aria-label="script להפעלה"
                                        value={runtime.script}
                                        onChange={(e) => set('script', e.target.value)}
                                    >
                                        {options.scripts.map((s: string) => (
                                            <option key={s}>{s}</option>
                                        ))}
                                    </select>
                                </label>
                            ) : (
                                <label>
                                    קובץ כניסה
                                    <select
                                        value={runtime.entry}
                                        onChange={(e) => set('entry', e.target.value)}
                                    >
                                        {options.entries.map((s: string) => (
                                            <option key={s}>{s}</option>
                                        ))}
                                    </select>
                                </label>
                            )}
                            <label>
                                ארגומנטים כמערך JSON
                                <textarea
                                    dir="ltr"
                                    value={args}
                                    onChange={(e) => setArgs(e.target.value)}
                                />
                            </label>
                            {[
                                ['testScript', 'script בדיקות'],
                                ['buildScript', 'script בנייה'],
                            ].map(([key, label]) => (
                                <label key={key}>
                                    {label}
                                    <select
                                        value={runtime[key]}
                                        onChange={(e) => set(key, e.target.value)}
                                    >
                                        <option value="">ללא</option>
                                        {options.scripts.map((s: string) => (
                                            <option key={s}>{s}</option>
                                        ))}
                                    </select>
                                </label>
                            ))}
                        </>
                    ) : (
                        <>
                            <p className="muted">
                                נדרש Dockerfile ומנוע rootless של ubuntu-docker. המכולה אינה מקבלת
                                גישה ל־socket או לנתיבי Host חופשיים.
                            </p>
                            <label>
                                פורט פנימי
                                <input
                                    type="number"
                                    min={1}
                                    max={65535}
                                    value={runtime.internalPort}
                                    onChange={(e) => set('internalPort', Number(e.target.value))}
                                />
                            </label>
                            <label>
                                נתיב נתונים במכולה
                                <input
                                    value={runtime.dataPath}
                                    onChange={(e) => set('dataPath', e.target.value)}
                                />
                            </label>
                        </>
                    )}
                    <label>
                        בדיקת תקינות
                        <select
                            value={runtime.health}
                            onChange={(e) => set('health', e.target.value)}
                        >
                            <option value="http">HTTP מקומי</option>
                            <option value="process">תהליך יציב במשך 20 שניות</option>
                        </select>
                    </label>
                    {runtime.kind === 'node' && (
                        <>
                            <label>
                                תיקיות נתונים נוספות (נתיב יחסי בכל שורה)
                                <textarea
                                    aria-label="תיקיות נתונים נוספות"
                                    placeholder={'data\nruntime/cache'}
                                    value={(runtime.storageDirectories || []).join('\n')}
                                    onChange={(e) =>
                                        set(
                                            'storageDirectories',
                                            e.target.value
                                                .split('\n')
                                                .map((path) => path.trim())
                                                .filter(Boolean)
                                        )
                                    }
                                />
                            </label>
                            <p className="muted">
                                תיקיות upload ו־uploads מזוהות אוטומטית בכל עומק. תיקיות נוספות כגון
                                data נוצרות וממופות רק לאחר הגדרה מפורשת, ונשמרות גם בעדכון ובשחזור.
                                הנתיבים חסומים לפרסום ישיר.
                            </p>
                            {(p.writableDirectories || []).length > 0 && (
                                <p className="muted">
                                    מיפויים פעילים: {p.writableDirectories.join(', ')}
                                </p>
                            )}
                        </>
                    )}
                    <label>
                        פורט בשרת
                        <input
                            aria-label="פורט הפעלה"
                            type="number"
                            min={1024}
                            max={65535}
                            required={runtime.health === 'http'}
                            value={runtime.port || ''}
                            onChange={(e) =>
                                set('port', e.target.value ? Number(e.target.value) : null)
                            }
                        />
                    </label>
                    {Number.isInteger(runtime.port) &&
                        runtime.port >= 1024 &&
                        runtime.port <= 65535 && (
                            <small
                                className="port-state"
                                role="status"
                                data-status={portState?.status || 'checking'}
                            >
                                {(
                                    {
                                        available: 'הפורט פנוי בבדיקה הנוכחית',
                                        owned: 'הפורט בשימוש הפרויקט הנוכחי',
                                        occupied: 'הפורט תפוס בידי תהליך אחר',
                                        reserved: 'הפורט שמור לפרויקט אחר',
                                        unknown: 'לא ניתן לבדוק את זמינות הפורט',
                                    } as Data
                                )[portState?.status] || 'בודק זמינות פורט…'}
                                {portState?.project && ` · ${portState.project}`}
                                {portState?.listeners?.map((listener: Data, index: number) => (
                                    <span key={index}>
                                        {' '}
                                        · {listener.process || 'תהליך לא מזוהה'}
                                        {listener.pid ? ` (PID ${listener.pid})` : ''}
                                    </span>
                                ))}
                            </small>
                        )}
                    {runtime.health === 'http' && (
                        <label>
                            נתיב HTTP לבדיקה
                            <input
                                value={runtime.healthPath}
                                onChange={(e) => set('healthPath', e.target.value)}
                            />
                        </label>
                    )}
                    <label className="checkbox-label">
                        <input
                            type="checkbox"
                            checked={runtime.listenAddress === '0.0.0.0'}
                            onChange={(e) =>
                                set('listenAddress', e.target.checked ? '0.0.0.0' : '127.0.0.1')
                            }
                        />
                        גישה דרך IP ופורט של השרת
                    </label>
                    {runtime.listenAddress === '0.0.0.0' && (
                        <p className="alert warning">
                            השירות יאזין בכל ממשקי IPv4, כולל כתובת ציבורית אם קיימת. חומת האש לא
                            תשתנה. בקוד Node יש להשתמש בערך HOST שמועבר לשירות.
                        </p>
                    )}
                    <label className="checkbox-label">
                        <input
                            type="checkbox"
                            checked={runtime.autostart}
                            onChange={(e) => set('autostart', e.target.checked)}
                        />
                        הפעלה אוטומטית באתחול השרת
                    </label>
                    {p.service && p.ownership !== 'managed' && (
                        <label className="checkbox-label">
                            <input
                                type="checkbox"
                                required
                                checked={replace}
                                onChange={(e) => setReplace(e.target.checked)}
                            />
                            אני מאשר המרה לשירות מנוהל. השירות הקיים ייעצר בעת ההפעלה הראשונה.
                        </label>
                    )}
                    <button className="primary" disabled={busy}>
                        <Save size={15} />
                        שמירת הגדרות הפעלה
                    </button>
                </form>
            ) : (
                !error && <p>טוען אפשרויות הפעלה…</p>
            )}
            {error && (
                <div className="alert error">
                    <div>
                        {error}
                        <ErrorDetails details={details} />
                    </div>
                </div>
            )}
        </Popup>
    );
}

export function ProjectEnvironment({
    project,
    api,
    totpEnabled,
    close,
}: {
    project: Data;
    api: Api;
    totpEnabled: boolean;
    close: () => void;
}) {
    const [importText, setImportText] = useState<string | null>(null);
    const [importNames, setImportNames] = useState<string[]>([]);
    const [metadata, setMetadata] = useState<Data>({ keys: [], publicBuild: [] }),
        [rows, setRows] = useState<Data[]>([]),
        [loaded, setLoaded] = useState(false),
        [busy, setBusy] = useState(false),
        [error, setError] = useState(''),
        [details, setDetails] = useState<Data | null>(null);
    function applyEnvironment(data: Data) {
        setLoaded(true);
        setMetadata(data);
        setRows(
            data.keys.map((name: string) => ({
                name,
                value: data.values[name] || '',
                initial: data.values[name] || '',
                remove: false,
                public: data.publicBuild.includes(name),
            }))
        );
    }
    useEffect(() => {
        let stopped = false;
        api(`/projects/${project.id}/env/reveal`, 'POST', {})
            .then((data) => {
                if (!stopped) applyEnvironment(data);
            })
            .catch((e) => {
                if (!stopped) {
                    setError(e.message);
                    setDetails(e.details);
                }
            });
        return () => {
            stopped = true;
        };
    }, [project.id]);
    function change(index: number, key: string, value: any) {
        setRows(rows.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
    }
    return (
        <Popup title="משתני סביבה מוגנים" onClose={close}>
            {!loaded && !error && <p role="status">טוען משתני סביבה…</p>}
            <label>
                העלאת קובץ ENV (מיזוג)
                <input
                    type="file"
                    accept=".env,text/plain"
                    onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        setImportText(null);
                        setImportNames([]);
                        setError('');
                        if (file.size > 1048576) {
                            setError('הקובץ גדול מ־1 MiB');
                            return;
                        }
                        try {
                            const text = new TextDecoder('utf-8', { fatal: true }).decode(
                                await file.arrayBuffer()
                            );
                            const preview = await api(
                                `/projects/${project.id}/env/import/preview`,
                                'POST',
                                { text }
                            );
                            setImportText(text);
                            setImportNames(preview.keys);
                        } catch (error) {
                            setError((error as Error).message);
                        }
                    }}
                />
            </label>
            {importText !== null && (
                <div className="alert warning">
                    <p>
                        מוכן למיזוג:{' '}
                        {importNames
                            .map(
                                (name) =>
                                    `${name} (${metadata.keys.includes(name) ? 'החלפה' : 'חדש'})`
                            )
                            .join(', ')}
                    </p>
                    <p>הערכים יישמרו לריצה בלבד. משתנים אחרים יישמרו.</p>
                    <button
                        type="button"
                        onClick={() => {
                            setImportText(null);
                            setImportNames([]);
                        }}
                    >
                        ביטול הייבוא
                    </button>
                </div>
            )}
            <p className="muted">
                הערכים מוצגים למנהל המחובר במסך זה. שדה ריק משאיר ערך קיים ללא שינוי. משתנים נשמרים
                לריצה בלבד; סימון ציבורי לבנייה עלול להכניס ערך לקובצי Frontend.
            </p>
            <form
                autoComplete="off"
                onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy(true);
                    setError('');
                    try {
                        const set: Data = {},
                            unset: string[] = [],
                            publicBuild: string[] = [];
                        for (const row of rows) {
                            if (!row.name) continue;
                            if (row.remove) unset.push(row.name);
                            else {
                                if (row.value !== '' && row.value !== row.initial)
                                    set[row.name] = row.value;
                                if (row.public) publicBuild.push(row.name);
                            }
                        }
                        const result =
                            importText !== null
                                ? await api(`/projects/${project.id}/env/import`, 'POST', {
                                      text: importText,
                                  })
                                : await api(`/projects/${project.id}/env`, 'PATCH', {
                                      set,
                                      unset,
                                      publicBuild,
                                  });
                        setMetadata(result);
                        setImportText(null);
                        setImportNames([]);
                        setRows([]);
                        applyEnvironment(
                            await api(`/projects/${project.id}/env/reveal`, 'POST', {})
                        );
                    } catch (e) {
                        setError((e as Error).message);
                        setDetails((e as Data).details);
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                {rows.map((row, i) => (
                    <div className="environment-row" key={i}>
                        <input
                            aria-label={'שם משתנה ' + i}
                            placeholder="VARIABLE_NAME"
                            value={row.name}
                            readOnly={metadata.keys.includes(row.name)}
                            onChange={(e) => change(i, 'name', e.target.value)}
                            pattern="[A-Z][A-Z0-9_]{0,63}"
                        />
                        <input
                            aria-label={'ערך ' + row.name}
                            type="text"
                            name={'project-env-value-' + project.id + '-' + i}
                            autoComplete="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            data-lpignore="true"
                            data-1p-ignore="true"
                            data-bwignore="true"
                            placeholder="ערך המשתנה"
                            value={row.value}
                            onChange={(e) => change(i, 'value', e.target.value)}
                        />
                        <label className="checkbox-label">
                            <input
                                type="checkbox"
                                checked={row.remove}
                                onChange={(e) => change(i, 'remove', e.target.checked)}
                            />
                            מחיקה
                        </label>
                        <label className="checkbox-label">
                            <input
                                type="checkbox"
                                checked={row.public}
                                onChange={(e) => change(i, 'public', e.target.checked)}
                            />
                            ציבורי לבנייה
                        </label>
                    </div>
                ))}
                <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                        setRows([...rows, { name: '', value: '', remove: false, public: false }])
                    }
                >
                    הוספת משתנה
                </button>
                <button className="primary" disabled={busy || !loaded}>
                    שמירת משתני סביבה
                </button>
                {metadata.restartRequired && (
                    <p className="muted">
                        נשמר. יש להפעיל מחדש את הפרויקט כדי להחיל את הערכים. עדכון GitHub לא ימחק
                        אותם.
                    </p>
                )}
                {metadata.buildRequired && (
                    <p className="muted">
                        הגדרות או ערכים ציבוריים לבנייה השתנו. ההפעלה הבאה תכין גרסה חדשה; אפשר גם
                        ללחוץ על עדכון ופריסה.
                    </p>
                )}
            </form>
            {error && (
                <div className="alert error">
                    <div>
                        {error}
                        <ErrorDetails details={details} />
                    </div>
                </div>
            )}
        </Popup>
    );
}

export function ProjectConsole({
    project,
    api,
    subscribe,
    unsubscribe,
    records,
    error,
    gap,
    connected,
    jobs,
}: {
    project: Data;
    api: Api;
    subscribe: (id: string, cursor?: string) => void;
    unsubscribe: () => void;
    records: Data[];
    error: string;
    gap: string;
    connected: boolean;
    jobs: Data[];
}) {
    const [query, setQuery] = useState(''),
        [paused, setPaused] = useState(false),
        [cleared, setCleared] = useState(0),
        [history, setHistory] = useState<Data[]>([]),
        [snapshot, setSnapshot] = useState<Data>(project),
        [historyError, setHistoryError] = useState(''),
        [historyDetails, setHistoryDetails] = useState<Data | null>(null),
        [stateError, setStateError] = useState(''),
        [reading, setReading] = useState(true),
        [reload, setReload] = useState(0);
    const box = useRef<HTMLPreElement | null>(null);
    const connection = useRef(connected);
    connection.current = connected;
    useEffect(() => {
        let live = true;
        let busy = false;
        async function readHistory(initial = false) {
            try {
                const data = await api(`/projects/${project.id}/logs`);
                if (live) {
                    setHistory(data);
                    setHistoryError('');
                    setHistoryDetails(null);
                    if (initial) subscribe(project.id, data.at(-1)?.cursor);
                }
            } catch (e) {
                if (live) {
                    setHistoryError((e as Error).message);
                    setHistoryDetails((e as Data).details || null);
                    if (initial) subscribe(project.id);
                }
            } finally {
                if (live) setReading(false);
            }
        }
        async function state() {
            try {
                const data = await api(`/projects/${project.id}/lifecycle`);
                if (live) {
                    setSnapshot(data);
                    setStateError('');
                }
            } catch (e) {
                if (live) setStateError((e as Error).message);
            }
        }
        setReading(true);
        setHistory([]);
        busy = true;
        void Promise.all([readHistory(true), state()]).finally(() => {
            busy = false;
        });
        const timer = setInterval(async () => {
            if (document.hidden || busy) return;
            busy = true;
            try {
                await Promise.all([state(), ...(!connection.current ? [readHistory()] : [])]);
            } finally {
                busy = false;
            }
        }, 5000);
        /* History is useful even when a proxy cannot establish WebSocket. */
        return () => {
            live = false;
            clearInterval(timer);
            unsubscribe();
        };
    }, [project.id, reload]);
    useEffect(() => {
        if (!paused && box.current) box.current.scrollTop = box.current.scrollHeight;
    }, [records, history, paused]);
    useEffect(() => {
        if (records.length) {
            setHistoryError('');
            setHistoryDetails(null);
        }
    }, [records]);
    const all = [...history, ...records];
    const activity = snapshot.lastJob || jobs.find((j) => j.resource === 'project:' + project.id);
    const active = snapshot.observed?.active;
    const seen = new Set();
    const lines = all
        .filter((r) => {
            if (r.cursor && seen.has(r.cursor)) return false;
            seen.add(r.cursor);
            return true;
        })
        .slice(-700)
        .filter(
            (r) =>
                Date.parse(r.time || '') > cleared &&
                String(r.text).toLowerCase().includes(query.toLowerCase())
        );
    return (
        <section className="panel">
            <div className="panel-heading">
                <h2>
                    <Terminal size={18} />
                    קונסול · {project.name}
                </h2>
                <span className="badge">
                    {connected ? 'חיבור חי' : 'עדכון דרך HTTP כל 5 שניות'} · צפייה בלבד
                </span>
            </div>
            <div className="toolbar">
                <label className="search">
                    <input
                        aria-label="חיפוש בלוגי פרויקט"
                        placeholder="חיפוש בלוגים…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                </label>
                <button className="secondary" onClick={() => setPaused(!paused)}>
                    {paused ? 'חידוש גלילה' : 'עצירת גלילה'}
                </button>
                <button className="secondary" onClick={() => setCleared(Date.now())}>
                    ניקוי תצוגה
                </button>
                <button className="secondary" onClick={() => setReload((v) => v + 1)}>
                    רענון קונסול
                </button>
                <a
                    className="button secondary"
                    href={`/api/projects/${project.id}/logs/download?q=${encodeURIComponent(query)}`}
                >
                    הורדת לוגים
                </a>
            </div>
            {error && <div className="alert error">{error}</div>}
            {historyError && (
                <div className="alert error">
                    <div>
                        {historyError}
                        <ErrorDetails details={historyDetails} />
                    </div>
                </div>
            )}
            {stateError && (
                <div className="alert warning">לא ניתן לבדוק את מצב השירות: {stateError}</div>
            )}
            <p className="muted">
                מצב השירות:{' '}
                {active === 'active'
                    ? 'פעיל'
                    : active === 'inactive'
                      ? 'כבוי'
                      : active === 'failed'
                        ? 'נכשל'
                        : active === 'unmanaged'
                          ? 'טרם הוגדר'
                          : active || 'בודק…'}
            </p>
            {activity && ['queued', 'running'].includes(activity.status) && (
                <p className="alert warning">
                    פעולה מתבצעת ברקע: {activity.stage}. פלט האפליקציה יופיע לאחר שתתחיל לרוץ.
                </p>
            )}
            {activity?.status === 'failed' && (
                <div className="alert error">
                    <div>
                        <strong>פעולת הפרויקט נכשלה</strong>
                        <p>{activity.error}</p>
                        <ErrorDetails details={activity.details} jobId={activity.id} />
                    </div>
                </div>
            )}
            {gap && <div className="alert warning">{gap}</div>}
            <pre className="console" ref={box}>
                {lines.length
                    ? lines.map((r, i) => (
                          <div key={r.cursor || i} className={'log-' + r.level}>
                              {r.time} [{r.level}] {r.text}
                          </div>
                      ))
                    : reading
                      ? 'טוען היסטוריית לוגים…'
                      : all.length
                        ? 'אין הודעות התואמות לתצוגה ולחיפוש.'
                        : active === 'active'
                          ? 'השירות פעיל, אך עדיין לא נרשם פלט stdout/stderr.'
                          : activity?.status === 'failed'
                            ? 'האפליקציה לא עלתה. סיבת הכשל ופרטי הפריסה מוצגים למעלה.'
                            : 'אין כרגע פלט מהאפליקציה. הגדירו והפעילו את הפרויקט כדי לקבל לוגים.'}
            </pre>
        </section>
    );
}
