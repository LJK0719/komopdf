import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

function vectorAndImagePdf(colorSpace: 'DeviceRGB' | 'DeviceCMYK' = 'DeviceRGB'): Buffer {
  const width = 256, height = 256;
  const channels = colorSpace === 'DeviceCMYK' ? 4 : 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * channels;
    pixels[offset] = x;
    pixels[offset + 1] = y;
    pixels[offset + 2] = Math.floor((x + y) / 2);
    if (channels === 4) pixels[offset + 3] = (x * y) % 256;
  }
  const image = deflateSync(pixels);
  const stream = 'q 250 0 0 250 20 20 cm /Im0 Do Q\nBT /F1 18 Tf 20 280 Td (Vector text remains) Tj ET';
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 320] /Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> >> /Contents 4 0 R >>'),
    Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${colorSpace} /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]),
  ];
  const parts = [Buffer.from('%PDF-1.7\n')];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  for (const [index, object] of objects.entries()) {
    const wrapped = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    offsets.push(length);
    length += wrapped.length;
    parts.push(wrapped);
  }
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

test('explicit local pixel downsampling preserves searchable vector text', async ({ page }) => {
  const original = vectorAndImagePdf();
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'pixel-source.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(page.locator('.object-hitbox[data-object-type="image"]')).toHaveCount(1, { timeout: 60_000 });
  await page.getByText('Protection & export', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Recompress supported images as JPEG (lossy)' }).check();
  await page.getByLabel('Maximum image edge (pixels, optional)').fill('64');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF copy' }).click();
  const resized = await readFile((await (await download).path())!);
  expect(resized).not.toEqual(original);
  expect(resized.toString('latin1')).toMatch(/\/Width\s+64\b/);
  expect(resized.toString('latin1')).toMatch(/\/Height\s+64\b/);
  await expect(page.getByText('pixel-source.pdf', { exact: true })).toBeVisible();
  const reopen = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await reopen).setFiles({ name: 'downsampled.pdf', mimeType: 'application/pdf', buffer: resized });
  await expect(page.locator('.object-hitbox[data-object-type="image"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Select Text object' }).click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('Vector text remains');
});

test('explicit local JPEG copy optimization preserves searchable vector text', async ({ page }) => {
  const original = vectorAndImagePdf();
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'vector-image.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(page.locator('.object-hitbox[data-object-type="image"]')).toHaveCount(1, { timeout: 60_000 });
  await page.getByText('Protection & export', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Recompress supported images as JPEG (lossy)' }).check();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF copy' }).click();
  const optimized = await readFile((await (await download).path())!);
  expect(optimized.length).toBeLessThan(original.length);
  expect(optimized.includes(Buffer.from('/DCTDecode'))).toBe(true);
  const reopen = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await reopen).setFiles({ name: 'optimized.pdf', mimeType: 'application/pdf', buffer: optimized });
  await expect(page.locator('.object-hitbox[data-object-type="image"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Select Text object' }).click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('Vector text remains');
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
});

test('CMYK image downsampling exports a valid searchable PDF copy', async ({ page }) => {
  const original = vectorAndImagePdf('DeviceCMYK');
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'cmyk-source.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(page.locator('.object-hitbox[data-object-type="image"]')).toHaveCount(1, { timeout: 60_000 });
  await page.getByText('Protection & export', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Recompress supported images as JPEG (lossy)' }).check();
  await page.getByLabel('Maximum image edge (pixels, optional)').fill('64');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF copy' }).click();
  const exported = await readFile((await (await download).path())!);
  const content = exported.toString('latin1');
  expect(content).toMatch(/\/ColorSpace\s*\/DeviceCMYK/);
  expect(content).toMatch(/\/Width\s+64\b/);
  expect(content).toMatch(/\/Filter\s*\/DCTDecode/);
  const reopen = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await reopen).setFiles({ name: 'cmyk-export.pdf', mimeType: 'application/pdf', buffer: exported });
  await page.getByRole('button', { name: 'Select Text object' }).click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('Vector text remains');
});
