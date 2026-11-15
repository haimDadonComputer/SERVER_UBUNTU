import { z } from 'zod';
import { audit } from './db.mjs';

export function applyNetworkOrigins(config, state) {
    config.origins = [config.origin, ...(config.extraOrigins || [])];
    if (state.management && state.domain) config.origins.push('https://' + state.domain);
}
export function registerNetwork({ app, db, helper, queue, reauth, config }) {
    const save = (state) => {
        applyNetworkOrigins(config, state);
        return state;
    };
    app.get('/api/network', async (_req, res) => res.json(save(await helper('network-status'))));
    app.patch('/api/network', async (req, res) => {
        await reauth(req);
        const input = z
            .object({
                ip: z.string().max(45),
                domain: z.string().max(253),
                email: z.string().max(254),
            })
            .parse(req.body);
        const state = save(await helper('network-settings', input));
        audit(db, req.session.username, 'network-settings', 'server');
        res.json(state);
    });
    function enqueue(req, res, action, args, resource) {
        const username = req.session.username;
        const job = queue.add(resource, async (stage) => {
            stage(action);
            const state = await helper(action, args, stage);
            if (action !== 'network-certificate-test') save(state);
            audit(db, username, action, resource);
        });
        res.status(202).json({ job });
    }
    const publish = z.object({
        enabled: z.boolean(),
        confirmed: z.literal(true),
        port: z.number().int().min(1024).max(65535).optional(),
        https: z.boolean().default(false),
    });
    app.post('/api/projects/:project/publication', async (req, res) => {
        await reauth(req);
        enqueue(
            req,
            res,
            'network-project',
            { project: req.project.id, ...publish.parse(req.body) },
            'project:' + req.project.id
        );
    });
    app.post('/api/network/management', async (req, res) => {
        await reauth(req);
        enqueue(req, res, 'network-management', publish.parse(req.body), 'network:management');
    });
    app.post('/api/network/certificates/test', async (req, res) => {
        await reauth(req);
        const input = z
            .object({ kind: z.enum(['ip', 'management']), confirmed: z.literal(true) })
            .parse(req.body);
        enqueue(req, res, 'network-certificate-test', input, 'network:certificate');
    });
}
