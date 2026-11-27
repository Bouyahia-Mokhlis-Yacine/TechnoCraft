import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const venvPython = path.join(root, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const executable = process.env.SATIM_PYTHON
  ?? (process.env.CONDA_PREFIX ? 'python' : existsSync(venvPython) ? venvPython : process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(executable, ['-m', 'engine.export', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
