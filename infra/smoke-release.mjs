import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!process.argv[2]) throw new Error('Usage: node infra/smoke-release.mjs <extracted-release>');
const release = path.resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(path.join(release, 'release-manifest.json'), 'utf8'));
for (const file of ['index.html', 'editor/index.html', 'download/index.html', 'engines/pdf-core-runtime.wasm', 'engines/qpdf/pdf-editor-qpdf.wasm', 'fonts/font-resources.json']) {
  if (!(await readFile(path.join(release, 'apps/web/dist', file))).length) throw new Error(`Empty static release asset: ${file}`);
}
await mkdir(path.join(root, 'tmp'), { recursive: true });
const temporary = await mkdtemp(path.join(root, 'tmp/release-smoke-'));
let child;
try {
  const config = JSON.parse(await readFile(path.join(release, 'infra/gateway.config.json'), 'utf8'));
  config.provider.baseUrl = 'https://example.invalid';
  await writeFile(path.join(temporary, 'gateway.json'), JSON.stringify(config));
  // This is a synthetic placeholder, never an actual upstream credential.
  await writeFile(path.join(temporary, 'credential'), 'synthetic-ci-placeholder-not-a-real-key\n');
  child = spawn(process.execPath, [path.join(release, manifest.gateway.entry), '--host', '127.0.0.1', '--port', '18787', '--config', path.join(temporary, 'gateway.json'), '--credential-file', path.join(temporary, 'credential')], {
    cwd: release, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.pipe(process.stderr);
  const lines = createInterface({ input: child.stdout });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Packaged gateway did not start within 15 seconds')), 15_000);
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Packaged gateway exited before startup: ${code}`)); });
    lines.on('line', (line) => {
      try {
        if (JSON.parse(line).event === 'gateway_started') { clearTimeout(timeout); resolve(); }
      } catch { /* Non-JSON startup logs are not readiness events. */ }
    });
  });
  const response = await fetch('http://127.0.0.1:18787/healthz', { signal: AbortSignal.timeout(5000) });
  if (response.status !== 200) throw new Error(`Packaged gateway health returned ${response.status}`);
  console.log(`Extracted release ${manifest.version}: static assets present, real gateway /healthz returned 200; no model request made.`);
  lines.close();
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  await rm(temporary, { recursive: true, force: true });
}
