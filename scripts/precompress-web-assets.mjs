import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const compress = promisify(gzip);
const root = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
let files = 0, originalBytes = 0, compressedBytes = 0;
async function prepare(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await prepare(file);
    else if (/\.(ttf|otf|wasm|js|json)$/.test(entry.name)) {
      const original = await readFile(file);
      const packed = await compress(original, { level: 6 });
      await writeFile(`${file}.gz`, packed);
      files++; originalBytes += original.length; compressedBytes += packed.length;
    }
  }
}
await prepare(path.join(root, 'fonts'));
await prepare(path.join(root, 'engines'));
console.log(`Precompressed ${files} font/engine assets: ${originalBytes} -> ${compressedBytes} bytes.`);
