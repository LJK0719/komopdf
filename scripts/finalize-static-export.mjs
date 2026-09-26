import { readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
let aliases = 0;
// The client requests flattened segment names, while the exporter can emit
// directories (e.g. __next.editor/__PAGE__.txt). Publish both from this build.
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['_next', 'fonts', 'engines', 'licenses', 'releases'].includes(entry.name)) continue;
    const source = path.join(directory, entry.name);
    if (entry.isDirectory()) { await visit(source); continue; }
    if (!entry.name.endsWith('.txt')) continue;
    const parts = path.relative(root, source).split(path.sep);
    const segment = parts.findIndex((part, index) => index < parts.length - 1 && part.startsWith('__next.'));
    if (segment < 0) continue;
    const target = path.join(root, ...parts.slice(0, segment), parts.slice(segment).join('.'));
    await copyFile(source, target);
    aliases++;
  }
}
await visit(root);
console.log(`Published ${aliases} current-build static route segment aliases.`);
