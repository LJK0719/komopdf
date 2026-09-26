import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Both applications stage immutable prepared fonts, never each other's output. */
export async function stageFonts(coreRoot, destination) {
  const source = path.join(coreRoot, 'resources/downloads/fonts/prepared-fonts.json');
  const records = await readFile(source, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') throw new Error('Fonts are not prepared. Run python scripts/prepare-fonts.py in the public core checkout.');
    throw error;
  });
  if (!records.length) throw new Error('The prepared font library is empty.');
  await mkdir(destination, { recursive: true });
  const resources = [];
  for (const record of records) {
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
  await writeFile(path.join(destination, 'font-resources.json'), `${JSON.stringify(resources, null, 2)}\n`);
  return resources;
}
