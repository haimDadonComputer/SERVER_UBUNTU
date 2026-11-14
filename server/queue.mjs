import { randomUUID } from 'node:crypto';
import { redact } from './security.mjs';
import { audit } from './db.mjs';
import { sanitizeDetails } from './diagnostics.mjs';
export class Queue {
    constructor(db) {
        this.db = db;
        this.locks = new Set();
        this.tail = Promise.resolve();
    }
    add(resource, work) {
        if (this.locks.has(resource))
            throw Object.assign(new Error('פעולה אחרת כבר מתבצעת על המשאב'), { status: 409 });
        const id = randomUUID();
        this.locks.add(resource);
        this.db
            .prepare("INSERT INTO jobs(id,resource,status,stage) VALUES(?,?,'queued','ממתין')")
            .run(id, resource);
        this.tail = this.tail.then(async () => {
            const stage = (s) =>
                this.db.prepare("UPDATE jobs SET status='running',stage=? WHERE id=?").run(s, id);
            try {
                await work(stage);
                this.db
                    .prepare(
                        "UPDATE jobs SET status='done',stage='הושלם',finished=CURRENT_TIMESTAMP WHERE id=?"
                    )
                    .run(id);
            } catch (e) {
                audit(this.db, 'system', 'job-failed', resource, 'failed');
                const details = sanitizeDetails(e.details) || {
                    code: 'JOB_FAILED',
                    stage: this.db.prepare('SELECT stage FROM jobs WHERE id=?').get(id)?.stage,
                    action: resource,
                    time: new Date().toISOString(),
                    hint: 'לא התקבל פירוט נוסף מהרכיב שנכשל. בדקו את השלב והודעת השגיאה.',
                };
                this.db
                    .prepare(
                        "UPDATE jobs SET status='failed',error=?,error_details=?,finished=CURRENT_TIMESTAMP WHERE id=?"
                    )
                    .run(redact(e.message).slice(0, 1200), JSON.stringify(details), id);
            } finally {
                this.locks.delete(resource);
            }
        });
        return id;
    }
}
