import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const localPython = join(projectRoot, 'backend', '.venv', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python');
const python = existsSync(localPython) ? localPython : (process.env.PYTHON || 'python');
const port = process.env.PORT || '3000';
const args = ['-m', 'uvicorn', 'app.main:app', '--app-dir', 'backend', '--host', '0.0.0.0', '--port', port, ...process.argv.slice(2)];
const child = spawn(python, args, { cwd: projectRoot, stdio: 'inherit', env: { ...process.env, PATH: `${join(projectRoot, 'backend', '.venv', windows ? 'Scripts' : 'bin')}${delimiter}${process.env.PATH ?? ''}` } });

child.on('error', (error) => {
  console.error(`Could not start the Python API: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
