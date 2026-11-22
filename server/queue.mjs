import { randomUUID } from 'node:crypto';
import { redact } from './security.mjs';
import { audit } from './db.mjs';
import { sanitizeDetails } from './diagnostics.mjs';
export class Queue {
    constructor(db) {
        this.db = db;
        this.locks = new Set();
        this.tail = Promise.resolve();
        this.pending = [];
        this.active = { work: 0, control: 0 };
    }
    add(resource, work, action = null) {
        if (this.locks.has(resource))
            throw Object.assign(new Error('פעולה אחרת כבר מתבצעת על המשאב'), { status: 409 });
        const id = randomUUID();
        this.locks.add(resource);
        this.db
            .prepare(
                "INSERT INTO jobs(id,resource,status,stage,action) VALUES(?,?,'queued','ממתין',?)"
            )
            .run(id, resource, action ? redact(action).slice(0, 100) : null);
        const lane = [
            'project-stop',
            'project-disable',
            'service-stop',
            'service-disable',
        ].includes(action)
            ? 'control'
            : 'work';
        let finish;
        const complete = new Promise((resolve) => {
            finish = resolve;
        });
        this.tail = Promise.all([this.tail, complete]).then(() => {});
        this.pending.push({ id, resource, work, lane, finish });
        queueMicrotask(() => this.drain());
        return id;
    }
    drain() {
        // One build/deploy lane; bounded independent stop/disable operations.
        // Resource reservations still reject every duplicate at enqueue time.
        for (const lane of ['control', 'work']) {
            const limit = lane === 'control' ? 2 : 1;
            while (this.active[lane] < limit) {
                const index = this.pending.findIndex((job) => job.lane === lane);
                if (index < 0) break;
                const job = this.pending.splice(index, 1)[0];
                this.active[lane]++;
                void this.execute(job)
                    .finally(() => {
                        this.active[lane]--;
                        this.locks.delete(job.resource);
                        job.finish();
                        this.drain();
                    })
                    .catch(() => {
                        console.error('Job storage failed for', job.id);
                    });
            }
        }
    }
    async execute({ id, resource, work }) {
        let lastStage = '',
            lastEvent = 0,
            dropped = 0;
        const stage = (input) => {
            const s = redact(
                typeof input === 'string' ? input : String(input.stage || 'פעולה')
            ).slice(0, 100);
            const text =
                typeof input === 'object' ? redact(String(input.text || '')).slice(-2000) : '';
            if (s === lastStage && text && Date.now() - lastEvent < 100) {
                dropped++;
                return;
            }
            this.db
                .prepare(
                    "UPDATE jobs SET status='running',started=COALESCE(started,CURRENT_TIMESTAMP),action=COALESCE(action,?),stage=? WHERE id=?"
                )
                .run(s, s, id);
            this.db
                .prepare('INSERT INTO job_events(job,time,stage,text) VALUES(?,?,?,?)')
                .run(
                    id,
                    new Date().toISOString(),
                    s,
                    (dropped ? `[${dropped} הודעות דולגו עקב עומס]\n` : '') + text
                );
            this.db
                .prepare(
                    'DELETE FROM job_events WHERE job=? AND id NOT IN (SELECT id FROM job_events WHERE job=? ORDER BY id DESC LIMIT 300)'
                )
                .run(id, id);
            lastStage = s;
            lastEvent = Date.now();
            dropped = 0;
        };
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
        }
    }
}
