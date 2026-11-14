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
} from 'lucide-react';
import { ErrorDetails } from './diagnostics';
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
    showJobs,
    console: openConsole,
    totpEnabled,
}: {
    project: Data;
    api: Api;
    refresh: () => Promise<any>;
    showJobs: () => void;
    console: (id: string) => void;
    totpEnabled: boolean;
}) {
    const [modal, setModal] = useState(''),
        [busy, setBusy] = useState(false),
        [error, setError] = useState(''),
        [details, setDetails] = useState<Data | null>(null),
        [typed, setTyped] = useState(''),
        [password, setPassword] = useState(''),
        [code, setCode] = useState('');
    async function action(path: string, method = 'POST', body: Data = { confirmed: true }) {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            const result = await api(`/projects/${p.id}/` + path, method, body);
            setModal('');
            await refresh();
            if (result.job) showJobs();
        } catch (e) {
            setError((e as Error).message);
            setDetails((e as Data).details);
        } finally {
            setBusy(false);
        }
    }
    const archived = p.lifecycle === 'archived';
    let updates: Data = {};
    try {
        updates = JSON.parse(p.update_state || '{}');
    } catch {}
    return (
        <>
            <div className="project-controls lifecycle-actions">
                {archived ? (
                    <>
                        <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => setModal('restore')}
                        >
                            <RotateCw size={14} />
                            שחזור מהארכיון
                        </button>
                        <button className="text-btn danger-text" onClick={() => setModal('purge')}>
                            <Trash2 size={14} />
                            מחיקה לצמיתות
                        </button>
                    </>
                ) : (
                    <>
                        <button className="secondary" onClick={() => setModal('runtime')}>
                            <Settings size={14} />
                            הגדרות הפעלה
                        </button>
                        <button
                            className="primary"
                            disabled={busy}
                            onClick={() => setModal(p.runtime ? 'start' : 'runtime')}
                        >
                            <Play size={14} />
                            הפעלת פרויקט
                        </button>
                        <button
                            className="secondary"
                            disabled={busy || !p.service}
                            onClick={() => setModal('stop')}
                        >
                            <Square size={14} />
                            עצירה
                        </button>
                        <button
                            className="secondary"
                            disabled={busy || !p.runtime}
                            onClick={() => setModal('restart')}
                        >
                            <RotateCw size={14} />
                            הפעלה מחדש
                        </button>
                        <button className="secondary" onClick={() => openConsole(p.id)}>
                            <Terminal size={14} />
                            קונסול הפרויקט
                        </button>
                        <button
                            className="secondary"
                            disabled={busy || !p.runtime}
                            onClick={() => setModal('activate')}
                        >
                            <RefreshCw size={14} />
                            עדכון ופריסה
                        </button>
                        <button className="text-btn" onClick={() => setModal('archive')}>
                            <Archive size={14} />
                            העברה לארכיון
                        </button>
                    </>
                )}
            </div>
            {!archived && (
                <div className="project-update-status">
                    <label>
                        עדכוני GitHub
                        <select
                            aria-label={'עדכונים עבור ' + p.name}
                            value={p.updates || 'manual'}
                            disabled={busy || !p.repo || !p.runtime}
                            onChange={(e) =>
                                void action('updates', 'PATCH', { mode: e.target.value })
                            }
                        >
                            <option value="manual">ידני — עדכון בלחיצה</option>
                            <option value="auto">אוטומטי — בדיקה כל דקה</option>
                        </select>
                    </label>
                    <small>
                        שירות:{' '}
                        {p.desired === 'running' ? 'נדרש לפעול' : p.runtime ? 'כבוי' : 'טרם הוגדר'}{' '}
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
                    <div className="commit-grid">
                        {[
                            ['קומיט מרוחק', updates.remoteCommit || p.remoteCommit],
                            ['גרסה מוכנה', p.preparedCommit],
                            ['גרסה פעילה', p.activeCommit],
                            ['קומיט שנכשל', p.failedCommit || updates.failedCommit],
                        ].map(([label, value]) => (
                            <span key={label}>
                                {label}:{' '}
                                <b className="mono">{value ? String(value).slice(0, 14) : '—'}</b>
                            </span>
                        ))}
                    </div>
                    <small>
                        בדיקה אחרונה:{' '}
                        {updates.checkedAt || p.checkedAt
                            ? new Date(updates.checkedAt || p.checkedAt).toLocaleString('he-IL')
                            : 'טרם נבדק'}
                    </small>
                    {updates.remoteCommit && updates.remoteCommit !== p.preparedCommit && (
                        <small>ממתין לעדכון: {updates.remoteCommit.slice(0, 14)}</small>
                    )}
                    {updates.error && <p className="danger-text">{updates.error}</p>}
                </div>
            )}
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
            {modal === 'runtime' && (
                <RuntimeEditor
                    p={p}
                    api={api}
                    close={() => setModal('')}
                    saved={async () => {
                        setModal('');
                        await refresh();
                        showJobs();
                    }}
                />
            )}
            {modal && modal !== 'runtime' && (
                <Popup
                    title={
                        {
                            start: 'הפעלת פרויקט',
                            stop: 'עצירת פרויקט',
                            restart: 'הפעלה מחדש',
                            activate: 'עדכון ופריסה',
                            archive: 'ארכוב פרויקט',
                            restore: 'שחזור פרויקט',
                            purge: 'מחיקה לצמיתות',
                        }[modal] || modal
                    }
                    onClose={() => setModal('')}
                >
                    <p className="muted">
                        {modal === 'archive'
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
                                    password,
                                    ...(totpEnabled ? { code } : {}),
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
                        {modal === 'purge' && (
                            <>
                                <label>
                                    סיסמה נוכחית
                                    <input
                                        required
                                        type="password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                    />
                                </label>
                                {totpEnabled && (
                                    <label>
                                        קוד אימות
                                        <input
                                            required
                                            value={code}
                                            onChange={(e) => setCode(e.target.value)}
                                        />
                                    </label>
                                )}
                            </>
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
                        testScript: data.scripts.includes('test') ? 'test' : '',
                        buildScript: data.scripts.includes('build') ? 'build' : '',
                    }));
            })
            .catch((e) => {
                setError(e.message);
                setDetails(e.details);
            });
    }, [p.id]);
    const set = (key: string, value: any) => setRuntime({ ...runtime, [key]: value });
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
                    <label>
                        פורט בשרת (localhost בלבד)
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
    const [metadata, setMetadata] = useState<Data>({ keys: [], publicBuild: [] }),
        [rows, setRows] = useState<Data[]>([]),
        [password, setPassword] = useState(''),
        [code, setCode] = useState(''),
        [busy, setBusy] = useState(false),
        [error, setError] = useState(''),
        [details, setDetails] = useState<Data | null>(null);
    useEffect(() => {
        api(`/projects/${project.id}/env`)
            .then((data) => {
                setMetadata(data);
                setRows(
                    data.keys.map((name: string) => ({
                        name,
                        value: '',
                        remove: false,
                        public: data.publicBuild.includes(name),
                    }))
                );
            })
            .catch((e) => {
                setError(e.message);
                setDetails(e.details);
            });
    }, [project.id]);
    function change(index: number, key: string, value: any) {
        setRows(rows.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
    }
    return (
        <Popup title="משתני סביבה מוגנים" onClose={close}>
            <p className="muted">
                הערכים הקיימים אינם מוחזרים לדפדפן. שדה ריק משאיר ערך קיים ללא שינוי. סודות נשמרים
                לריצה בלבד; סימון ציבורי לבנייה עלול להכניס ערך לקובצי Frontend.
            </p>
            <form
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
                                if (row.value !== '') set[row.name] = row.value;
                                if (row.public) publicBuild.push(row.name);
                            }
                        }
                        const result = await api(`/projects/${project.id}/env`, 'PATCH', {
                            set,
                            unset,
                            publicBuild,
                            password,
                            ...(totpEnabled ? { code } : {}),
                        });
                        setMetadata(result);
                        setPassword('');
                        setCode('');
                        setRows(
                            result.keys.map((name: string) => ({
                                name,
                                value: '',
                                remove: false,
                                public: result.publicBuild.includes(name),
                            }))
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
                            aria-label={'ערך חדש ' + row.name}
                            type="password"
                            autoComplete="off"
                            placeholder="ללא שינוי"
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
                <label>
                    סיסמה נוכחית
                    <input
                        required
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </label>
                {totpEnabled && (
                    <label>
                        קוד אימות
                        <input required value={code} onChange={(e) => setCode(e.target.value)} />
                    </label>
                )}
                <button className="primary" disabled={busy}>
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
}: {
    project: Data;
    api: Api;
    subscribe: (id: string, cursor?: string) => void;
    unsubscribe: () => void;
    records: Data[];
    error: string;
    gap: string;
}) {
    const [query, setQuery] = useState(''),
        [paused, setPaused] = useState(false),
        [cleared, setCleared] = useState(0),
        [history, setHistory] = useState<Data[]>([]);
    const box = useRef<HTMLPreElement | null>(null);
    useEffect(() => {
        let live = true;
        api(`/projects/${project.id}/logs`)
            .then((data) => {
                if (live) {
                    setHistory(data);
                    subscribe(project.id, data.at(-1)?.cursor);
                }
            })
            .catch(() => {
                if (live) subscribe(project.id);
            });
        return () => {
            live = false;
            unsubscribe();
        };
    }, [project.id]);
    useEffect(() => {
        if (!paused && box.current) box.current.scrollTop = box.current.scrollHeight;
    }, [records, history, paused]);
    const all = [...history, ...records];
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
                <span className="badge">צפייה בלבד</span>
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
                <a
                    className="button secondary"
                    href={`/api/projects/${project.id}/logs/download?q=${encodeURIComponent(query)}`}
                >
                    הורדת לוגים
                </a>
            </div>
            {error && <div className="alert error">{error}</div>}
            {gap && <div className="alert warning">{gap}</div>}
            <pre className="console" ref={box}>
                {lines.length
                    ? lines.map((r, i) => (
                          <div key={r.cursor || i} className={'log-' + r.level}>
                              {r.time} [{r.level}] {r.text}
                          </div>
                      ))
                    : 'ממתין ללוגים מהפרויקט…'}
            </pre>
        </section>
    );
}
