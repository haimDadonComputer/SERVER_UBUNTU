import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
    Activity,
    LayoutDashboard,
    Network,
    FolderGit2,
    Settings,
    ShieldCheck,
    LogOut,
    Sun,
    Moon,
    RefreshCw,
    Terminal,
    Search,
    Play,
    Square,
    RotateCw,
    Folder,
    GitBranch,
    Plus,
    X,
    Download,
    Check,
    AlertTriangle,
    Server,
    ArrowDown,
    ArrowUp,
    ChevronLeft,
    FileText,
    Save,
    Trash2,
    Upload,
    Lock,
    Clock,
    CheckCircle2,
    Loader2,
} from 'lucide-react';
import './style.css';
import { GitHubSettings, GitHubImport } from './github';
import { ErrorDetails } from './diagnostics';
import { ProjectActions, ProjectEnvironment, ProjectConsole } from './projects';
import { JobCard, stageLabel } from './jobs';
import { NetworkSettings } from './network';
import { ContentTabs, SummaryStrip } from './content';
type Any = Record<string, any>;
let csrf = '';
async function api(url: string, method = 'GET', body?: unknown) {
    const r = await fetch('/api' + url, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
        if (r.status === 401 && url !== '/login' && url !== '/me')
            window.dispatchEvent(new Event('expired'));
        throw Object.assign(new Error(data.error || 'הפעולה נכשלה'), { details: data.details });
    }
    return data;
}
const bytes = (n: number | null | undefined) =>
    n == null
        ? 'לא זמין'
        : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(n / 1024 ** 3) + ' GB';
const rate = (n: number | null | undefined) =>
    n == null ? 'לא זמין' : (n / 1024).toFixed(1) + ' KB/s';
const statusLabel: Any = {
    active: 'פעיל',
    running: 'פעיל',
    inactive: 'כבוי',
    failed: 'שגיאה',
    activating: 'בהפעלה',
    unmanaged: 'לא מנוהל',
    unknown: 'לא ידוע',
    done: 'הושלם',
    queued: 'ממתין',
    interrupted: 'נקטע',
};
const exposureLabel: Any = {
    local: 'מקומי בלבד',
    unknown: 'לא ידוע',
    blocked: 'חסום',
    open: 'פתוח',
};
function Badge({ value, label }: { value: string; label?: string }) {
    return (
        <span className={'badge ' + value}>
            <i />
            {label || statusLabel[value] || value}
        </span>
    );
}
function App() {
    const [user, setUser] = useState<Any | null>(null),
        [loading, setLoading] = useState(true),
        [page, setPage] = useState('dashboard'),
        [dark, setDark] = useState(localStorage.getItem('theme') !== 'light'),
        [error, setError] = useState(''),
        [errorDetails, setErrorDetails] = useState<Any | null>(null),
        [notice, setNotice] = useState(''),
        [pending, setPending] = useState(false),
        [metrics, setMetrics] = useState<Any>({}),
        [inv, setInv] = useState<Any>({ ports: [], services: [] }),
        [projects, setProjects] = useState<Any[]>([]),
        [serverAddresses, setServerAddresses] = useState<Any[]>([]),
        [archivedProjects, setArchivedProjects] = useState<Any[]>([]),
        [showArchived, setShowArchived] = useState(false),
        [envProject, setEnvProject] = useState<Any | null>(null),
        [projectConsole, setProjectConsole] = useState<Any | null>(null),
        [projectLogs, setProjectLogs] = useState<Any[]>([]),
        [projectLogError, setProjectLogError] = useState(''),
        [projectLogGap, setProjectLogGap] = useState(''),
        [jobs, setJobs] = useState<Any[]>([]),
        [jobPanel, setJobPanel] = useState(false),
        [selectedJob, setSelectedJob] = useState(''),
        [publications, setPublications] = useState<Any>({}),
        [managementHosts, setManagementHosts] = useState<string[] | null>(null),
        [publicationStatusKnown, setPublicationStatusKnown] = useState(false),
        [connected, setConnected] = useState(false),
        [modal, setModal] = useState<React.ReactNode>(null),
        [query, setQuery] = useState(''),
        [filter, setFilter] = useState('all'),
        [projectFilter, setProjectFilter] = useState('all'),
        [jobFilter, setJobFilter] = useState('all'),
        [settingsCategory, setSettingsCategory] = useState('security'),
        [sort, setSort] = useState('port'),
        [consoleService, setConsoleService] = useState(''),
        [logs, setLogs] = useState(''),
        [logSearch, setLogSearch] = useState(''),
        [paused, setPaused] = useState(false),
        [fileProject, setFileProject] = useState<Any | null>(null),
        [filePath, setFilePath] = useState(''),
        [entries, setEntries] = useState<Any[]>([]),
        [editing, setEditing] = useState(''),
        [content, setContent] = useState(''),
        [settings, setSettings] = useState<Any | null>(null),
        [audit, setAudit] = useState<Any[]>([]),
        [backups, setBackups] = useState<string[]>([]),
        [firewall, setFirewall] = useState<Any | null>(null),
        [tx, setTx] = useState(''),
        [totpSecret, setTotpSecret] = useState<Any | null>(null);
    const ws = useRef<WebSocket | null>(null),
        logBox = useRef<HTMLPreElement | null>(null),
        consoleRef = useRef('');
    const projectLogRef = useRef<{ id: string; cursor?: string } | null>(null);
    function subscribeProject(id: string, cursor?: string) {
        projectLogRef.current = { id, cursor };
        if (!document.hidden && ws.current?.readyState === WebSocket.OPEN)
            ws.current.send(JSON.stringify({ type: 'project-logs', project: id, cursor }));
    }
    function unsubscribeProject() {
        projectLogRef.current = null;
        if (ws.current?.readyState === WebSocket.OPEN)
            ws.current.send(JSON.stringify({ type: 'project-unsubscribe' }));
    }
    function openProjectConsole(id: string) {
        setProjectConsole(projects.find((p) => p.id === id) || { id, name: id });
        setProjectLogs([]);
        setProjectLogError('');
        setProjectLogGap('');
        setPage('project-console');
    }
    useEffect(() => {
        if (page !== 'console') {
            consoleRef.current = '';
            if (ws.current?.readyState === WebSocket.OPEN)
                ws.current.send(JSON.stringify({ type: 'logs', service: '' }));
        }
        if (page !== 'project-console') unsubscribeProject();
    }, [page]);
    useEffect(() => {
        const visible = () => {
            if (ws.current?.readyState !== WebSocket.OPEN) return;
            const current = projectLogRef.current;
            if (current)
                ws.current.send(
                    JSON.stringify(
                        document.hidden
                            ? { type: 'project-unsubscribe' }
                            : { type: 'project-logs', project: current.id, cursor: current.cursor }
                    )
                );
            ws.current.send(
                JSON.stringify({ type: 'logs', service: document.hidden ? '' : consoleRef.current })
            );
        };
        document.addEventListener('visibilitychange', visible);
        return () => document.removeEventListener('visibilitychange', visible);
    }, []);
    useEffect(() => {
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        localStorage.setItem('theme', dark ? 'dark' : 'light');
    }, [dark]);
    useEffect(() => {
        api('/me')
            .then((u) => {
                csrf = u.csrf;
                setUser(u);
            })
            .catch(() => {})
            .finally(() => setLoading(false));
        const expire = () => {
            setUser(null);
            csrf = '';
            setModal(null);
            setTotpSecret(null);
            setLogs('');
            setContent('');
            setEnvProject(null);
            setProjectLogs([]);
            unsubscribeProject();
            setNotice('פג תוקף ההתחברות. יש להתחבר מחדש.');
        };
        window.addEventListener('expired', expire);
        return () => window.removeEventListener('expired', expire);
    }, []);
    async function run(fn: () => Promise<any>, message = 'הפעולה הושלמה') {
        if (pending) return;
        setPending(true);
        setError('');
        setErrorDetails(null);
        try {
            const result = await fn();
            if (message)
                setNotice(result?.job ? 'הפעולה נוספה לתור. התוצאה תופיע במשימות.' : message);
            return result;
        } catch (e) {
            setError((e as Error).message);
            setErrorDetails((e as Any).details || null);
        } finally {
            setPending(false);
        }
    }
    async function refresh() {
        const results = await Promise.allSettled([
            api('/metrics'),
            api('/inventory'),
            api('/projects'),
            api('/jobs'),
            api('/settings'),
            api('/projects?state=archived'),
            api('/project-access'),
        ]);
        if (results[0].status === 'fulfilled') setMetrics(results[0].value);
        if (results[1].status === 'fulfilled') setInv(results[1].value);
        else
            setInv({
                ports: [],
                services: [],
                error: results[1].reason.message,
                details: results[1].reason.details,
            });
        if (results[2].status === 'fulfilled') setProjects(results[2].value);
        if (results[3].status === 'fulfilled') setJobs(results[3].value);
        if (results[4].status === 'fulfilled') setSettings(results[4].value);
        if (results[5].status === 'fulfilled') setArchivedProjects(results[5].value);
        if (results[6].status === 'fulfilled') setServerAddresses(results[6].value.addresses || []);
        if (results[6].status === 'fulfilled') {
            setPublications(results[6].value.publications || {});
            setManagementHosts(
                Array.isArray(results[6].value.managementHosts)
                    ? results[6].value.managementHosts
                    : null
            );
            setPublicationStatusKnown(results[6].value.publicationStatusKnown === true);
        } else {
            setPublicationStatusKnown(false);
            setManagementHosts(null);
        }
    }
    useEffect(() => {
        if (!user) return;
        void refresh();
        let stopped = false,
            retry: ReturnType<typeof setTimeout>;
        function connect() {
            if (stopped) return;
            const socket = new WebSocket(
                `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
            );
            ws.current = socket;
            socket.onopen = () => {
                setConnected(true);
                if (consoleRef.current)
                    socket.send(JSON.stringify({ type: 'logs', service: consoleRef.current }));
                if (projectLogRef.current && !document.hidden) {
                    const { id, cursor } = projectLogRef.current;
                    socket.send(JSON.stringify({ type: 'project-logs', project: id, cursor }));
                }
            };
            socket.onmessage = (e) => {
                const data = JSON.parse(e.data);
                if (data.type === 'snapshot') {
                    setMetrics(data.metrics);
                    setInv(data.inventory);
                }
                if (data.type === 'jobs') setJobs(data.jobs);
                if (data.type === 'logs') setLogs(data.text);
                if (data.type === 'log-error') setError(data.error);
                if (data.project === projectLogRef.current?.id) {
                    if (data.type === 'project-log') {
                        projectLogRef.current!.cursor = data.cursor;
                        setProjectLogError('');
                        setProjectLogs((records) => [...records, data].slice(-500));
                    }
                    if (data.type === 'project-log-gap')
                        setProjectLogGap(data.text || 'חלק מההודעות חסרות.');
                    if (data.type === 'project-log-error') setProjectLogError(data.error);
                    if (data.type === 'project-log-reconnect')
                        setTimeout(() => {
                            const current = projectLogRef.current;
                            if (current && current.id === data.project)
                                subscribeProject(current.id, current.cursor);
                        }, 4000);
                }
            };
            socket.onclose = () => {
                setConnected(false);
                if (!stopped) retry = setTimeout(connect, 4000);
            };
        }
        connect();
        const interval = setInterval(() => {
            if (!document.hidden && ws.current?.readyState !== WebSocket.OPEN) {
                api('/inventory')
                    .then(setInv)
                    .catch((error) =>
                        setInv({
                            ports: [],
                            services: [],
                            error: error.message,
                            details: error.details,
                        })
                    );
            }
            api('/jobs')
                .then(setJobs)
                .catch(() => {});
            api('/projects')
                .then(setProjects)
                .catch(() => {});
            api('/projects?state=archived')
                .then(setArchivedProjects)
                .catch(() => {});
            api('/project-access')
                .then((data) => {
                    setServerAddresses(data.addresses || []);
                    setPublications(data.publications || {});
                    setManagementHosts(
                        Array.isArray(data.managementHosts) ? data.managementHosts : null
                    );
                    setPublicationStatusKnown(data.publicationStatusKnown === true);
                })
                .catch(() => {
                    setPublicationStatusKnown(false);
                    setManagementHosts(null);
                });
        }, 5000);
        return () => {
            stopped = true;
            clearTimeout(retry);
            clearInterval(interval);
            ws.current?.close();
        };
    }, [user?.username]);
    useEffect(() => {
        if (!user) return;
        let activity = 0,
            sent = 0;
        const mark = () => {
            activity = Date.now();
        };
        const events = ['pointerdown', 'keydown', 'touchstart'];
        events.forEach((e) => window.addEventListener(e, mark, { passive: true }));
        const timer = setInterval(() => {
            if (!document.hidden && activity > sent) {
                sent = activity;
                api('/activity', 'POST', {}).catch(() => {});
            }
        }, 30000);
        return () => {
            clearInterval(timer);
            events.forEach((e) => window.removeEventListener(e, mark));
        };
    }, [user?.username]);
    useEffect(() => {
        if (page === 'settings' && user) {
            api('/settings')
                .then(setSettings)
                .catch((e) => setError(e.message));
            api('/audit')
                .then(setAudit)
                .catch(() => {});
            api('/backups')
                .then(setBackups)
                .catch(() => {});
        }
    }, [page, user]);
    useEffect(() => {
        if (fileProject)
            api(`/projects/${fileProject.id}/files?path=${encodeURIComponent(filePath)}`)
                .then(setEntries)
                .catch((e) => setError(e.message));
    }, [fileProject, filePath]);
    useEffect(() => {
        if (!paused && logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
    }, [logs, paused]);
    useEffect(() => {
        if (!notice) return;
        const t = setTimeout(() => setNotice(''), 7000);
        return () => clearTimeout(t);
    }, [notice]);
    function openConsole(id: string) {
        setConsoleService(id);
        consoleRef.current = id;
        setLogs('');
        setPage('console');
        api('/logs/' + id)
            .then((d) => setLogs(d.text))
            .catch((e) => setError(e.message));
        ws.current?.send(JSON.stringify({ type: 'logs', service: id }));
    }
    function serviceAction(id: string, operation: string) {
        const count = (inv.ports || []).filter((p: Any) => p.service === id).length;
        setModal(
            <Confirm
                title="אישור פעולה על שירות"
                text={`הפעולה ${operation} תשפיע על השירות כולו ועל ${count} הפורטים המשויכים אליו. ייתכן ניתוק זמני של משתמשים.`}
                onClose={() => setModal(null)}
                onConfirm={() => {
                    setModal(null);
                    void run(() => api('/services/' + id, 'POST', { operation, confirmed: true }));
                }}
            />
        );
    }
    function projectModal() {
        setModal(
            <Form
                title="יצירת תיקיית פרויקט"
                fields={[
                    { key: 'id', label: 'שם תיקייה באנגלית', placeholder: 'my-app' },
                    { key: 'name', label: 'שם לתצוגה', placeholder: 'האפליקציה שלי' },
                    {
                        key: 'repo',
                        label: 'מאגר GitHub (לא חובה)',
                        placeholder: 'https://github.com/org/repo.git',
                        required: false,
                    },
                    {
                        key: 'branch',
                        label: 'ענף Git (ברירת מחדל: main)',
                        placeholder: 'main',
                        required: false,
                    },
                    {
                        key: 'kind',
                        label: 'סוג הפרויקט',
                        type: 'select',
                        options: [
                            ['node', 'Node.js'],
                            ['docker', 'Docker'],
                        ],
                    },
                    {
                        key: 'service',
                        label: 'שיוך שירות קיים (לא חובה)',
                        type: 'select',
                        options: [
                            ['', 'ללא שירות — תיקייה וקבצים בלבד'],
                            ...(inv.services || []).map((s: Any) => [s.id, s.name]),
                        ],
                    },
                    {
                        key: 'health_port',
                        label: 'פורט בדיקת תקינות (נדרש אם משייכים שירות)',
                        type: 'number',
                        required: false,
                    },
                ]}
                description="התיקייה תיווצר תחת תיקיית הפרויקטים של השרת. אפשר להוסיף כמה פרויקטים ישירות מכאן, ללא עריכת קובץ תצורה. אם כבר קיימת תיקייה באותו שם, היא תיפתח בלי למחוק את תוכנה."
                onClose={() => setModal(null)}
                submit={async (values: Any) => {
                    await api('/projects', 'POST', { ...values, branch: values.branch || 'main' });
                    setModal(null);
                    await refresh();
                }}
            />
        );
    }
    function firewallModal(p: Any) {
        setModal(
            <Form
                title={`כלל חומת אש · ${p.port}/${p.protocol}`}
                description="כללים אינם הוכחה לנגישות מבחוץ. פתיחה אינה משנה את כתובת ההאזנה או את ה־Reverse Proxy. פורטי ניהול ושירותים רגישים מוגנים משינוי. הכלל יוחזר בתוך שתי דקות אם לא יאושר."
                fields={[
                    { key: 'source', label: 'טווח IP מורשה (CIDR)', placeholder: '203.0.113.4/32' },
                    {
                        key: 'operation',
                        label: 'פעולה',
                        type: 'select',
                        options: [
                            ['allow', 'הוספת הרשאה'],
                            ['remove', 'הסרת הרשאת המערכת'],
                        ],
                    },
                    {
                        key: 'worldConfirmed',
                        label: 'אני מאשר במפורש גישה מכל העולם אם הזנתי ‎/0',
                        type: 'checkbox',
                    },
                ]}
                onClose={() => setModal(null)}
                submit={async (values: Any) => {
                    const result = await api('/firewall', 'POST', {
                        ...values,
                        port: p.port,
                        protocol: p.protocol,
                        confirmed: true,
                        worldConfirmed: !!values.worldConfirmed,
                    });
                    setTx(result.transaction);
                    setModal(null);
                }}
            />
        );
    }
    function deploy(p: Any) {
        void run(async () => {
            const preview = await api(`/projects/${p.id}/preview`, 'POST', {});
            setModal(
                <Confirm
                    title="סקירת פריסה מ־GitHub"
                    text={`מאגר: ${preview.repo}\nענף: ${preview.branch}\nגרסה: ${preview.remoteCommit}\n${preview.changes || 'אין קומיטים חדשים ביחס למאגר המקומי'}\nהפריסה תריץ קוד מהמאגר (התקנת תלויות, בדיקות ובנייה) כמשתמש פרויקטים מבודד. השירות יופעל מחדש ותבוצע בדיקת HTTP. נתוני shared יישמרו.`}
                    onClose={() => setModal(null)}
                    onConfirm={() => {
                        setModal(null);
                        void run(() =>
                            api(`/projects/${p.id}/deploy`, 'POST', {
                                expected: preview.remoteCommit,
                                confirmed: true,
                            })
                        );
                    }}
                />
            );
        }, '');
    }
    function envModal(p: Any) {
        setEnvProject(p);
    }
    function accountModal() {
        setModal(
            <Form
                title="עדכון פרטי התחברות"
                fields={[
                    { key: 'username', label: 'שם משתמש חדש', placeholder: user?.username },
                    { key: 'newPassword', label: 'סיסמה חדשה (14 תווים לפחות)', type: 'password' },
                ]}
                onClose={() => setModal(null)}
                submit={async (v: Any) => {
                    await api('/account', 'POST', v);
                    setModal(null);
                    setUser(null);
                    csrf = '';
                }}
            />
        );
    }
    function actionModal(action: string, title: string) {
        setModal(
            <Form
                title={title}
                fields={[]}
                onClose={() => setModal(null)}
                submit={async (v: Any) => {
                    const data = await api(action, 'POST', v);
                    setModal(null);
                    if (action === '/totp/setup') setTotpSecret(data);
                    else {
                        setNotice('הפעולה הושלמה');
                        if (action.includes('totp')) setUser({ ...user, totpEnabled: false });
                        if (action === '/backups') setBackups(await api('/backups'));
                    }
                }}
            />
        );
    }
    const titles: Any = {
        dashboard: 'סקירת השרת',
        ports: 'פורטים ושירותים',
        projects: 'הפרויקטים שלי',
        console: 'קונסול שירות',
        'project-console': 'קונסול הפרויקט',
        files: 'קבצי הפרויקט',
        settings: 'הגדרות ואבטחה',
        jobs: 'משימות רקע',
    };
    const ports = (inv.ports || [])
        .filter(
            (p: Any) =>
                `${p.port} ${p.process || ''} ${p.service || ''} ${p.address}`
                    .toLowerCase()
                    .includes(query.toLowerCase()) &&
                (filter === 'all' || p.status === filter)
        )
        .sort((a: Any, b: Any) =>
            sort === 'port'
                ? a.port - b.port
                : String(a[sort] || '').localeCompare(String(b[sort] || ''))
        );
    const failed = inv.failed || [],
        activeJobs = jobs.filter((j) => ['queued', 'running'].includes(j.status));
    const projectStatus = (p: Any) =>
        p.lifecycle === 'archived'
            ? 'archived'
            : !p.runtime && !p.service
              ? 'unconfigured'
              : inv.services?.find((s: Any) => s.id === p.service)?.status || 'unknown';
    const visibleProjects = (showArchived ? archivedProjects : projects).filter((p) => {
        const match = [p.name, p.id, p.repo].some((value) =>
            String(value || '')
                .toLowerCase()
                .includes(query.toLowerCase())
        );
        const state = projectStatus(p);
        return (
            match &&
            (showArchived ||
                projectFilter === 'all' ||
                (projectFilter === 'running' && state === 'active') ||
                (projectFilter === 'stopped' && ['inactive', 'stopped'].includes(state)) ||
                (projectFilter === 'attention' &&
                    (state === 'failed' ||
                        p.recoveryPending ||
                        String(p.deployment || '').startsWith('failed'))))
        );
    });
    const visibleJobs = jobs.filter(
        (j) =>
            jobFilter === 'all' ||
            (jobFilter === 'active' && ['queued', 'running'].includes(j.status)) ||
            (jobFilter === 'failed' && ['failed', 'interrupted'].includes(j.status)) ||
            (jobFilter === 'done' && j.status === 'done')
    );
    const btnService = (id: string) => (
        <div className="actions">
            <button
                title="הפעלה"
                aria-label="הפעלת שירות"
                onClick={() => serviceAction(id, 'start')}
            >
                <Play size={14} />
            </button>
            <button
                title="כיבוי"
                aria-label="כיבוי שירות"
                onClick={() => serviceAction(id, 'stop')}
            >
                <Square size={14} />
            </button>
            <button
                title="הפעלה מחדש"
                aria-label="הפעלה מחדש"
                onClick={() => serviceAction(id, 'restart')}
            >
                <RotateCw size={14} />
            </button>
            <button title="קונסול" aria-label="פתיחת קונסול" onClick={() => openConsole(id)}>
                <Terminal size={14} />
            </button>
        </div>
    );
    if (loading)
        return (
            <div className="login-screen">
                <Loader2 className="spin" /> טוען את סביבת הניהול…
            </div>
        );
    if (!user)
        return (
            <div className="login-screen">
                <div className="login-brand">
                    <Server size={36} />
                    <strong>
                        Ubuntu<span>Control</span>
                    </strong>
                    <p>כל השרת. במקום אחד.</p>
                </div>
                <Login
                    onLogin={(u) => {
                        csrf = u.csrf;
                        setUser(u);
                        setError('');
                        setNotice('');
                    }}
                />
                {notice && <p>{notice}</p>}
                <small>
                    <Lock size={12} /> גישה למנהלים מורשים בלבד · יצירת מנהל ראשוני דרך ההתקנה
                </small>
            </div>
        );
    return (
        <div className="app">
            <aside>
                <a
                    className="brand"
                    href="#"
                    onClick={(e) => {
                        e.preventDefault();
                        setPage('dashboard');
                    }}
                >
                    <div className="brand-icon">
                        <Server size={23} />
                    </div>
                    <div>
                        Ubuntu<span>Control</span>
                        <small>סביבת הניהול שלך</small>
                    </div>
                </a>
                <div className="nav-label">סביבת עבודה</div>
                <nav>
                    {[
                        ['dashboard', LayoutDashboard, 'לוח בקרה'],
                        ['ports', Network, 'פורטים ושירותים'],
                        ['projects', FolderGit2, 'פרויקטים'],
                        ['jobs', Activity, 'משימות רקע'],
                        ['settings', Settings, 'הגדרות ואבטחה'],
                    ].map(([id, Icon, label]: any) => (
                        <button
                            key={id}
                            className={page === id ? 'selected' : ''}
                            onClick={() => setPage(id)}
                        >
                            <Icon size={19} />
                            {label}
                            {id === 'jobs' && activeJobs.length > 0 && (
                                <span className="nav-count">{activeJobs.length}</span>
                            )}
                        </button>
                    ))}
                </nav>
                <div className="sidebar-bottom">
                    <div className="local-note">
                        <ShieldCheck size={20} />
                        <div>
                            גישה מוגנת<small>Session מאובטח · ניתוק לאחר 15 דקות</small>
                        </div>
                    </div>
                    <button
                        className="user"
                        onClick={() =>
                            void run(async () => {
                                await api('/logout', 'POST', {});
                                setUser(null);
                                csrf = '';
                            }, '')
                        }
                    >
                        <span className="avatar">{user.username[0].toUpperCase()}</span>
                        <div>
                            {user.username}
                            <small>מנהל מערכת</small>
                        </div>
                        <LogOut size={17} />
                    </button>
                </div>
            </aside>
            <main>
                <header>
                    <div className="breadcrumb">
                        סביבת ניהול <ChevronLeft size={13} /> <strong>{titles[page]}</strong>
                    </div>
                    <div className="header-actions">
                        <button onClick={() => setJobPanel(!jobPanel)} aria-expanded={jobPanel}>
                            פאנל{' '}
                            {activeJobs.length > 0 && (
                                <span className="badge">{activeJobs.length}</span>
                            )}
                        </button>
                        <span className={'connection ' + (connected ? 'online' : '')}>
                            <i />
                            {connected ? 'חיבור חי' : 'החיבור נותק'}
                        </span>
                        <button
                            title="החלפת ערכת צבעים"
                            aria-label="החלפת ערכת צבעים"
                            onClick={() => setDark(!dark)}
                        >
                            {dark ? <Sun size={18} /> : <Moon size={18} />}
                        </button>
                        <span className="avatar small">{user.username[0].toUpperCase()}</span>
                    </div>
                </header>
                <div className="workspace">
                    <div className="page-heading">
                        <div>
                            <div className="eyebrow">SERVER MANAGEMENT / {page.toUpperCase()}</div>
                            <h1>{titles[page]}</h1>
                            <p>
                                {page === 'dashboard'
                                    ? 'תמונה עדכנית של מה שקורה בשרת שלך.'
                                    : page === 'ports'
                                      ? 'כל נקודות הכניסה, השירותים והשליטה בהם.'
                                      : page === 'projects'
                                        ? 'מהקוד ועד לשירות שעובד על השרת.'
                                        : 'ניהול מאובטח, עם מידע ישירות מהמערכת.'}
                            </p>
                        </div>
                        <button
                            className="secondary"
                            disabled={pending}
                            onClick={() => void run(refresh, 'הנתונים רועננו')}
                        >
                            <RefreshCw size={16} className={pending ? 'spin' : ''} />
                            רענון נתונים
                        </button>
                    </div>
                    {error && (
                        <div role="alert" className="alert error">
                            <AlertTriangle size={18} />
                            <div className="grow">
                                {error}
                                <ErrorDetails details={errorDetails} />
                            </div>
                            <button aria-label="סגירה" onClick={() => setError('')}>
                                <X size={16} />
                            </button>
                        </div>
                    )}
                    {notice && (
                        <div role="status" className="alert success">
                            <CheckCircle2 size={18} />
                            {notice}
                        </div>
                    )}
                    {inv.error && (
                        <div className="alert warning">
                            <AlertTriangle size={18} />
                            <div>
                                <strong>נתוני Ubuntu אינם זמינים</strong>
                                <p>{inv.error}</p>
                            </div>
                        </div>
                    )}
                    {tx && (
                        <div className="alert warning">
                            <AlertTriangle />
                            <div>
                                שינוי חומת האש ממתין לאישור. ודאו שחיבור הניהול עדיין עובד. ללא
                                אישור יתבצע שחזור בתוך שתי דקות.
                                <div className="actions">
                                    <button
                                        onClick={() =>
                                            void run(async () => {
                                                await api('/firewall/confirm', 'POST', {
                                                    transaction: tx,
                                                });
                                                setTx('');
                                            })
                                        }
                                    >
                                        אישור שהחיבור תקין
                                    </button>
                                    <button
                                        onClick={() =>
                                            void run(async () => {
                                                await api('/firewall/rollback', 'POST', {
                                                    transaction: tx,
                                                });
                                                setTx('');
                                            })
                                        }
                                    >
                                        שחזור עכשיו
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                    {page === 'dashboard' && (
                        <>
                            <section className="server-strip">
                                <div className="server-emblem">
                                    <Server size={26} />
                                </div>
                                <div>
                                    <strong>{metrics.hostname || 'ממתין לנתוני שרת'}</strong>
                                    <p>
                                        <span className="mono">{metrics.platform || '—'}</span> ·
                                        נתונים ישירות ממערכת ההפעלה
                                    </p>
                                </div>
                                <div className="strip-time">
                                    <span>זמן פעילות</span>
                                    <strong>
                                        {metrics.uptime
                                            ? `${Math.floor(metrics.uptime / 86400)} ימים, ${Math.floor((metrics.uptime % 86400) / 3600)} שעות`
                                            : '—'}
                                    </strong>
                                </div>
                                <Badge
                                    value={inv.error ? 'unknown' : 'active'}
                                    label={inv.error ? 'ניטור מערכת לא זמין' : 'ניטור מחובר'}
                                />
                            </section>
                            <section className="stats">
                                <Metric
                                    title="ניצול מעבד"
                                    value={
                                        metrics.cpu == null
                                            ? 'ממתין לדגימה'
                                            : metrics.cpu.toFixed(1) + '%'
                                    }
                                    amount={metrics.cpu}
                                    icon={<Activity size={18} />}
                                    subtitle="CPU · דגימה בזמן אמת"
                                    color="purple"
                                />
                                <Metric
                                    title="זיכרון בשימוש"
                                    value={metrics.memory ? bytes(metrics.memory.used) : '—'}
                                    amount={
                                        metrics.memory
                                            ? (100 * metrics.memory.used) / metrics.memory.total
                                            : null
                                    }
                                    subtitle={
                                        metrics.memory
                                            ? 'מתוך ' + bytes(metrics.memory.total)
                                            : 'RAM'
                                    }
                                    icon={<Server size={18} />}
                                    color="blue"
                                />
                                <Metric
                                    title="אחסון בשימוש"
                                    value={metrics.disk ? bytes(metrics.disk.used) : 'לא זמין'}
                                    amount={
                                        metrics.disk
                                            ? (100 * metrics.disk.used) / metrics.disk.total
                                            : null
                                    }
                                    subtitle={
                                        metrics.disk
                                            ? bytes(metrics.disk.free) + ' פנויים'
                                            : 'דורש נתוני Linux'
                                    }
                                    icon={<Folder size={18} />}
                                    color="orange"
                                />
                                <Metric
                                    title="שירותים פעילים"
                                    value={
                                        inv.unitCounts ? String(inv.unitCounts.active) : 'לא זמין'
                                    }
                                    subtitle={
                                        inv.unitCounts
                                            ? `${inv.unitCounts.inactive} כבויים · ${inv.unitCounts.failed} נכשלו`
                                            : 'ממתין לחיבור systemd'
                                    }
                                    icon={<ShieldCheck size={18} />}
                                    color="green"
                                />
                            </section>
                            <div className="dashboard-grid">
                                <section className="panel">
                                    <div className="panel-heading">
                                        <h2>שירותים מנוהלים</h2>
                                        <button
                                            className="text-btn"
                                            onClick={() => setPage('ports')}
                                        >
                                            לכל הפורטים <ChevronLeft size={14} />
                                        </button>
                                    </div>
                                    {(inv.services || []).length ? (
                                        (inv.services || []).slice(0, 6).map((s: Any) => (
                                            <div className="service-row" key={s.id}>
                                                <div className="service-icon">
                                                    <Terminal size={19} />
                                                </div>
                                                <div className="grow">
                                                    <strong className="mono">{s.name}</strong>
                                                    <small>{s.kind}</small>
                                                </div>
                                                <Badge value={s.status} />
                                                {btnService(s.id)}
                                            </div>
                                        ))
                                    ) : (
                                        <Empty
                                            icon={<Terminal />}
                                            text={
                                                inv.error
                                                    ? 'מידע השירותים אינו זמין'
                                                    : 'אין שירותים ברשימת ההרשאות'
                                            }
                                            detail="הוסיפו שירותים לקובץ helper.json בשרת כדי לאפשר ניהול."
                                        />
                                    )}
                                </section>
                                <section className="panel">
                                    <div className="panel-heading">
                                        <h2>תעבורת רשת</h2>
                                        <span className="live-dot">LIVE</span>
                                    </div>
                                    <div className="network-stat">
                                        <span className="circle green">
                                            <ArrowDown size={19} />
                                        </span>
                                        <div>
                                            <small>תעבורה נכנסת</small>
                                            <strong dir="ltr">
                                                {rate(metrics.network?.rxRate)}
                                            </strong>
                                        </div>
                                    </div>
                                    <div className="network-stat">
                                        <span className="circle blue">
                                            <ArrowUp size={19} />
                                        </span>
                                        <div>
                                            <small>תעבורה יוצאת</small>
                                            <strong dir="ltr">
                                                {rate(metrics.network?.txRate)}
                                            </strong>
                                        </div>
                                    </div>
                                    <div className="network-footer">
                                        <Network size={16} />
                                        <span>
                                            {inv.error
                                                ? 'מספר הפורטים אינו זמין'
                                                : `${inv.ports?.length ?? '—'} פורטים מאזינים`}
                                        </span>
                                        <button
                                            className="text-btn"
                                            onClick={() => setPage('ports')}
                                        >
                                            לניהול <ChevronLeft size={13} />
                                        </button>
                                    </div>
                                </section>
                            </div>
                            <section className="panel">
                                <div className="panel-heading">
                                    <h2>מצב המערכת</h2>
                                    <Clock size={16} />
                                </div>
                                {failed.length ? (
                                    failed.map((s: string) => (
                                        <div className="alert error" key={s}>
                                            <AlertTriangle size={16} />
                                            שירות שנכשל: <b className="mono">{s}</b>
                                        </div>
                                    ))
                                ) : (
                                    <div className="system-note">
                                        <ShieldCheck size={23} />
                                        <div>
                                            <strong>
                                                {inv.error
                                                    ? 'ממתין לבדיקת השירותים'
                                                    : 'לא זוהו שירותים שנכשלו'}
                                            </strong>
                                            <p>
                                                {inv.error
                                                    ? 'יש להתקין את שכבת המערכת בשרת Ubuntu.'
                                                    : 'המידע מתעדכן מחיבור המערכת בזמן אמת.'}
                                            </p>
                                        </div>
                                    </div>
                                )}
                                {metrics.memory &&
                                    (100 * metrics.memory.used) / metrics.memory.total >
                                        (settings?.preferences?.memoryAlert || 90) && (
                                        <div className="alert warning">
                                            ניצול הזיכרון גבוה מהסף שהוגדר
                                        </div>
                                    )}
                                {metrics.disk &&
                                    (100 * metrics.disk.used) / metrics.disk.total >
                                        (settings?.preferences?.diskAlert || 90) && (
                                        <div className="alert warning">
                                            ניצול הדיסק גבוה מהסף שהוגדר
                                        </div>
                                    )}
                            </section>
                        </>
                    )}
                    {page === 'ports' && (
                        <>
                            <div className="toolbar">
                                <label className="search">
                                    <Search size={17} />
                                    <input
                                        placeholder="חיפוש פורט, שירות או כתובת…"
                                        value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                    />
                                </label>
                                <select
                                    aria-label="סינון סטטוס"
                                    value={filter}
                                    onChange={(e) => setFilter(e.target.value)}
                                >
                                    <option value="all">כל הסטטוסים</option>
                                    {['active', 'inactive', 'failed', 'unmanaged'].map((s) => (
                                        <option value={s} key={s}>
                                            {statusLabel[s]}
                                        </option>
                                    ))}
                                </select>
                                <select
                                    aria-label="מיון"
                                    value={sort}
                                    onChange={(e) => setSort(e.target.value)}
                                >
                                    <option value="port">מיון לפי פורט</option>
                                    <option value="process">מיון לפי שירות</option>
                                    <option value="status">מיון לפי סטטוס</option>
                                </select>
                                <button
                                    className="secondary"
                                    onClick={() =>
                                        void run(
                                            async () => setFirewall(await api('/firewall')),
                                            ''
                                        )
                                    }
                                >
                                    שכבות חומת אש
                                </button>
                            </div>
                            <section className="panel table-panel">
                                <div className="panel-heading">
                                    <h2>
                                        פורטים מאזינים <span className="count">{ports.length}</span>
                                    </h2>
                                    <span className="muted">TCP / UDP</span>
                                </div>
                                <div className="table-scroll">
                                    <table>
                                        <thead>
                                            <tr>
                                                {[
                                                    'פורט',
                                                    'תהליך / שירות',
                                                    'כתובת האזנה',
                                                    'גישה ציבורית',
                                                    'סטטוס',
                                                    'PID',
                                                    'פרויקט / GitHub',
                                                    'פעולות',
                                                ].map((x) => (
                                                    <th key={x}>{x}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {ports.map((p: Any, i: number) => {
                                                const project = projects.find(
                                                    (pr) => pr.service === p.service
                                                );
                                                return (
                                                    <tr key={`${p.port}-${p.address}-${i}`}>
                                                        <td>
                                                            <strong className="port-num">
                                                                {p.port}
                                                            </strong>
                                                            <small>
                                                                {p.protocol.toUpperCase()}
                                                            </small>
                                                        </td>
                                                        <td>
                                                            <strong className="mono">
                                                                {p.process || 'לא זוהה'}
                                                            </strong>
                                                            <small>
                                                                {p.service || 'לא מורשה לניהול'}
                                                            </small>
                                                        </td>
                                                        <td className="mono">{p.address}</td>
                                                        <td>
                                                            <button
                                                                className="exposure"
                                                                onClick={() => firewallModal(p)}
                                                            >
                                                                <Lock size={12} />
                                                                {exposureLabel[p.exposure] ||
                                                                    'לא ידוע'}
                                                            </button>
                                                        </td>
                                                        <td>
                                                            <Badge value={p.status} />
                                                        </td>
                                                        <td className="mono">{p.pid || '—'}</td>
                                                        <td>
                                                            {project ? (
                                                                <>
                                                                    <button
                                                                        className="text-btn"
                                                                        onClick={() => {
                                                                            setFileProject(project);
                                                                            setFilePath('');
                                                                            setEditing('');
                                                                            setPage('files');
                                                                        }}
                                                                    >
                                                                        <Folder size={13} />
                                                                        {project.name}
                                                                    </button>
                                                                    {project.repo && (
                                                                        <a
                                                                            href={githubUrl(
                                                                                project.repo
                                                                            )}
                                                                            target="_blank"
                                                                            rel="noreferrer"
                                                                        >
                                                                            GitHub ↗
                                                                        </a>
                                                                    )}
                                                                </>
                                                            ) : (
                                                                <span className="muted mono">
                                                                    {p.directory || 'לא זוהה'}
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td>
                                                            {p.service ? (
                                                                btnService(p.service)
                                                            ) : (
                                                                <span className="muted">
                                                                    לא מנוהל
                                                                </span>
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                                {!ports.length && (
                                    <Empty
                                        icon={<Network />}
                                        text="אין פורטים להצגה"
                                        detail={
                                            inv.error
                                                ? 'נדרש חיבור ל־helper בשרת Ubuntu.'
                                                : 'שנו את החיפוש או רעננו את נתוני המערכת.'
                                        }
                                    />
                                )}
                            </section>
                            <div className="hint">
                                <ShieldCheck size={16} /> סטטוס חשיפה ״לא ידוע״ מציין שנגישות
                                חיצונית לא אומתה. כללי Firewall בלבד אינם מספיקים לקביעת נגישות.
                            </div>
                            {firewall && (
                                <section className="panel">
                                    <div className="panel-heading">
                                        <h2>שכבות חומת אש</h2>
                                        <button
                                            onClick={() => setFirewall(null)}
                                            aria-label="סגירה"
                                        >
                                            <X size={16} />
                                        </button>
                                    </div>
                                    <pre className="code">{firewall.ufw}</pre>
                                    <p className="muted">
                                        {firewall.cloud
                                            ? `Hetzner: ${firewall.cloud.name} · ${firewall.cloud.rules.length} כללים`
                                            : 'Hetzner API לא הוגדר ב־helper.'}
                                    </p>
                                </section>
                            )}
                        </>
                    )}
                    {page === 'projects' && (
                        <>
                            <SummaryStrip
                                items={[
                                    {
                                        label: 'פרויקטים פעילים',
                                        value: projects.length,
                                        icon: <FolderGit2 size={20} />,
                                    },
                                    {
                                        label: 'שירותים פועלים',
                                        value: inv.error
                                            ? '—'
                                            : projects.filter((p) => projectStatus(p) === 'active')
                                                  .length,
                                        icon: <Play size={20} />,
                                    },
                                    {
                                        label: 'פעולות בתהליך',
                                        value: activeJobs.filter((j) =>
                                            j.resource.startsWith('project:')
                                        ).length,
                                        icon: <Activity size={20} />,
                                    },
                                ]}
                            />
                            <div className="toolbar">
                                <label className="search">
                                    <Search size={17} />
                                    <input
                                        value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                        placeholder="חיפוש פרויקטים…"
                                    />
                                </label>
                                <button className="primary" onClick={projectModal}>
                                    <Plus size={17} />
                                    הוספת פרויקט
                                </button>
                                <button
                                    className="secondary"
                                    onClick={() =>
                                        setModal(
                                            <Info
                                                title="ייבוא מ־GitHub"
                                                onClose={() => setModal(null)}
                                            >
                                                <GitHubImport
                                                    services={inv.services || []}
                                                    api={api}
                                                    projects={projects}
                                                    onDone={() => {
                                                        setModal(null);
                                                        setNotice(
                                                            'הייבוא נוסף לתור ויתבצע ברקע. אפשר להמשיך לעבוד כאן.'
                                                        );
                                                        void refresh();
                                                    }}
                                                />
                                            </Info>
                                        )
                                    }
                                >
                                    <GitBranch size={17} />
                                    ייבוא מ־GitHub
                                </button>
                            </div>
                            <div className="collection-heading">
                                <ContentTabs
                                    label="תצוגת פרויקטים"
                                    value={showArchived ? 'archived' : 'active'}
                                    onChange={(value) => setShowArchived(value === 'archived')}
                                    items={[
                                        {
                                            id: 'active',
                                            label: 'פרויקטים פעילים',
                                            count: projects.length,
                                        },
                                        {
                                            id: 'archived',
                                            label: 'ארכיון',
                                            count: archivedProjects.length,
                                        },
                                    ]}
                                />
                                {!showArchived && (
                                    <label className="inline-filter">
                                        מצב פרויקט
                                        <select
                                            aria-label="סינון פרויקטים"
                                            value={projectFilter}
                                            onChange={(e) => setProjectFilter(e.target.value)}
                                        >
                                            <option value="all">כל המצבים</option>
                                            <option value="running">פועלים</option>
                                            <option value="stopped">כבויים</option>
                                            <option value="attention">דורשים טיפול</option>
                                        </select>
                                    </label>
                                )}
                            </div>
                            <div className="project-grid">
                                {visibleProjects.map((p) => (
                                    <section className="panel project-card" key={p.id}>
                                        <div className="project-top">
                                            <div className="project-identity">
                                                <div className="project-icon">
                                                    <FolderGit2 size={23} />
                                                </div>
                                                <div>
                                                    <h2>{p.name}</h2>
                                                    <small>
                                                        {p.runtime
                                                            ? 'סביבת הפעלה מנוהלת'
                                                            : 'מוכן להגדרת הפעלה'}
                                                    </small>
                                                </div>
                                            </div>
                                            <div className="project-process-status">
                                                <small>תהליך</small>
                                                <Badge
                                                    value={projectStatus(p)}
                                                    label={
                                                        p.lifecycle === 'archived'
                                                            ? 'בארכיון'
                                                            : projectStatus(p) === 'unconfigured'
                                                              ? 'לא מוגדר'
                                                              : projectStatus(p) === 'active'
                                                                ? 'פועל'
                                                                : projectStatus(p) === 'failed'
                                                                  ? 'נכשל'
                                                                  : [
                                                                          'inactive',
                                                                          'stopped',
                                                                      ].includes(projectStatus(p))
                                                                    ? 'כבוי'
                                                                    : undefined
                                                    }
                                                />
                                            </div>
                                        </div>
                                        {jobs
                                            .filter((j) => j.resource === 'project:' + p.id)
                                            .slice(0, 1)
                                            .filter((j) =>
                                                [
                                                    'queued',
                                                    'running',
                                                    'failed',
                                                    'interrupted',
                                                ].includes(j.status)
                                            )
                                            .map((j) => (
                                                <button
                                                    className="project-job-status"
                                                    data-state={j.status}
                                                    key={j.id}
                                                    onClick={() => {
                                                        setSelectedJob(j.id);
                                                        setJobPanel(true);
                                                    }}
                                                >
                                                    {j.action === 'network-project'
                                                        ? 'פרסום'
                                                        : 'פעולה'}
                                                    : {stageLabel(j.status)} · {stageLabel(j.stage)}
                                                </button>
                                            ))}
                                        <p
                                            className="mono muted project-path"
                                            dir="ltr"
                                            title={p.root}
                                        >
                                            {p.root}
                                        </p>
                                        {p.repo ? (
                                            <a
                                                href={githubUrl(p.repo)}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="repo-link mono"
                                                dir="ltr"
                                            >
                                                {p.repo} ↗
                                            </a>
                                        ) : (
                                            <small className="muted">אין מאגר GitHub</small>
                                        )}
                                        <ProjectActions
                                            project={p}
                                            serviceState={projectStatus(p)}
                                            api={api}
                                            refresh={refresh}
                                            onQueued={() =>
                                                setNotice(
                                                    'הפעולה נוספה לתור ותתבצע ברקע. אפשר להמשיך לעבוד כאן.'
                                                )
                                            }
                                            serverAddresses={serverAddresses}
                                            managementHosts={managementHosts}
                                            publicationStatusKnown={publicationStatusKnown}
                                            publication={publications[p.id]}
                                            jobs={jobs}
                                            console={openProjectConsole}
                                            totpEnabled={!!user.totpEnabled}
                                            onFiles={() => {
                                                setFileProject(p);
                                                setFilePath('');
                                                setEditing('');
                                                setPage('files');
                                            }}
                                            onEnvironment={() => envModal(p)}
                                        >
                                            {p.lifecycle !== 'archived' && (
                                                <>
                                                    <div className="project-meta">
                                                        <span>
                                                            <GitBranch size={14} />
                                                            {p.branch}
                                                        </span>
                                                        <span>{p.kind.toUpperCase()}</span>
                                                        <span>פורט {p.health_port || '—'}</span>
                                                    </div>
                                                    {p.service &&
                                                        !p.runtime &&
                                                        btnService(p.service)}
                                                    <details className="project-source-details">
                                                        <summary>מאגר, סנכרון וגרסאות</summary>
                                                        <div className="project-controls">
                                                            {!p.runtime && (
                                                                <button
                                                                    className="secondary"
                                                                    disabled={
                                                                        pending ||
                                                                        !!p.runtime ||
                                                                        !p.service ||
                                                                        !p.health_port
                                                                    }
                                                                    title={
                                                                        !p.service
                                                                            ? 'נדרש שיוך שירות לצורך פריסה; ניהול הקבצים זמין כבר עכשיו'
                                                                            : undefined
                                                                    }
                                                                    onClick={() => deploy(p)}
                                                                >
                                                                    <RefreshCw size={14} />
                                                                    סנכרון GitHub
                                                                </button>
                                                            )}

                                                            <button
                                                                className="text-btn"
                                                                disabled={!p.repo}
                                                                onClick={() =>
                                                                    setModal(
                                                                        <Confirm
                                                                            title="התקנת מאגר"
                                                                            text="ישוכפל המאגר שנבחר בפרויקט לתיקייה ריקה בלבד. לשימוש במאגר פרטי יש להגדיר Deploy Key אצל משתמש הפרויקטים."
                                                                            onClose={() =>
                                                                                setModal(null)
                                                                            }
                                                                            onConfirm={() => {
                                                                                setModal(null);
                                                                                void run(() =>
                                                                                    api(
                                                                                        `/projects/${p.id}/clone`,
                                                                                        'POST',
                                                                                        {
                                                                                            confirmed: true,
                                                                                        }
                                                                                    )
                                                                                );
                                                                            }}
                                                                        />
                                                                    )
                                                                }
                                                            >
                                                                התקנה ממאגר
                                                            </button>
                                                        </div>
                                                        <div className="project-controls">
                                                            <button
                                                                className="text-btn"
                                                                disabled={pending || !p.repo}
                                                                onClick={() =>
                                                                    setModal(
                                                                        <Confirm
                                                                            title="משיכת קוד בלבד"
                                                                            text="הקוד המקומי יעודכן רק אם ניתן לבצע fast-forward וללא שינויים מקומיים. תישמר הפניה לגרסה הקודמת. השירות הפעיל, הבנייה והנתונים לא ישתנו."
                                                                            onClose={() =>
                                                                                setModal(null)
                                                                            }
                                                                            onConfirm={() => {
                                                                                setModal(null);
                                                                                void run(() =>
                                                                                    api(
                                                                                        `/projects/${p.id}/pull`,
                                                                                        'POST',
                                                                                        {
                                                                                            confirmed: true,
                                                                                        }
                                                                                    )
                                                                                );
                                                                            }}
                                                                        />
                                                                    )
                                                                }
                                                            >
                                                                משיכת קוד בלבד
                                                            </button>
                                                            <button
                                                                className="text-btn"
                                                                onClick={() =>
                                                                    void run(async () => {
                                                                        const s = await api(
                                                                            `/projects/${p.id}/git`
                                                                        );
                                                                        setModal(
                                                                            <Info
                                                                                title="מצב Git"
                                                                                onClose={() =>
                                                                                    setModal(null)
                                                                                }
                                                                            >
                                                                                <pre className="code">
                                                                                    {JSON.stringify(
                                                                                        s,
                                                                                        null,
                                                                                        2
                                                                                    )}
                                                                                </pre>
                                                                                <p>
                                                                                    מצב העדכונים
                                                                                    המרוחקים נבדק
                                                                                    בעת סקירת
                                                                                    סנכרון.
                                                                                </p>
                                                                            </Info>
                                                                        );
                                                                    }, '')
                                                                }
                                                            >
                                                                מצב Git
                                                            </button>
                                                            {p.service && !p.runtime && (
                                                                <>
                                                                    <button
                                                                        className="text-btn"
                                                                        onClick={() =>
                                                                            serviceAction(
                                                                                p.service,
                                                                                'enable'
                                                                            )
                                                                        }
                                                                    >
                                                                        הפעלה באתחול
                                                                    </button>
                                                                    <button
                                                                        className="text-btn"
                                                                        onClick={() =>
                                                                            serviceAction(
                                                                                p.service,
                                                                                'disable'
                                                                            )
                                                                        }
                                                                    >
                                                                        ביטול באתחול
                                                                    </button>
                                                                </>
                                                            )}
                                                        </div>
                                                        <div className="project-controls">
                                                            <button
                                                                className="text-btn"
                                                                onClick={() =>
                                                                    setModal(
                                                                        <Info
                                                                            title="QR לחיבור WhatsApp"
                                                                            onClose={() =>
                                                                                setModal(null)
                                                                            }
                                                                        >
                                                                            <QrView
                                                                                project={p.id}
                                                                            />
                                                                        </Info>
                                                                    )
                                                                }
                                                            >
                                                                QR לחיבור WhatsApp
                                                            </button>
                                                            <button
                                                                className="text-btn"
                                                                onClick={() =>
                                                                    void run(async () => {
                                                                        const releases = await api(
                                                                            `/projects/${p.id}/releases`
                                                                        );
                                                                        setModal(
                                                                            <Info
                                                                                title="גרסאות ושחזור"
                                                                                onClose={() =>
                                                                                    setModal(null)
                                                                                }
                                                                            >
                                                                                {releases.length ? (
                                                                                    releases.map(
                                                                                        (
                                                                                            r: Any
                                                                                        ) => (
                                                                                            <div
                                                                                                className="setting-row"
                                                                                                key={
                                                                                                    r.release
                                                                                                }
                                                                                            >
                                                                                                <span className="mono">
                                                                                                    {
                                                                                                        r.release
                                                                                                    }
                                                                                                </span>
                                                                                                <button
                                                                                                    className="secondary"
                                                                                                    disabled={
                                                                                                        !r.rollbackAvailable
                                                                                                    }
                                                                                                    onClick={() =>
                                                                                                        setModal(
                                                                                                            <Confirm
                                                                                                                title="שחזור גרסה"
                                                                                                                text="השירות יופעל מחדש עם הגרסה שקדמה לגרסה שנבחרה. מסד הנתונים של הפרויקט אינו משוחזר אוטומטית."
                                                                                                                onClose={() =>
                                                                                                                    setModal(
                                                                                                                        null
                                                                                                                    )
                                                                                                                }
                                                                                                                onConfirm={() => {
                                                                                                                    setModal(
                                                                                                                        null
                                                                                                                    );
                                                                                                                    void run(
                                                                                                                        () =>
                                                                                                                            api(
                                                                                                                                `/projects/${p.id}/rollback`,
                                                                                                                                'POST',
                                                                                                                                {
                                                                                                                                    release:
                                                                                                                                        r.release,
                                                                                                                                    confirmed: true,
                                                                                                                                }
                                                                                                                            )
                                                                                                                    );
                                                                                                                }}
                                                                                                            />
                                                                                                        )
                                                                                                    }
                                                                                                >
                                                                                                    שחזור
                                                                                                    לקודמת
                                                                                                </button>
                                                                                            </div>
                                                                                        )
                                                                                    )
                                                                                ) : (
                                                                                    <p>
                                                                                        אין גרסאות
                                                                                        שמורות.
                                                                                    </p>
                                                                                )}
                                                                            </Info>
                                                                        );
                                                                    }, '')
                                                                }
                                                            >
                                                                גרסאות ושחזור
                                                            </button>
                                                        </div>
                                                    </details>
                                                </>
                                            )}
                                            <small className="muted">
                                                סנכרון אחרון: {p.last_sync || 'טרם בוצע'}
                                            </small>
                                        </ProjectActions>
                                    </section>
                                ))}
                            </div>
                            {visibleProjects.length === 0 &&
                                (showArchived ? archivedProjects : projects).length > 0 && (
                                    <section className="panel">
                                        <Empty
                                            icon={<Search />}
                                            text="לא נמצאו פרויקטים מתאימים"
                                            detail="נסו חיפוש אחר או הציגו את כל המצבים."
                                        />
                                    </section>
                                )}
                            {!(showArchived ? archivedProjects : projects).length && (
                                <section className="panel">
                                    <Empty
                                        icon={<FolderGit2 />}
                                        text={
                                            showArchived
                                                ? 'אין פרויקטים בארכיון'
                                                : 'הפרויקט הראשון שלך מתחיל כאן'
                                        }
                                        detail={
                                            showArchived
                                                ? 'פרויקטים שהועברו לארכיון יופיעו כאן לשחזור.'
                                                : 'צרו תיקייה לפרויקט ישירות מהאתר והתחילו להעלות ולערוך קבצים. אפשר להוסיף כמה פרויקטים ללא עריכת תצורה.'
                                        }
                                    />
                                    <button className="primary centered" onClick={projectModal}>
                                        <Plus size={16} />
                                        הוספת פרויקט
                                    </button>
                                </section>
                            )}
                        </>
                    )}
                    {envProject && (
                        <ProjectEnvironment
                            project={envProject}
                            api={api}
                            totpEnabled={!!user.totpEnabled}
                            close={() => setEnvProject(null)}
                        />
                    )}
                    {page === 'project-console' && projectConsole && (
                        <ProjectConsole
                            project={projectConsole}
                            api={api}
                            subscribe={subscribeProject}
                            unsubscribe={unsubscribeProject}
                            records={projectLogs}
                            error={projectLogError}
                            gap={projectLogGap}
                            connected={connected}
                            jobs={jobs}
                        />
                    )}
                    {page === 'console' && (
                        <section className="panel">
                            <div className="panel-heading">
                                <h2>
                                    <Terminal size={18} /> {consoleService}
                                </h2>
                                <Badge value="active" label="צפייה בלבד" />
                            </div>
                            <div className="toolbar">
                                <label className="search">
                                    <Search size={16} />
                                    <input
                                        value={logSearch}
                                        onChange={(e) => setLogSearch(e.target.value)}
                                        placeholder="חיפוש בלוגים…"
                                    />
                                </label>
                                <button className="secondary" onClick={() => setPaused(!paused)}>
                                    {paused ? 'חידוש גלילה' : 'עצירת גלילה'}
                                </button>
                                <button className="secondary" onClick={() => setLogs('')}>
                                    ניקוי תצוגה
                                </button>
                                <a
                                    className="button secondary"
                                    href={'/api/logs/' + consoleService + '/download'}
                                >
                                    <Download size={15} />
                                    הורדת לוגים
                                </a>
                            </div>
                            <pre className="console" ref={logBox} aria-live="off">
                                {logs
                                    ? logs
                                          .split('\n')
                                          .filter((line) =>
                                              line.toLowerCase().includes(logSearch.toLowerCase())
                                          )
                                          .map((line, i) => (
                                              <div
                                                  key={i}
                                                  className={
                                                      /error|fail|exception/i.test(line)
                                                          ? 'log-error'
                                                          : /warn/i.test(line)
                                                            ? 'log-warning'
                                                            : ''
                                                  }
                                              >
                                                  {line || ' '}
                                              </div>
                                          ))
                                    : 'ממתין ללוגים…'}
                            </pre>
                            <div className="hint">
                                <Lock size={14} /> הלוגים עוברים הסתרת תבניות מידע רגיש. אין אפשרות
                                להזין פקודות.
                            </div>
                        </section>
                    )}
                    {page === 'files' && fileProject && (
                        <section className="panel">
                            <ProjectActions
                                project={
                                    projects.find((p) => p.id === fileProject.id) || fileProject
                                }
                                serviceState={projectStatus(
                                    projects.find((p) => p.id === fileProject.id) || fileProject
                                )}
                                api={api}
                                refresh={refresh}
                                onQueued={() =>
                                    setNotice(
                                        'הפעולה נוספה לתור ותתבצע ברקע. אפשר להמשיך לעבוד כאן.'
                                    )
                                }
                                serverAddresses={serverAddresses}
                                managementHosts={managementHosts}
                                publicationStatusKnown={publicationStatusKnown}
                                publication={publications[fileProject.id]}
                                jobs={jobs}
                                console={openProjectConsole}
                                totpEnabled={!!user.totpEnabled}
                            />
                            <div className="panel-heading">
                                <h2>
                                    <Folder size={18} />
                                    {fileProject.name}
                                </h2>
                                <span className="mono">/{filePath}</span>
                            </div>
                            <div className="toolbar">
                                <button
                                    className="secondary"
                                    disabled={!filePath}
                                    onClick={() => {
                                        setFilePath(filePath.split('/').slice(0, -1).join('/'));
                                        setEditing('');
                                    }}
                                >
                                    תיקייה קודמת
                                </button>
                                <button
                                    className="secondary"
                                    onClick={() =>
                                        setModal(
                                            <Form
                                                title="יצירת תיקייה"
                                                fields={[{ key: 'name', label: 'שם התיקייה' }]}
                                                onClose={() => setModal(null)}
                                                submit={async (v: Any) => {
                                                    await api(
                                                        `/projects/${fileProject.id}/directory`,
                                                        'POST',
                                                        {
                                                            path: [filePath, v.name]
                                                                .filter(Boolean)
                                                                .join('/'),
                                                        }
                                                    );
                                                    setEntries(
                                                        await api(
                                                            `/projects/${fileProject.id}/files?path=${encodeURIComponent(filePath)}`
                                                        )
                                                    );
                                                    setModal(null);
                                                }}
                                            />
                                        )
                                    }
                                >
                                    <Plus size={15} />
                                    תיקייה חדשה
                                </button>
                                <button
                                    className="secondary"
                                    onClick={() =>
                                        setModal(
                                            <Form
                                                title="יצירת קובץ טקסט"
                                                fields={[{ key: 'name', label: 'שם הקובץ' }]}
                                                onClose={() => setModal(null)}
                                                submit={async (v: Any) => {
                                                    const relative = [filePath, v.name]
                                                        .filter(Boolean)
                                                        .join('/');
                                                    await api(
                                                        `/projects/${fileProject.id}/file`,
                                                        'POST',
                                                        { path: relative, content: '' }
                                                    );
                                                    setEditing(relative);
                                                    setContent('');
                                                    setEntries(
                                                        await api(
                                                            `/projects/${fileProject.id}/files?path=${encodeURIComponent(filePath)}`
                                                        )
                                                    );
                                                    setModal(null);
                                                }}
                                            />
                                        )
                                    }
                                >
                                    <FileText size={15} />
                                    קובץ חדש
                                </button>
                                <label className="button secondary">
                                    <Upload size={15} />
                                    העלאת קובץ טקסט
                                    <input
                                        type="file"
                                        hidden
                                        onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            if (!file) return;
                                            if (file.size > 1024 * 1024) {
                                                setError('הקובץ גדול מ־1 MB');
                                                return;
                                            }
                                            setModal(
                                                <Confirm
                                                    title="אישור העלאה"
                                                    text={`העלאת ${file.name}. קובץ קיים באותו שם יוחלף.`}
                                                    onClose={() => setModal(null)}
                                                    onConfirm={() => {
                                                        setModal(null);
                                                        void run(async () => {
                                                            await api(
                                                                `/projects/${fileProject.id}/file`,
                                                                'POST',
                                                                {
                                                                    path: [filePath, file.name]
                                                                        .filter(Boolean)
                                                                        .join('/'),
                                                                    content: await file.text(),
                                                                }
                                                            );
                                                            setEntries(
                                                                await api(
                                                                    `/projects/${fileProject.id}/files?path=${encodeURIComponent(filePath)}`
                                                                )
                                                            );
                                                        });
                                                    }}
                                                />
                                            );
                                            e.target.value = '';
                                        }}
                                    />
                                </label>
                            </div>
                            <div className="file-layout">
                                <div className="file-list">
                                    {entries.map((f) => (
                                        <div key={f.name}>
                                            <button
                                                onClick={() => {
                                                    const next = [filePath, f.name]
                                                        .filter(Boolean)
                                                        .join('/');
                                                    if (f.directory) {
                                                        setFilePath(next);
                                                        setEditing('');
                                                    } else
                                                        void run(async () => {
                                                            const data = await api(
                                                                `/projects/${fileProject.id}/file?path=${encodeURIComponent(next)}`
                                                            );
                                                            setEditing(next);
                                                            setContent(data.content);
                                                        }, '');
                                                }}
                                            >
                                                {f.directory ? (
                                                    <Folder size={17} />
                                                ) : (
                                                    <FileText size={17} />
                                                )}
                                                <span className="mono">{f.name}</span>
                                            </button>
                                            <button
                                                title="מחיקה"
                                                aria-label={'מחיקת ' + f.name}
                                                onClick={() =>
                                                    setModal(
                                                        <Confirm
                                                            title="מחיקת קובץ או תיקייה"
                                                            text={`למחוק את ${f.name}? ניתן למחוק רק תיקייה ריקה. אין אפשרות לבטל פעולה זו.`}
                                                            onClose={() => setModal(null)}
                                                            onConfirm={() => {
                                                                setModal(null);
                                                                void run(async () => {
                                                                    await api(
                                                                        `/projects/${fileProject.id}/file`,
                                                                        'DELETE',
                                                                        {
                                                                            path: [filePath, f.name]
                                                                                .filter(Boolean)
                                                                                .join('/'),
                                                                            confirmed: true,
                                                                        }
                                                                    );
                                                                    setEditing('');
                                                                    setEntries(
                                                                        await api(
                                                                            `/projects/${fileProject.id}/files?path=${encodeURIComponent(filePath)}`
                                                                        )
                                                                    );
                                                                });
                                                            }}
                                                        />
                                                    )
                                                }
                                            >
                                                <Trash2 size={13} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                                <div className="editor">
                                    {editing ? (
                                        <>
                                            <div className="toolbar">
                                                <span className="mono grow">{editing}</span>
                                                <a
                                                    href={`/api/projects/${fileProject.id}/download?path=${encodeURIComponent(editing)}`}
                                                    className="button secondary"
                                                >
                                                    <Download size={14} />
                                                    הורדה
                                                </a>
                                                <button
                                                    className="primary"
                                                    disabled={pending}
                                                    onClick={() =>
                                                        void run(() =>
                                                            api(
                                                                `/projects/${fileProject.id}/file`,
                                                                'POST',
                                                                { path: editing, content }
                                                            )
                                                        )
                                                    }
                                                >
                                                    <Save size={14} />
                                                    שמירה
                                                </button>
                                            </div>
                                            <textarea
                                                aria-label="עריכת תוכן הקובץ"
                                                spellCheck={false}
                                                value={content}
                                                onChange={(e) => setContent(e.target.value)}
                                            />
                                        </>
                                    ) : (
                                        <Empty
                                            icon={<FileText />}
                                            text="בחרו קובץ לעריכה"
                                            detail="קובצי טקסט עד 1 MB. קבצים רגישים, קישורים סמליים ונתוני התחברות חסומים."
                                        />
                                    )}
                                </div>
                            </div>
                        </section>
                    )}
                    {page === 'jobs' && (
                        <section className="panel jobs-page">
                            <div className="panel-heading">
                                <h2>תור משימות</h2>
                                <span className="muted">שלבים ופלט מתעדכנים במהלך הפעולה</span>
                            </div>
                            <ContentTabs
                                label="סינון משימות"
                                value={jobFilter}
                                onChange={setJobFilter}
                                items={[
                                    { id: 'all', label: 'כל המשימות', count: jobs.length },
                                    { id: 'active', label: 'בתהליך', count: activeJobs.length },
                                    {
                                        id: 'failed',
                                        label: 'דורשות טיפול',
                                        count: jobs.filter((j) =>
                                            ['failed', 'interrupted'].includes(j.status)
                                        ).length,
                                    },
                                    {
                                        id: 'done',
                                        label: 'הושלמו',
                                        count: jobs.filter((j) => j.status === 'done').length,
                                    },
                                ]}
                            />
                            {visibleJobs.length ? (
                                visibleJobs.map((j) => <JobCard key={j.id} job={j} />)
                            ) : (
                                <Empty
                                    icon={<Activity />}
                                    text={
                                        jobs.length ? 'אין משימות בסינון שנבחר' : 'אין משימות בתור'
                                    }
                                    detail="פעולות שירותים ופריסות יופיעו כאן עם התוצאה שלהן."
                                />
                            )}
                        </section>
                    )}
                    {page === 'settings' && (
                        <>
                            <ContentTabs
                                label="נושאי הגדרות"
                                value={settingsCategory}
                                onChange={setSettingsCategory}
                                items={[
                                    { id: 'security', label: 'חשבון ואבטחה' },
                                    { id: 'network', label: 'גישה ופרסום' },
                                    { id: 'github', label: 'GitHub' },
                                    { id: 'preferences', label: 'תצוגה והתראות' },
                                    { id: 'maintenance', label: 'גיבויים ויומן' },
                                ]}
                            />
                            <p className="section-description">
                                {
                                    (
                                        {
                                            security: 'פרטי החשבון, סיסמה ואימות דו־שלבי.',
                                            network: 'כתובת השרת, HTTPS ופרסום ממשק הניהול.',
                                            github: 'החיבור ל־GitHub והמאגרים הזמינים להתקנה.',
                                            preferences: 'ספי התראה ותדירות רענון.',
                                            maintenance: 'גיבויים מוצפנים והיסטוריית פעולות.',
                                        } as Any
                                    )[settingsCategory]
                                }
                            </p>
                            <div
                                className="settings-grid organized-settings"
                                data-category={settingsCategory}
                            >
                                <div
                                    className="settings-module"
                                    hidden={settingsCategory !== 'github'}
                                >
                                    <GitHubSettings api={api} totpEnabled={!!user.totpEnabled} />
                                </div>
                                <div
                                    className="settings-module"
                                    hidden={settingsCategory !== 'network'}
                                >
                                    <NetworkSettings api={api} totpEnabled={!!user.totpEnabled} />
                                </div>
                                <section className="panel" hidden={settingsCategory !== 'security'}>
                                    <div className="panel-heading">
                                        <h2>
                                            <ShieldCheck size={19} />
                                            התחברות ואבטחה
                                        </h2>
                                    </div>
                                    <div className="setting-row">
                                        <div>
                                            <strong>פרטי מנהל</strong>
                                            <small>{user.username}</small>
                                        </div>
                                        <button className="secondary" onClick={accountModal}>
                                            עדכון פרטים
                                        </button>
                                    </div>
                                    <div className="setting-row">
                                        <div>
                                            <strong>אימות דו־שלבי</strong>
                                            <small>
                                                {user.totpEnabled
                                                    ? 'TOTP מופעל'
                                                    : 'מומלץ להפעיל להגנה נוספת'}
                                            </small>
                                        </div>
                                        <button
                                            className="secondary"
                                            onClick={() =>
                                                actionModal(
                                                    user.totpEnabled
                                                        ? '/totp/disable'
                                                        : '/totp/setup',
                                                    user.totpEnabled
                                                        ? 'ביטול אימות דו־שלבי'
                                                        : 'הגדרת אימות דו־שלבי'
                                                )
                                            }
                                        >
                                            {user.totpEnabled ? 'ביטול' : 'הגדרה'}
                                        </button>
                                    </div>
                                    <p className="hint">
                                        <Lock size={14} /> ניתוק אחרי 15 דקות ללא פעילות. תוקף חיבור
                                        מרבי: 8 שעות.
                                    </p>
                                </section>
                                <section className="panel" hidden={settingsCategory !== 'network'}>
                                    <div className="panel-heading">
                                        <h2>
                                            <Network size={19} />
                                            חיבורים וכתובת ניהול
                                        </h2>
                                    </div>
                                    <dl>
                                        <dt>כתובת מאושרת</dt>
                                        <dd className="mono">{settings?.origin}</dd>
                                        <dt>כתובת האזנה</dt>
                                        <dd className="mono">
                                            {settings?.host}:{settings?.port}
                                        </dd>
                                    </dl>
                                    <p className="muted">
                                        שינוי כתובת ופורט נעשה בקובץ הסביבה של השרת. חיבור Hetzner
                                        ו־Deploy Key ל־GitHub מוגדרים מקומית לפי מדריך ההתקנה, כדי
                                        לשמור על הרשאות מוגבלות.
                                    </p>
                                    <button
                                        className="secondary"
                                        onClick={() =>
                                            void run(async () => {
                                                const f = await api('/firewall');
                                                setModal(
                                                    <Info
                                                        title="חיבור Hetzner ו־UFW"
                                                        onClose={() => setModal(null)}
                                                    >
                                                        <pre className="code">{f.ufw}</pre>
                                                        <p>
                                                            {f.cloud
                                                                ? 'מחובר ל־Hetzner: ' + f.cloud.name
                                                                : 'Hetzner אינו מוגדר בשרת.'}
                                                        </p>
                                                    </Info>
                                                );
                                            }, '')
                                        }
                                    >
                                        בדיקת חיבור חומת אש
                                    </button>
                                </section>
                                <section
                                    className="panel"
                                    hidden={settingsCategory !== 'preferences'}
                                >
                                    <div className="panel-heading">
                                        <h2>
                                            <Settings size={19} />
                                            התראות ותצוגה
                                        </h2>
                                    </div>
                                    {settings && (
                                        <form
                                            onSubmit={(e) => {
                                                e.preventDefault();
                                                void run(() =>
                                                    api('/settings', 'POST', settings.preferences)
                                                );
                                            }}
                                        >
                                            <label>
                                                רענון (שניות)
                                                <input
                                                    type="number"
                                                    min={3}
                                                    max={60}
                                                    value={settings.preferences.refresh}
                                                    onChange={(e) =>
                                                        setSettings({
                                                            ...settings,
                                                            preferences: {
                                                                ...settings.preferences,
                                                                refresh: Number(e.target.value),
                                                            },
                                                        })
                                                    }
                                                />
                                            </label>
                                            <label>
                                                התראה על אחסון (%)
                                                <input
                                                    type="number"
                                                    min={50}
                                                    max={99}
                                                    value={settings.preferences.diskAlert}
                                                    onChange={(e) =>
                                                        setSettings({
                                                            ...settings,
                                                            preferences: {
                                                                ...settings.preferences,
                                                                diskAlert: Number(e.target.value),
                                                            },
                                                        })
                                                    }
                                                />
                                            </label>
                                            <label>
                                                התראה על זיכרון (%)
                                                <input
                                                    type="number"
                                                    min={50}
                                                    max={99}
                                                    value={settings.preferences.memoryAlert}
                                                    onChange={(e) =>
                                                        setSettings({
                                                            ...settings,
                                                            preferences: {
                                                                ...settings.preferences,
                                                                memoryAlert: Number(e.target.value),
                                                            },
                                                        })
                                                    }
                                                />
                                            </label>
                                            <button className="primary" disabled={pending}>
                                                <Save size={15} />
                                                שמירת הגדרות
                                            </button>
                                        </form>
                                    )}
                                </section>
                                <section
                                    className="panel"
                                    hidden={settingsCategory !== 'maintenance'}
                                >
                                    <div className="panel-heading">
                                        <h2>
                                            <Folder size={19} />
                                            גיבויים מוצפנים
                                        </h2>
                                    </div>
                                    <p className="muted">
                                        גיבוי SQLite כולל חשבונות, הגדרות ויומן פעולות. תצורת root
                                        ומפתח ההצפנה מגובים בנפרד לפי INSTALL.md.
                                    </p>
                                    <button
                                        className="secondary"
                                        onClick={() => actionModal('/backups', 'יצירת גיבוי מוצפן')}
                                    >
                                        <Plus size={15} />
                                        יצירת גיבוי
                                    </button>
                                    {backups.map((b) => (
                                        <a
                                            className="backup-link"
                                            key={b}
                                            href={'/api/backups/' + b}
                                        >
                                            <Download size={15} />
                                            <span className="mono">{b.slice(0, 18)}…</span>
                                        </a>
                                    ))}
                                </section>
                            </div>
                            <section className="panel" hidden={settingsCategory !== 'maintenance'}>
                                <div className="panel-heading">
                                    <h2>יומן פעולות מנהל</h2>
                                    <button
                                        className="text-btn"
                                        onClick={() =>
                                            void run(async () => setAudit(await api('/audit')), '')
                                        }
                                    >
                                        רענון יומן
                                    </button>
                                </div>
                                <div className="table-scroll">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>זמן (UTC)</th>
                                                <th>משתמש</th>
                                                <th>פעולה</th>
                                                <th>משאב</th>
                                                <th>תוצאה</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {audit.map((a) => (
                                                <tr key={a.id}>
                                                    <td className="mono">{a.time}</td>
                                                    <td>{a.user}</td>
                                                    <td className="mono">{a.action}</td>
                                                    <td className="mono">{a.target}</td>
                                                    <td>{a.result}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </section>
                        </>
                    )}
                    <footer>
                        <span>Ubuntu Control</span>
                        <span>
                            <ShieldCheck size={12} /> ניהול מקומי · הרשאות מוגבלות
                        </span>
                        <span>
                            {metrics.time
                                ? 'עדכון אחרון: ' +
                                  new Date(metrics.time).toLocaleTimeString('he-IL')
                                : 'ממתין לעדכון'}
                        </span>
                    </footer>
                </div>
            </main>
            {jobPanel && (
                <aside className="jobs-drawer" role="dialog" aria-label="פאנל משימות רקע">
                    <div className="panel-heading">
                        <h2>משימות ברקע</h2>
                        <button aria-label="סגירת פאנל" onClick={() => setJobPanel(false)}>
                            <X size={18} />
                        </button>
                    </div>
                    {jobs.length ? (
                        jobs.map((j) => (
                            <JobCard key={j.id} job={j} selected={j.id === selectedJob} />
                        ))
                    ) : (
                        <p>אין משימות להצגה</p>
                    )}
                </aside>
            )}
            {modal}
            {totpSecret && (
                <Form
                    title="חיבור אפליקציית אימות"
                    description="הוסיפו את המפתח לאפליקציית Authenticator ואז הזינו קוד בן שש ספרות. המפתח מוצג רק בזמן ההגדרה; שמרו אותו במקום מאובטח."
                    fields={[{ key: 'code', label: 'קוד מאפליקציית האימות' }]}
                    onClose={() => setTotpSecret(null)}
                    submit={async (v: Any) => {
                        await api('/totp/enable', 'POST', v);
                        setTotpSecret(null);
                        setUser({ ...user, totpEnabled: true });
                    }}
                >
                    <code className="totp-secret">{totpSecret.secret}</code>
                    <a className="text-btn" href={totpSecret.uri}>
                        פתיחה באפליקציית אימות במכשיר
                    </a>
                </Form>
            )}
        </div>
    );
}
function QrView({ project }: { project: string }) {
    const [source, setSource] = useState(''),
        [error, setError] = useState('');
    useEffect(() => {
        let stopped = false;
        async function refresh() {
            try {
                const data = await api(`/projects/${project}/qr`);
                const QRCode = await import('qrcode');
                const image = await QRCode.toDataURL(data.qr, { width: 280, margin: 2 });
                if (!stopped) {
                    setSource(image);
                    setError('');
                }
                setTimeout(
                    () => {
                        if (!stopped) setSource('');
                    },
                    Math.max(0, data.expires - Date.now())
                );
            } catch (e) {
                if (!stopped) {
                    setSource('');
                    setError((e as Error).message);
                }
            }
        }
        void refresh();
        const timer = setInterval(refresh, 10000);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [project]);
    return (
        <div className="empty">
            {source ? (
                <img width={280} height={280} src={source} alt="QR זמני לחיבור WhatsApp" />
            ) : (
                <p>{error || 'ממתין לקוד QR מהפרויקט…'}</p>
            )}
            <p>הקוד מוצג רק למנהל מחובר ואינו נשמר בלוגים. יש להפעיל qr_enabled בתצורת הפרויקט.</p>
        </div>
    );
}
function githubUrl(repo: string) {
    return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo)
        ? repo
        : /^git@github\.com:[\w.-]+\/[\w.-]+$/.test(repo)
          ? repo.replace('git@github.com:', 'https://github.com/')
          : 'https://github.com';
}
function Login({ onLogin }: { onLogin: (u: Any) => void }) {
    const [error, setError] = useState(''),
        [busy, setBusy] = useState(false);
    return (
        <form
            className="login-card"
            onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError('');
                const f = new FormData(e.currentTarget);
                try {
                    onLogin(
                        await api('/login', 'POST', {
                            username: f.get('username'),
                            password: f.get('password'),
                            ...(f.get('code') ? { code: f.get('code') } : {}),
                        })
                    );
                } catch (e) {
                    setError((e as Error).message);
                } finally {
                    setBusy(false);
                }
            }}
        >
            <h1>ברוכים הבאים בחזרה</h1>
            <p>התחברו כדי לנהל את השרת שלכם</p>
            <label>
                שם משתמש
                <input name="username" autoComplete="username" required maxLength={64} autoFocus />
            </label>
            <label>
                סיסמה
                <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={256}
                />
            </label>
            <label>
                קוד אימות דו־שלבי <small>(אם הוגדר)</small>
                <input
                    name="code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    autoComplete="one-time-code"
                    maxLength={6}
                />
            </label>
            {error && (
                <div className="alert error" role="alert">
                    {error}
                </div>
            )}
            <button className="primary" disabled={busy}>
                {busy ? <Loader2 className="spin" size={17} /> : <Lock size={17} />}כניסה מאובטחת
            </button>
        </form>
    );
}
function Metric({ title, value, subtitle, amount, icon, color }: Any) {
    return (
        <div className={'metric ' + color}>
            <div className="metric-top">
                <span>{title}</span>
                <span className="metric-icon">{icon}</span>
            </div>
            <strong className="metric-value" dir="ltr">
                {value}
            </strong>
            {amount != null && (
                <div className="progress">
                    <div style={{ width: Math.min(100, amount) + '%' }} />
                </div>
            )}
            <small>{subtitle}</small>
        </div>
    );
}
function Empty({ icon, text, detail }: Any) {
    return (
        <div className="empty">
            <div>{icon}</div>
            <strong>{text}</strong>
            <p>{detail}</p>
        </div>
    );
}
function Info({ title, children, onClose }: Any) {
    return (
        <div className="modal-backdrop">
            <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
                <div className="panel-heading">
                    <h2>{title}</h2>
                    <button onClick={onClose} aria-label="סגירה">
                        <X size={19} />
                    </button>
                </div>
                {children}
            </section>
        </div>
    );
}
function Confirm({ title, text, onClose, onConfirm }: Any) {
    return (
        <Info title={title} onClose={onClose}>
            <div className="confirm-icon">
                <AlertTriangle size={24} />
            </div>
            <p className="confirm-text">{text}</p>
            <div className="modal-buttons">
                <button className="primary" autoFocus onClick={onConfirm}>
                    <Check size={15} />
                    אישור מפורש
                </button>
                <button className="secondary" onClick={onClose}>
                    ביטול
                </button>
            </div>
        </Info>
    );
}
function Form({ title, description, fields, onClose, submit, children }: Any) {
    const [busy, setBusy] = useState(false),
        [details, setDetails] = useState<Any | null>(null),
        [error, setError] = useState('');
    return (
        <Info title={title} onClose={onClose}>
            {description && <p className="muted">{description}</p>}
            {children}
            <form
                onSubmit={async (e) => {
                    e.preventDefault();
                    if (busy) return;
                    setBusy(true);
                    setError('');
                    const data = new FormData(e.currentTarget);
                    const values: Any = {};
                    for (const f of fields)
                        values[f.key] = f.type === 'checkbox' ? data.has(f.key) : data.get(f.key);
                    try {
                        await submit(values);
                    } catch (e) {
                        setError((e as Error).message);
                        setDetails((e as Any).details || null);
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                {fields.map((f: Any) => (
                    <label key={f.key} className={f.type === 'checkbox' ? 'checkbox-label' : ''}>
                        {f.label}
                        {f.type === 'textarea' ? (
                            <textarea name={f.key} placeholder={f.placeholder} required dir="ltr" />
                        ) : f.type === 'select' ? (
                            <select name={f.key}>
                                {f.options.map(([v, l]: string[]) => (
                                    <option key={v} value={v}>
                                        {l}
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <input
                                name={f.key}
                                placeholder={f.placeholder}
                                type={f.type || 'text'}
                                required={f.type !== 'checkbox' && f.required !== false}
                                autoComplete={f.type === 'password' ? 'new-password' : 'off'}
                                dir={f.type === 'checkbox' ? undefined : 'auto'}
                            />
                        )}
                    </label>
                ))}
                {error && (
                    <div role="alert" className="alert error">
                        <div className="grow">
                            {error}
                            <ErrorDetails details={details} />
                        </div>
                    </div>
                )}
                <div className="modal-buttons">
                    <button className="primary" disabled={busy}>
                        {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}אישור
                        ושמירה
                    </button>
                    <button type="button" className="secondary" onClick={onClose}>
                        ביטול
                    </button>
                </div>
            </form>
        </Info>
    );
}
createRoot(document.getElementById('root')!).render(<App />);
