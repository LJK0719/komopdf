import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { prepareQpdfRuntime } from './prepare-qpdf-runtime.mjs';
import { stageFonts } from './stage-fonts.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { output: { type: 'string' } } });
const destination = values.output ? path.resolve(values.output) : path.join(root, 'apps/web/public');
const manifest = JSON.parse(await readFile(path.join(root, 'native/wasm/runtime-build.json'), 'utf8'));
await mkdir(path.join(destination, 'engines'), { recursive: true });
for (const name of ['pdf-core-runtime.js', 'pdf-core-runtime.wasm']) {
  const bytes = await readFile(path.join(root, 'native/wasm/artifacts', name)).catch(error => {
    if (error.code === 'ENOENT') throw new Error('Pinned PDF core artifact is missing. Restore native/wasm/artifacts from the public checkout or rebuild with python scripts/build-core-api.py --target wasm.');
    throw error;
  });
  const expected = manifest.files[name];
  if (!expected || bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error(`PDF core artifact does not match native/wasm/runtime-build.json: ${name}`);
  }
  await writeFile(path.join(destination, 'engines', name), bytes);
}
await prepareQpdfRuntime({ web: true, desktop: false, coreRoot: root, webPublic: destination });
const fonts = await stageFonts(root, path.join(destination, 'fonts'));
console.log(`Prepared web-only PDF core, QPDF and ${fonts.length} font faces in ${destination}`);
