import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = path.join(root, 'tmp', 'browser');
const directories = Object.fromEntries(['temp', 'home', 'local-app-data', 'app-data'].map(name => [name, path.join(work, name)]));
await Promise.all(Object.values(directories).map(directory => mkdir(directory, { recursive: true })));
const env = { ...process.env, TEMP: directories.temp, TMP: directories.temp, TMPDIR: directories.temp,
  HOME: directories.home, USERPROFILE: directories.home, LOCALAPPDATA: directories['local-app-data'], APPDATA: directories['app-data'] };
const cli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const child = spawn(process.execPath, [cli, 'test', '--reporter=line', ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code ?? 1; });
child.on('error', () => { process.exitCode = 1; });
