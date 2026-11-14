import { projectView, reconcileProjects } from './project-lifecycle.mjs';
import { audit } from './db.mjs';
import { createHash } from 'node:crypto';
import { redact } from './security.mjs';
export class ProjectUpdater {
    constructor({ db, helper, queue, clock = () => Date.now() }) {
        Object.assign(this, { db, helper, queue, clock });
        this.checking = new Set();
        this.stopped = false;
        this.lastReconcile = clock();
    }
    async tick() {
        if (this.stopped || this.reconciling) return;
        const now = this.clock();
        if (now - this.lastReconcile >= 60000) {
            this.lastReconcile = now;
            this.reconciling = true;
            try {
                await reconcileProjects(this.db, this.helper);
            } catch {
            } finally {
                this.reconciling = false;
            }
            if (this.stopped) return;
        }
        const rows = this.db
            .prepare('SELECT * FROM projects')
            .all()
            .map(projectView)
            .filter(
                (p) =>
                    p.lifecycle === 'active' &&
                    !p.recoveryPending &&
                    p.updates === 'auto' &&
                    p.runtime &&
                    p.repo
            );
        for (const p of rows) {
            if (this.checking.size >= 2) break;
            if (this.checking.has(p.id)) continue;
            let state = {};
            try {
                state = JSON.parse(p.update_state || '{}');
            } catch {}
            if (!state.nextCheck) {
                state.nextCheck =
                    now +
                    (parseInt(createHash('sha256').update(p.id).digest('hex').slice(0, 8), 16) %
                        60) *
                        1000;
                this.persist(p.id, state);
            }
            if (state.nextCheck > now) continue;
            this.checking.add(p.id);
            void this.check(p, state).finally(() => this.checking.delete(p.id));
        }
    }
    persist(id, state) {
        this.db
            .prepare('UPDATE projects SET update_state=? WHERE id=?')
            .run(JSON.stringify(state), id);
    }
    async check(p, state) {
        const now = this.clock();
        try {
            const head = await this.helper('project-head', { project: p.id, etag: state.etag });
            if (this.stopped) return;
            state = {
                ...state,
                checkedAt: new Date(now).toISOString(),
                nextCheck: now + 60000,
                errors: 0,
                error: null,
                etag: head.etag || state.etag,
                remoteCommit: head.sha || state.remoteCommit,
            };
            this.persist(p.id, state);
            const current = this.db.prepare('SELECT * FROM projects WHERE id=?').get(p.id);
            if (
                !current ||
                projectView(current).lifecycle !== 'active' ||
                projectView(current).updates !== 'auto'
            )
                return;
            const sha = state.remoteCommit;
            if (
                !sha ||
                sha === p.preparedCommit ||
                sha === p.failedCommit ||
                state.failedCommit === sha
            )
                return;
            if (this.queue.locks.has('project:' + p.id)) return;
            this.queue.add('project:' + p.id, async (stage) => {
                const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(p.id);
                if (!row) return;
                const current = projectView(row);
                if (current.lifecycle !== 'active' || current.updates !== 'auto') return;
                const latest = JSON.parse(row.update_state || '{}');
                const target = latest.remoteCommit || sha;
                if (
                    target === current.preparedCommit ||
                    target === current.failedCommit ||
                    target === latest.failedCommit
                )
                    return;
                stage('עדכון אוטומטי: בונה ומפריס גרסה');
                try {
                    const record = await this.helper('project-activate', {
                        project: p.id,
                        expected: target,
                        confirmed: true,
                    });
                    this.db
                        .prepare('UPDATE projects SET lifecycle_json=? WHERE id=?')
                        .run(JSON.stringify(record), p.id);
                    audit(this.db, 'scheduler', 'auto-deploy', p.id);
                } catch (error) {
                    const latest = JSON.parse(
                        this.db.prepare('SELECT update_state FROM projects WHERE id=?').get(p.id)
                            ?.update_state || '{}'
                    );
                    latest.failedCommit = target;
                    this.persist(p.id, latest);
                    await reconcileProjects(this.db, this.helper).catch(() => {});
                    throw error;
                }
            });
        } catch (error) {
            if (this.stopped) return;
            const errors = (state.errors || 0) + 1;
            const retry = Number(error.details?.retryAfter) || 0;
            state = {
                ...state,
                errors,
                error: redact(error.message).slice(0, 1200),
                checkedAt: new Date(now).toISOString(),
                nextCheck:
                    now +
                    Math.max(retry * 1000, Math.min(900000, 60000 * 2 ** Math.min(errors - 1, 4))),
            };
            this.persist(p.id, state);
            if (errors === 1) audit(this.db, 'scheduler', 'auto-check-failed', p.id, 'failed');
        }
    }
    start() {
        this.stopped = false;
        this.timer = setInterval(() => void this.tick(), 1000);
        this.timer.unref();
        void this.tick();
    }
    stop() {
        this.stopped = true;
        clearInterval(this.timer);
    }
}
