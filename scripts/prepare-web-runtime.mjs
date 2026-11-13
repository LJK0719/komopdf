import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { prepareQpdfRuntime } from './prepare-qpdf-runtime.mjs';
import { stageFonts } from './stage-fonts.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { output: { type: 'string' }, force: { type: 'boolean', default: false } } });
const destination = values.output ? path.resolve(values.output) : path.join(root, 'apps/web/public');
const manifest = JSON.parse(await readFile(path.join(root, 'native/wasm/runtime-build.json'), 'utf8'));
await mkdir(path.join(destination, 'engines'), { recursive: true });
for (const name of ['pdf-core-runtime.js', 'pdf-core-runtime.wasm']) {
  const sourcePath = path.join(root, 'native/wasm/artifacts', name);
  const targetPath = path.join(destination, 'engines', name);
  const expected = manifest.files[name];
  const [sourceStat, targetStat] = await Promise.all([stat(sourcePath).catch(() => null), stat(targetPath).catch(() => null)]);
  if (!sourceStat) {
    throw new Error('Pinned PDF core artifact is missing. Restore native/wasm/artifacts from the public checkout or rebuild with python scripts/build-core-api.py --target wasm.');
  }
  if (!values.force && expected && targetStat?.size === expected.bytes && sourceStat.size === expected.bytes && targetStat.mtimeMs >= sourceStat.mtimeMs) {
    continue;
  }
  const bytes = await readFile(sourcePath);
  if (!expected || bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error(`PDF core artifact does not match native/wasm/runtime-build.json: ${name}`);
  }
  await writeFile(targetPath, bytes);
}
await prepareQpdfRuntime({ web: true, desktop: false, coreRoot: root, webPublic: destination });
const fonts = await stageFonts(root, path.join(destination, 'fonts'));
await cp(path.join(root, 'third_party/notices'), path.join(destination, 'licenses/third-party'), { recursive: true });
for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
  await copyFile(path.join(root, name), path.join(destination, 'licenses', name));
}
console.log(`Prepared web-only PDF core, QPDF and ${fonts.length} font faces in ${destination}`);
