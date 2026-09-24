import { test, expect } from '@playwright/test';

function blankTwoPagePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 6 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Length 0 >>\nstream\n\nendstream',
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

test('AI page numbers use real target page sizes and one locally previewed transaction', async ({ page }) => {
  await page.route('**/api/v1/ai/requests', async route => {
    const request = route.request().postDataJSON() as {
      requestId: string; document: { id: string; revision: number };
      context: { pages: { id: string }[]; availableCommands: string[] };
    };
    expect(request.context.availableCommands).toContain('pages.decorate');
    const response = { protocolVersion: 1, requestId: request.requestId,
      document: { id: request.document.id, baseRevision: request.document.revision }, feature: 'commands.plan',
      result: { kind: 'commandPlan', explanation: 'Add one page number to each page',
        commands: [{ type: 'pages.decorate', pageIds: request.context.pages.map(item => item.id), decoration: 'number' }] } };
    const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body:
      frame('accepted', { type: 'accepted', requestId: request.requestId }) +
      frame('result', { type: 'result', response }) +
      frame('done', { type: 'done', requestId: request.requestId }) });
  });
  await page.goto('/editor/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open PDF', exact: true }).click();
  await (await chooser).setFiles({ name: 'blank-pages.pdf', mimeType: 'application/pdf', buffer: blankTwoPagePdf() });
  await expect(page.locator('.page-chip')).toHaveCount(2, { timeout: 60_000 });
  const ai = page.getByRole('region', { name: 'komo AI' });
  await ai.getByRole('button', { name: 'Enable AI for this document' }).click();
  await ai.getByRole('combobox', { name: 'Capability' }).selectOption('commands.plan');
  await ai.getByRole('combobox', { name: 'Font for new page text' }).selectOption('noto-sans-cjk-sc-regular');
  await ai.getByRole('textbox', { name: 'Instructions / Prompts' }).fill('Add page numbers to pages 1 and 2');
  await ai.getByRole('button', { name: 'Generate' }).click();
  await expect(ai.getByRole('button', { name: 'Apply Command Plan' })).toBeVisible();
  await ai.getByRole('checkbox', { name: 'I reviewed the structural changes that cannot be previewed precisely.' }).check();
  await ai.getByRole('button', { name: 'Apply Command Plan' }).click();
  const text = page.locator('.object-hitbox[data-object-type="text"]');
  await expect(text).toHaveCount(1);
  await text.click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('1');
  await page.getByRole('button', { name: 'Open page 2' }).click();
  await expect(text).toHaveCount(1);
  await text.click();
  await expect(page.getByRole('textbox', { name: 'Original text' })).toHaveValue('2');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(text).toHaveCount(0);
  await page.getByRole('button', { name: 'Open page 1' }).click();
  await expect(text).toHaveCount(0);
});
