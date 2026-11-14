import { randomUUID } from 'node:crypto';
import { redact } from './security.mjs';
import { audit } from './db.mjs';
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
                this.db
                    .prepare(
                        "UPDATE jobs SET status='failed',error=?,finished=CURRENT_TIMESTAMP WHERE id=?"
                    )
                    .run(redact(e.message).slice(0, 500), id);
            } finally {
                this.locks.delete(resource);
            }
        });
        return id;
    }
}
