import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const forbidden =
    /(^|\/)(?:\..*|node_modules|current|shared|data|uploads?|secrets?|credentials?|id_rsa.*|id_ed25519.*|.*\.(?:pem|key|p12|sqlite|db)|.*(?:token|password|secret).*|.*\.env.*)(\/|$)/i;
export function safeRelative(input) {
    if (
        typeof input !== 'string' ||
        input.includes('\\') ||
        input.includes('\0') ||
        path.isAbsolute(input) ||
        input.split('/').some((p) => p === '..') ||
        forbidden.test(input)
    )
        throw Object.assign(new Error('נתיב או קובץ חסום מטעמי אבטחה'), { status: 400 });
    return input;
}
// Linux: anchor ancestors to open directory descriptors to prevent symlink swap races.
async function anchored(root, relative, fn) {
    safeRelative(relative);
    const handles = [];
    try {
        const st = await fs.lstat(root);
        if (st.isSymbolicLink()) throw new Error('Symlink root prohibited');
        let current = await fs.realpath(root);
        const parts = relative.split('/').filter(Boolean),
            leaf = parts.pop() || '';
        if (process.platform === 'linux') {
            let h = await fs.open(
                current,
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
            );
            handles.push(h);
            for (const part of parts) {
                h = await fs.open(
                    `/proc/self/fd/${h.fd}/${part}`,
                    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
                );
                handles.push(h);
            }
            current = `/proc/self/fd/${h.fd}`;
        } else {
            for (const part of parts) {
                current = path.join(current, part);
                if ((await fs.lstat(current)).isSymbolicLink())
                    throw new Error('Symlinks prohibited');
            }
        }
        const target = leaf ? path.join(current, leaf) : current;
        return await fn(target, !!leaf);
    } finally {
        await Promise.allSettled(handles.map((h) => h.close()));
    }
}
export async function listFiles(root, relative = '') {
    return anchored(root, relative, async (target, leaf) => {
        const handle = await fs.open(
            target,
            constants.O_RDONLY |
                (constants.O_DIRECTORY || 0) |
                (leaf ? constants.O_NOFOLLOW || 0 : 0)
        );
        try {
            const dir = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : target;
            const entries = await fs.readdir(dir, { withFileTypes: true });
            return entries
                .filter((x) => !x.isSymbolicLink() && !forbidden.test(x.name))
                .map((x) => ({ name: x.name, directory: x.isDirectory() }))
                .sort(
                    (a, b) =>
                        Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)
                );
        } finally {
            await handle.close();
        }
    });
}
export async function readFile(root, relative) {
    return anchored(root, relative, async (target, leaf) => {
        if (!leaf) throw new Error('File path required');
        const h = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const stat = await h.stat();
            if (!stat.isFile() || stat.size > 1024 * 1024 || stat.nlink > 1)
                throw new Error('Only single-link files up to 1 MB are allowed');
            const data = await h.readFile();
            if (data.includes(0))
                throw new Error('Binary files are not supported in the text editor');
            return data.toString('utf8');
        } finally {
            await h.close();
        }
    });
}
export async function writeFile(root, relative, content) {
    if (Buffer.byteLength(content) > 1024 * 1024 || content.includes('\0'))
        throw new Error('Only text files up to 1 MB are supported');
    return anchored(root, relative, async (target, leaf) => {
        if (!leaf) throw new Error('File path required');
        let mode = 0o640;
        try {
            const st = await fs.lstat(target);
            if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1)
                throw new Error('Only regular single-link files are writable');
            mode = st.mode & 0o777;
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }
        const temporary = path.join(path.dirname(target), '.control-edit-' + randomUUID());
        const h = await fs.open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            mode
        );
        try {
            await h.writeFile(content);
            await h.sync();
            await h.close();
            await fs.rename(temporary, target);
        } finally {
            await h.close().catch(() => {});
            await fs.unlink(temporary).catch(() => {});
        }
    });
}
export async function createDirectory(root, relative) {
    return anchored(root, relative, async (target, leaf) => {
        if (!leaf) throw new Error('Directory name required');
        await fs.mkdir(target, { mode: 0o750 });
    });
}
export async function deleteEntry(root, relative) {
    return anchored(root, relative, async (target, leaf) => {
        if (!leaf) throw new Error('Deleting project root is prohibited');
        const st = await fs.lstat(target);
        if (st.isSymbolicLink()) throw new Error('Symlinks prohibited');
        if (st.isDirectory()) await fs.rmdir(target);
        else await fs.unlink(target);
    });
}
