import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Ubuntu supplies python3 without necessarily providing a python alias.
// Windows development uses the existing Python installation's python command.
const executable = process.platform === 'win32' ? 'python' : 'python3';
const result = spawnSync(
    executable,
    ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit' }
);
if (result.error) {
    console.error(`Cannot run ${executable}: ${result.error.code || 'process failed'}`);
}
process.exit(result.status ?? 1);
