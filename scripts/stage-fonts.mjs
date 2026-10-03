import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Desktop needs a small offline fallback, not the whole optional web library.
export const DESKTOP_FONT_FAMILIES = new Set(['Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'Noto Sans CJK SC']);
export function selectPreparedFonts(records, profile = 'web') {
  if (profile === 'web') return records;
  if (profile !== 'desktop') throw new Error(`Unknown font profile: ${profile}`);
  return records.filter(record => DESKTOP_FONT_FAMILIES.has(record.family));
}

/** Both applications stage immutable prepared fonts, never each other's output. */
export async function stageFonts(coreRoot, destination, { profile = 'web' } = {}) {
  const source = path.join(coreRoot, 'resources/downloads/fonts/prepared-fonts.json');
  const records = await readFile(source, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') throw new Error('Fonts are not prepared. Run python scripts/prepare-fonts.py in the public core checkout.');
    throw error;
  });
  if (!records.length) throw new Error('The prepared font library is empty.');
  await mkdir(destination, { recursive: true });
  const manifest = path.join(destination, 'font-resources.json');
  const previous = await readFile(manifest, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const resources = [];
  const selected = selectPreparedFonts(records, profile);
  if (!selected.some(record => record.id === 'noto-sans-cjk-sc-regular') ||
      !selected.some(record => record.id === 'liberation-sans-regular')) {
    throw new Error('The prepared font library is missing required offline fallback fonts.');
  }
  for (const record of selected) {
    const input = path.join(coreRoot, record.path);
    const bytes = await readFile(input);
    if (bytes.length !== record.bytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256) {
      throw new Error(`Prepared font does not match its manifest: ${record.id}`);
    }
    const sourceName = path.parse(record.path);
    const filename = `${sourceName.name}.${record.sha256.slice(0, 16)}${sourceName.ext}`;
    const licenseName = record.licenseOwner === 'lxgw-wenkai' ? 'LXGW-WenKai-OFL.txt' : `${record.licenseOwner}-${path.basename(record.licensePath)}`;
    await writeFile(path.join(destination, filename), bytes);
    await copyFile(path.join(coreRoot, record.licensePath), path.join(destination, licenseName));
    const { id, family, style, weight, italic, format, sha256 } = record;
    resources.push({ id, family, style, weight, italic, format, sha256, url: `/fonts/${filename}`, licenseUrl: `/fonts/${licenseName}` });
  }
  await writeFile(manifest, `${JSON.stringify(resources, null, 2)}\n`);
  const retained = new Set(resources.flatMap(record => [record.url, record.licenseUrl]).map(url => path.basename(url)));
  for (const filename of new Set(previous.flatMap(record => [record.url, record.licenseUrl]).map(url => path.basename(url)))) {
    if (!retained.has(filename)) await rm(path.join(destination, filename), { force: true });
  }
  return resources;
}
