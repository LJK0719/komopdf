import { test, expect } from '@playwright/test';

function twoTextBlocksPdf(): Buffer {
  const stream = 'BT /F1 14 Tf 36 340 Td (First line) Tj ET\nBT /F1 14 Tf 36 300 Td (Second line) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const position = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return position;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

for (const mode of ['one-by-one', 'one-undo'] as const) {
test(`completed translations write two unchanged blocks: ${mode}`, async ({ page }) => {
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as {
      requestId: string;
      document: { id: string; revision: number };
      context: { evidence: { text: string }[] };
    };
    const original = request.context.evidence[0]?.text;
    const text = original === 'First line' ? 'First' : 'Second';
    const response = {
      protocolVersion: 1, requestId: request.requestId, feature: 'text.translate',
      document: { id: request.document.id, baseRevision: request.document.revision },
      result: { kind: 'textProposal', replacements: [{ targetEvidenceId: 'e1', text }] },
    };
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body:
      frame('accepted', { type: 'accepted', requestId: request.requestId }) +
      frame('result', { type: 'result', response }) +
      frame('done', { type: 'done', requestId: request.requestId }) });
  });

  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'batch-translation.pdf', mimeType: 'application/pdf', buffer: twoTextBlocksPdf() });
  await expect(page.locator('.object-hitbox[data-object-type="text"]')).toHaveCount(2, { timeout: 60_000 });
  const ai = page.getByRole('region', { name: 'komo AI' });
  await ai.getByRole('button', { name: 'Enable AI for this document' }).click();
  await ai.getByRole('combobox', { name: 'Capability' }).selectOption('document.translate');
  await ai.getByRole('button', { name: 'Start Translation (Current Page)' }).click();
  const write = ai.getByRole('button', { name: 'Write to PDF' });
  await expect(write).toHaveCount(2, { timeout: 60_000 });
  if (mode === 'one-by-one') {
    await write.first().click();
    await expect(ai.getByRole('button', { name: 'Applied' })).toHaveCount(1);
    await expect(write).toHaveCount(1);
    await write.click();
  } else {
    await ai.getByRole('button', { name: 'Write remaining (one undo)' }).click();
  }
  await expect(ai.getByRole('button', { name: 'Applied' })).toHaveCount(2);
  await expect(page.locator('.status-dot-error')).toHaveCount(0);
  if (mode === 'one-undo') {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    const original = page.getByRole('textbox', { name: 'Original text' });
    await page.locator('.object-hitbox[data-object-type="text"]').first().click();
    await expect(original).toHaveValue('First line');
    await page.locator('.object-hitbox[data-object-type="text"]').last().click();
    await expect(original).toHaveValue('Second line');
  }
});
}
