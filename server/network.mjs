import { z } from 'zod';
import { audit } from './db.mjs';

export function applyNetworkOrigins(config, state) {
    config.origins = [config.origin, ...(config.extraOrigins || [])];
    if (state.management && state.domain) config.origins.push('https://' + state.domain);
}
export function registerNetwork({ app, db, helper, queue, sessionUser, config, networkStatus }) {
    const save = (state) => {
        applyNetworkOrigins(config, state);
        return state;
    };
    app.get('/api/network', async (req, res) =>
        res.json(save(await networkStatus.get({ fresh: req.query.refresh === '1' })))
    );
    app.patch('/api/network', async (req, res) => {
        await sessionUser(req);
        const input = z
            .object({
                ip: z.string().max(45),
                domain: z.string().max(253),
                email: z.string().max(254),
            })
            .parse(req.body);
        let state;
        networkStatus.invalidate();
        try {
            state = save(await helper('network-settings', input));
        } finally {
            networkStatus.invalidate();
        }
        audit(db, req.session.username, 'network-settings', 'server');
        res.json(state);
    });
    function enqueue(req, res, action, args, resource) {
        const username = req.session.username;
        const job = queue.add(
            resource,
            async (stage) => {
                stage(action);
                let state;
                networkStatus.invalidate();
                try {
                    state = await helper(action, args, stage);
                } finally {
                    networkStatus.invalidate();
                }
                if (action !== 'network-certificate-test') save(state);
                audit(db, username, action, resource);
            },
            action
        );
        res.status(202).json({ job });
    }
    const publish = z.object({
        enabled: z.boolean(),
        confirmed: z.literal(true),
        port: z.number().int().min(1).max(65535).optional(),
        https: z.boolean().default(false),
        domain: z.string().trim().toLowerCase().max(253).default(''),
    });
    app.post('/api/projects/:project/publication', async (req, res) => {
        await sessionUser(req);
        const input = publish.parse(req.body);
        if (input.domain && !input.domain.includes('.')) {
            const network = await helper('network-status');
            const suffix = network.projectDomainSuffix || 'haimdadon.co.il';
            if (
                !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.domain) ||
                !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(suffix)
            )
                throw new Error('Invalid project subdomain');
            input.domain += '.' + suffix;
        }
        if (
            input.domain &&
            config.origins.some((origin) => {
                const hostname = new URL(origin).hostname;
                return input.domain === hostname || input.domain.endsWith('.' + hostname);
            })
        )
            throw new Error('Project domain must be separate from management hostnames');
        enqueue(
            req,
            res,
            'network-project',
            { project: req.project.id, ...input },
            'project:' + req.project.id
        );
    });
    app.post('/api/network/management', async (req, res) => {
        await sessionUser(req);
        enqueue(req, res, 'network-management', publish.parse(req.body), 'network:management');
    });
    app.post('/api/network/certificates/test', async (req, res) => {
        await sessionUser(req);
        const input = z
            .object({ kind: z.enum(['ip', 'management']), confirmed: z.literal(true) })
            .parse(req.body);
        enqueue(req, res, 'network-certificate-test', input, 'network:certificate');
    });
}
