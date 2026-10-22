import { expect, type Page } from '@playwright/test';

export function pdfObjects(objects: string[]): Buffer {
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(pdf);
  return Buffer.from(pdf + `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
export function aiPdf(lines = ['Hello from this PDF.'], fragmented = false): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${lines.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${lines.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [index, text] of lines.entries()) {
    let x = 30;
    const widths: Record<string, number> = { H: 722, e: 556, l: 222, o: 556, ' ': 278, w: 722, r: 333, d: 556, '.': 278 };
    const content = fragmented ? [...text].map(character => {
      const part = `BT /F1 16 Tf ${x.toFixed(3)} 160 Td (${character}) Tj ET`;
      x += (widths[character] ?? 556) * 16 / 1000; return part;
    }).join('\n') : `BT /F1 16 Tf 30 160 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 220] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  return pdfObjects(objects);
}
export function textareaAiPdf(): Buffer {
  const content = 'BT /F1 16 Tf 0.985 0.174 -0.174 0.985 30 100 Tm (Hello from this PDF.) Tj ET';
  return pdfObjects(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 220] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
}
export function imageAiPdf(): Buffer {
  const content = 'q 300 0 0 180 30 20 cm /Im0 Do Q';
  return pdfObjects(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 220] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nRGB\nendstream']);
}
export async function openAiPdf(page: Page, name = 'ai-test.pdf', lines?: string[], fragmented = false) {
  const chooser = page.waitForEvent('filechooser');
  const add = page.getByRole('button', { name: 'Open another PDF', exact: true });
  await (await add.count() ? add : page.getByRole('button', { name: 'Open PDF', exact: true })).click();
  await (await chooser).setFiles({ name, mimeType: 'application/pdf', buffer: aiPdf(lines, fragmented) });
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  await expect(page.locator('.pdf-character').first()).toBeVisible();
}
export async function selectAiText(page: Page, count = 5, lastPage = 0) {
  const first = (await page.locator('.pdf-text-layer').first().locator('.pdf-character').first().boundingBox())!;
  const last = (await page.locator('.pdf-text-layer').nth(lastPage).locator('.pdf-character').nth(count - 1).boundingBox())!;
  await page.mouse.move(first.x + 0.5, first.y + first.height / 2); await page.mouse.down();
  await page.mouse.move(last.x + last.width - 0.5, last.y + last.height / 2, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2, { button: 'right' });
}
export async function mockAiAccount(page: Page, credits = 1000) {
  await page.addInitScript(() => {
    const user = { id: 'user_ai_integration', organizationMemberships: [] };
    const session = { id: 'session_ai_integration', status: 'active', user, getToken: async () => 'test-token-not-a-secret',
      lastActiveToken: { jwt: { claims: { sub: user.id, sid: 'session_ai_integration' } } } };
    const resources = { client: { id: 'client_ai_integration', sessions: [session] }, session, user, organization: null };
    Object.assign(window, { Clerk: { ...resources, loaded: true, status: 'ready', __internal_lastEmittedResources: resources,
      load: async () => {}, addListener: (listener: (value: unknown) => void, options?: { skipInitialEmit?: boolean }) => { if (!options?.skipInitialEmit) listener(resources); return () => {}; },
      on: (event: string, listener: (value: string) => void, options?: { notify?: boolean }) => { if (event === 'status' && options?.notify) listener('ready'); return () => {}; },
      off: () => {}, __internal_updateProps: async () => {}, telemetry: { record: () => {} } } });
  });
  await page.route('**/api/account/config', route => route.fulfill({ json: { publishableKey: `pk_test_${Buffer.from('ui-test.clerk.accounts.dev$').toString('base64')}` } }));
  await page.route('**/api/account', route => route.fulfill({ json: { userId: 'user_ai_integration', plan: 'free', freeCredits: 1000, usedCredits: 1000 - credits, remainingCredits: credits,
    tokensPerCredit: 100, subscriptionStatus: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, billingAvailable: false,
    profile: { name: 'AI UI test', email: 'ai-ui@example.test', imageUrl: '' } } }));
}
