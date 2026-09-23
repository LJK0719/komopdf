import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));

async function stage(source, destination, desktop) {
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
  const previous = await readFile(path.join(destination, 'manifest.json'), 'utf8')
    .then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const files = [];
  for (const file of manifest.files) {
    const name = file.path;
    const selected = name.startsWith('licenses/') || (desktop ? name.startsWith('bin/') : /\.(js|wasm)$/.test(name));
    if (!selected) continue;
    const bytes = await readFile(path.join(source, name));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`QPDF artifact hash mismatch: ${name}`);
    const relative = desktop && name.startsWith('bin/') ? name.slice(4) : name;
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    if (desktop && process.platform !== 'win32' && !name.startsWith('licenses/')) {
      await chmod(target, 0o755);
    }
    files.push({ ...file, path: relative });
  }
  // Platform switches remove only files owned by the previous runtime manifest.
  for (const file of previous?.files ?? []) {
    if (!files.some(current => current.path === file.path)) {
      await rm(path.join(destination, file.path), { force: true });
    }
  }
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ ...manifest, files }, null, 2) + '\n');
}

export async function prepareQpdfRuntime({ web = true, desktop = false, target, coreRoot = root, desktopRoot = root, webPublic = path.join(coreRoot, 'apps/web/public') } = {}) {
  if (web) await stage(path.join(coreRoot, 'native/qpdf/artifacts/wasm'), path.join(webPublic, 'engines/qpdf'), false);
  if (desktop) {
    const selectedTarget = target || (process.platform === 'win32' ? 'windows-x64' : `macos-${process.arch}`);
    await stage(path.join(desktopRoot, 'native/qpdf/artifacts', selectedTarget), path.join(desktopRoot, 'apps/desktop/src-tauri/runtime/qpdf'), true);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    target: { type: 'string' }, 'web-only': { type: 'boolean' }, 'desktop-only': { type: 'boolean' },
    'core-root': { type: 'string' }, 'desktop-root': { type: 'string' },
  } });
  if (values['web-only'] && values['desktop-only']) throw new Error('Choose either --web-only or --desktop-only.');
  await prepareQpdfRuntime({ web: !values['desktop-only'], desktop: !values['web-only'], target: values.target,
    coreRoot: values['core-root'] ? path.resolve(values['core-root']) : root,
    desktopRoot: values['desktop-root'] ? path.resolve(values['desktop-root']) : root });
  console.log('Prepared local QPDF export components');
}
