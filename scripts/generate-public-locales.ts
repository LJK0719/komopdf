import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUiMessages } from '../packages/editor/src/ui/i18n-resources';
import { UI_LOCALES } from '../packages/editor/src/ui/locales';

const root = fileURLToPath(new URL('..', import.meta.url));
let publicSource = '';
async function scan(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.|editor-client|editor-account-panel/.test(entry.name)) {
      publicSource += await readFile(file, 'utf8');
    }
  }
}
await scan(path.join(root, 'apps/web/src'));
// Account failures are rendered with t(error): include the actual API error sources,
// not just literals visible in web components. Translations still come from the original dictionaries.
for (const file of ['accounts.ts', 'account-store.ts']) {
  publicSource += await readFile(path.join(root, 'apps/gateway/src', file), 'utf8');
}
function usedOnPublicPage(key: string): boolean {
  const source = key.replace(/_(?:one|other|zero|two|few|many)$/, '');
  return [JSON.stringify(source), `'${source.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`, `\`${source}\``].some(literal => publicSource.includes(literal));
}
const output = path.join(root, 'packages/editor/src/ui/public-locales');
const check = process.argv.includes('--check');
if (!check) await mkdir(output, { recursive: true });
for (const { id } of UI_LOCALES) {
  const messages = await loadUiMessages(id);
  const site = id === 'en' ? {} : JSON.parse(await readFile(path.join(root, `packages/editor/src/ui/site-locales/${id}.json`), 'utf8'));
  // Generated subsets only. Translations remain maintained in the original UI and site dictionaries.
  const selected = Object.fromEntries(Object.entries(messages).filter(([key]) => !(key in site) && usedOnPublicPage(key)));
  const content = JSON.stringify(selected, null, 2) + '\n';
  const file = path.join(output, `${id}.json`);
  if (check) {
    if (await readFile(file, 'utf8') !== content) throw new Error(`Public translations are stale: ${id}. Run pnpm i18n:public.`);
  } else await writeFile(file, content);
  console.log(`${id}: ${Object.keys(selected).length} public UI messages${check ? ' checked' : ''}`);
}
