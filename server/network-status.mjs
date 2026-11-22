// Shared, short-lived, memory-only status cache for all authenticated viewers.
// Never use it for publication validation/authorization or store project secrets.
export function createNetworkStatus(helper, { clock = () => Date.now(), ttl = 5000 } = {}) {
    let cached = null,
        pending = null,
        generation = 0;
    return {
        invalidate() {
            generation++;
            cached = null;
            pending = null;
        },
        get({ fresh = false } = {}) {
            if (fresh) this.invalidate();
            if (cached && clock() - cached.time < ttl) return Promise.resolve(cached.value);
            if (pending) return pending;
            const version = generation;
            const request = Promise.resolve()
                .then(() => helper('network-status'))
                .then((value) => {
                    if (version !== generation) return this.get();
                    cached = { value, time: clock() };
                    return value;
                })
                .catch((error) => {
                    if (version !== generation) return this.get();
                    if (version === generation) cached = null;
                    throw error;
                })
                .finally(() => {
                    if (pending === request) pending = null;
                });
            pending = request;
            return request;
        },
    };
}
