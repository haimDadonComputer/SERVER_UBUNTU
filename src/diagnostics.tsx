import React, { useState } from 'react';
import { Copy, Download } from 'lucide-react';
type Detail = Record<string, any>;
export function ErrorDetails({ details, jobId }: { details?: Detail | null; jobId?: string }) {
    const [copied, setCopied] = useState(false),
        [copyError, setCopyError] = useState('');
    if (!details) return null;
    const report = JSON.stringify({ ...(jobId ? { jobId } : {}), ...details }, null, 2);
    const labels: Record<string, string> = {
        code: 'קוד שגיאה',
        stage: 'שלב שנכשל',
        action: 'פעולה',
        user: 'משתמש מערכת',
        uid: 'UID',
        cwd: 'תיקיית עבודה',
        exitCode: 'קוד יציאה',
        timeoutSeconds: 'מגבלת זמן בשניות',
        httpStatus: 'סטטוס HTTP',
        time: 'זמן השגיאה',
        requestId: 'מזהה בקשה',
        retryAfter: 'ניסיון חוזר בעוד שניות',
    };
    async function copy() {
        try {
            await navigator.clipboard.writeText(report);
            setCopied(true);
            setCopyError('');
        } catch {
            setCopyError('לא ניתן להעתיק אוטומטית. אפשר להוריד את הדוח או לסמן את הפלט.');
        }
    }
    function download() {
        const href = URL.createObjectURL(
            new Blob([report], { type: 'application/json;charset=utf-8' })
        );
        const link = document.createElement('a');
        link.href = href;
        link.download = 'ubuntu-control-error.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
    }
    return (
        <details className="error-details">
            <summary>פרטי השגיאה והמלצה לטיפול</summary>
            <dl>
                {jobId && (
                    <>
                        <dt>מזהה משימה</dt>
                        <dd className="mono">{jobId}</dd>
                    </>
                )}
                {Object.entries(labels)
                    .filter(([key]) => details[key] != null && details[key] !== '')
                    .map(([key, label]) => (
                        <React.Fragment key={key}>
                            <dt>{label}</dt>
                            <dd className="mono">{String(details[key])}</dd>
                        </React.Fragment>
                    ))}
            </dl>
            {details.hint && <p className="diagnostic-hint">{details.hint}</p>}
            {details.command?.length > 0 && (
                <>
                    <strong>הפקודה שנכשלה — לצפייה בלבד</strong>
                    <pre className="code">{details.command.join(' ')}</pre>
                </>
            )}
            {details.stderr && (
                <>
                    <strong>פלט שגיאה מסונן (stderr)</strong>
                    <pre className="code">{details.stderr}</pre>
                </>
            )}
            {details.stdout && (
                <>
                    <strong>פלט רגיל מסונן (stdout)</strong>
                    <pre className="code">{details.stdout}</pre>
                </>
            )}
            {details.launcher && (
                <details>
                    <summary>פרטי הפעלת התהליך</summary>
                    <pre className="code">{JSON.stringify(details.launcher, null, 2)}</pre>
                </details>
            )}
            <div className="actions">
                <button type="button" onClick={() => void copy()}>
                    <Copy size={14} />
                    {copied ? 'הועתק' : 'העתקת פרטי השגיאה'}
                </button>
                <button type="button" onClick={download}>
                    <Download size={14} />
                    הורדת דוח
                </button>
            </div>
            {copyError && <p>{copyError}</p>}
            <small>
                הפלט מסונן ומוגבל לאורך. בדקו את הדוח לפני שיתוף; הסתרה אוטומטית אינה מזהה כל סוד
                אפשרי.
            </small>
        </details>
    );
}
