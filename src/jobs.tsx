import React, { useEffect, useState } from 'react';
import { ErrorDetails } from './diagnostics';
export const stageLabel = (stage: string) =>
    (
        ({
            'project-start': 'מכין הפעלה',
            'project-restart': 'מפעיל מחדש',
            'project-stop': 'עוצר',
            'project-runtime': 'שומר הגדרות הפעלה',
            'project-archive': 'מעביר לארכיון',
            'project-restore': 'משחזר מהארכיון',
            'project-activate': 'מעדכן ופורס',
            'network-project': 'מעדכן פרסום פרויקט',
            'network-management': 'מעדכן פרסום ניהול',
            'network-certificate-test': 'בודק תעודה ב־staging',
            certificate: 'מאמת תעודה',
            'npm-install': 'מתקין תלויות',
            'npm-ci': 'מתקין תלויות',
            'npm-test': 'בודק',
            'npm-build': 'בונה',
            starting: 'מפעיל',
            health: 'בודק תקינות',
            rollback: 'משחזר',
            queued: 'ממתין',
            done: 'הושלם',
            failed: 'נכשל',
            running: 'בביצוע',
            interrupted: 'נקטע',
        }) as Record<string, string>
    )[stage] || stage;
export function JobCard({
    job: j,
    selected = false,
}: {
    job: Record<string, any>;
    selected?: boolean;
}) {
    const [expanded, setExpanded] = useState(selected),
        [history, setHistory] = useState<any[]>([]),
        [gap, setGap] = useState(false);
    useEffect(() => {
        if (selected) setExpanded(true);
    }, [selected]);
    useEffect(() => {
        if (!expanded) return;
        let stopped = false;
        let cursor = 0;
        const load = () =>
            fetch('/api/jobs/' + encodeURIComponent(j.id) + '/events?cursor=' + cursor)
                .then((r) => {
                    if (!r.ok) throw new Error();
                    return r.json();
                })
                .then((data) => {
                    if (!stopped) {
                        setGap(!!data.gap);
                        if (data.events.length) cursor = data.events[data.events.length - 1].id;
                        setHistory((previous) =>
                            [
                                ...new Map(
                                    [...previous, ...data.events].map((event) => [event.id, event])
                                ).values(),
                            ].slice(-300)
                        );
                    }
                })
                .catch(() => {});
        void load();
        const timer = ['queued', 'running'].includes(j.status)
            ? setInterval(load, 3000)
            : undefined;
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [j.id, expanded, j.status]);
    const events = history.length ? history : j.events || [];
    const start = Date.parse((j.started || j.created).replace(' ', 'T') + 'Z');
    const end = j.finished ? Date.parse(j.finished.replace(' ', 'T') + 'Z') : Date.now();
    return (
        <article className={'job-detail ' + (selected ? 'selected' : '')} id={'job-' + j.id}>
            <div className="panel-heading">
                <strong>{stageLabel(j.stage)}</strong>
                <span className={'badge ' + j.status}>{stageLabel(j.status)}</span>
            </div>
            <p className="mono">{j.resource}</p>
            <p>פעולה: {stageLabel(j.action || j.stage)}</p>
            <dl className="job-facts">
                <div>
                    <dt>נוצרה</dt>
                    <dd>{j.created}</dd>
                </div>
                <div>
                    <dt>התחילה</dt>
                    <dd>{j.started || 'טרם התחילה'}</dd>
                </div>
                <div>
                    <dt>הסתיימה</dt>
                    <dd>{j.finished || '—'}</dd>
                </div>
                <div>
                    <dt>משך</dt>
                    <dd>{Math.max(0, Math.floor((end - start) / 1000))} שניות</dd>
                </div>
            </dl>
            <details open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
                <summary>שלבים ופלט מסונן ({events.length})</summary>
                {(gap || events.length >= 300) && <p>הפלט מוגבל; ייתכן שהודעות קודמות חסרות.</p>}
                <div className="job-events">
                    {events.map((event: any, index: number) => (
                        <div key={event.id}>
                            {(index === 0 || event.stage !== events[index - 1].stage) && (
                                <small>
                                    {event.time} · {stageLabel(event.stage)}
                                </small>
                            )}
                            {event.text && <pre className="code">{event.text}</pre>}
                        </div>
                    ))}
                </div>
            </details>
            {j.error && <p className="danger-text">{j.error}</p>}
            <ErrorDetails details={j.details} jobId={j.id} />
        </article>
    );
}
