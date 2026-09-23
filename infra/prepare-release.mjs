import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The deployment target is Linux: resolve/install its dependency graph on Linux,
// not by flattening a Windows pnpm store into something that happens to start here.
if (process.platform !== 'linux') throw new Error('Build the production web/gateway release on Linux (CI or a Linux build host). Windows development builds remain supported.');
const root = fileURLToPath(new URL('..', import.meta.url));
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const version = process.argv[2] || `v0.1.0-${timestamp}`;
if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Expected a vMAJOR.MINOR.PATCH release identifier.');
const stageDir = path.join(root, 'tmp', `release-${version}`);
const tarPath = `${stageDir}.tar.gz`;
if (existsSync(stageDir) || existsSync(tarPath)) throw new Error(`Release already exists: ${stageDir}`);
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });

console.log('[1/4] Preparing pinned Web engines/fonts and building applications...');
run(process.execPath, ['scripts/prepare-web-runtime.mjs']);
run(process.execPath, ['scripts/build-gateway.mjs']);
run('pnpm', ['--filter', '@pdf-editor/web', 'build']);

console.log('[2/4] Staging Gateway production dependencies with their pnpm topology...');
await mkdir(path.dirname(stageDir), { recursive: true });
await mkdir(stageDir, { recursive: false });
const gatewayStageDir = path.join(stageDir, 'apps/gateway');
run('pnpm', ['--filter', '@pdf-editor/gateway', 'deploy', '--legacy', '--prod', gatewayStageDir, '--config.confirmModulesPurge=false']);
// pnpm 11 legacy deploy retains an alias for the deployed workspace itself.
// Point that one alias at the deployed application, not the build checkout.
const selfLink = path.join(gatewayStageDir, 'node_modules/.pnpm/node_modules/@pdf-editor/gateway');
const selfInfo = await lstat(selfLink).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
if (selfInfo?.isSymbolicLink()) {
  await unlink(selfLink);
  await symlink(path.relative(path.dirname(selfLink), gatewayStageDir), selfLink, 'dir');
}
// Keep all other dependency versions and links exactly as pnpm resolved them.
await cp(path.join(root, 'apps/gateway/dist/cli.mjs'), path.join(gatewayStageDir, 'dist/cli.mjs'));

console.log('[3/4] Assembling static files and deployment configuration...');
await cp(path.join(root, 'apps/web/dist'), path.join(stageDir, 'apps/web/dist'), { recursive: true });
await mkdir(path.join(stageDir, 'infra'));
for (const [source, destination] of [
  ['nginx.conf.example', 'komopdf.nginx.conf'],
  ['pdf-editor-gateway.service.example', 'komopdf-gateway.service'],
  ['gateway.config.example.json', 'gateway.config.json'],
  ['deploy.sh', 'deploy.sh'], ['rollback.sh', 'rollback.sh'],
]) await cp(path.join(root, 'infra', source), path.join(stageDir, 'infra', destination));
const gateway = JSON.parse(await readFile(path.join(root, 'apps/gateway/package.json'), 'utf8'));
await writeFile(path.join(stageDir, 'release-manifest.json'), JSON.stringify({
  version, buildTime: new Date().toISOString(), targetPlatform: 'linux',
  gateway: { runtime: 'node24', entry: 'apps/gateway/dist/cli.mjs', dependencies: gateway.dependencies },
  web: { framework: 'nextjs-app-router', exportPath: 'apps/web/dist', routes: ['/', '/editor/', '/download/', '/help/', '/privacy/'] },
}, null, 2) + '\n');
console.log('[4/4] Packaging the self-contained production tree, preserving internal links...');
run('python3', ['infra/package-tar.py', stageDir, tarPath]);
console.log(`Prepared release ${version}: ${tarPath}. Deployment and target-host verification are separate steps.`);
