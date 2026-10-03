import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Isolated real-browser coverage: no PDF runtime, app build or HTTP server needed.
// Run with the existing runner and --config tests/browser to omit the app webServer.
test.use({ channel: 'msedge', locale: 'en-US' });

declare global {
  interface Window {
    searchFixture: {
      locations: { pageId: string; blockId: string; range: { start: number; end: number } }[];
      calls: number;
      held: boolean;
      fail: boolean;
      replaceHeld: boolean;
      busy: boolean[];
      transactions: { commands: { range: number[]; text: string }[] }[];
      release(): void;
      releaseReplace(): void;
      update(next: { revision?: number; disabled?: boolean; readOnly?: boolean; newEngine?: boolean }): void;
      unmount(): void;
    };
  }
}

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('../../packages/editor/', import.meta.url)),
      loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { PdfSearchPanel } from './src/ui/PdfSearchPanel.tsx';
        const root = createRoot(document.getElementById('root'));
        let info = { id: 'doc', revision: 1, pageOrder: ['p1', 'p2'], permissions: { modify: true }, capabilities: ['text.replace'] };
        let disabled = false;
        const texts = { p1: '😀 Hit hit hitter', p2: 'hit 中文 中文搜索' };
        const block = pageId => ({ id: 'b-' + pageId, pageId, editability: 'editable', sourceObjectIds: ['o-' + pageId], runs: [{ text: texts[pageId] }] });
        const pending = [];
        let finishReplace;
        const fixture = window.searchFixture = {
          locations: [], calls: 0, held: false, fail: false, replaceHeld: false, busy: [], transactions: [],
          release: () => pending.shift()?.(),
          releaseReplace: () => finishReplace?.(),
          update(next) {
            if (next.revision !== undefined) info = { ...info, revision: next.revision };
            if (next.readOnly !== undefined) info = { ...info, permissions: { modify: !next.readOnly } };
            if (next.disabled !== undefined) disabled = next.disabled;
            if (next.newEngine) engine = { ...engine };
            render();
          },
          unmount: () => root.unmount(),
        };
        let engine = {
          async extract({ pageIds }) {
            fixture.calls++;
            if (fixture.held) await new Promise(resolve => pending.push(resolve));
            if (fixture.fail) throw new Error('Search fixture failed');
            return [block(pageIds[0])];
          },
          async describePage(docId, pageId) { return { id: pageId, objects: [{ id: 'o-' + pageId, textBlock: block(pageId) }] }; },
          async previewText() {
            if (fixture.replaceHeld) await new Promise(resolve => { finishReplace = resolve; });
            return { overflow: false };
          },
          async apply(transaction) {
            fixture.transactions.push(transaction);
            const command = transaction.commands[0];
            texts[command.pageId] = texts[command.pageId].slice(0, command.range[0]) + command.text + texts[command.pageId].slice(command.range[1]);
            return { revision: info.revision + 1 };
          },
        };
        function render() {
          root.render(<PdfSearchPanel document={info} engine={engine} disabled={disabled}
            onLocate={(pageId, blockId, range) => fixture.locations.push({ pageId, blockId, range })}
            onBusyChange={busy => fixture.busy.push(busy)}
            onCommitted={async result => { info = { ...info, revision: result.revision }; render(); }} />);
        }
        render();
      `,
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  bundle = result.outputFiles[0]!.text;
});

test.beforeEach(async ({ page }) => {
  await page.route('https://search.invalid/', route => route.fulfill({ contentType: 'text/html', body:
    '<div id="root"></div><input aria-label="Other input"><textarea aria-label="Other textarea"></textarea><div contenteditable="true" aria-label="Other editor"><span>Editable text</span></div>' }));
  await page.goto('https://search.invalid/');
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('textbox', { name: 'Find text', exact: true })).toBeVisible();
});

test('selects, counts and cycles matches without moving focus; Enter and F3 support Shift', async ({ page }) => {
  const query = page.getByRole('textbox', { name: 'Find text', exact: true });
  const status = page.getByRole('status');
  const previous = page.getByRole('button', { name: 'Previous match', exact: true });
  const next = page.getByRole('button', { name: 'Next match', exact: true });
  await expect(next).toBeDisabled();
  await query.fill('hit');
  await query.press('Enter');
  await expect(status).toHaveText('1 of 4');
  await expect(query).toBeFocused();
  expect(await page.evaluate(() => window.searchFixture.locations[0])).toEqual({ pageId: 'p1', blockId: 'b-p1', range: { start: 3, end: 6 } });
  await query.press('Enter');
  await expect(status).toHaveText('2 of 4');
  await query.press('Shift+Enter');
  await expect(status).toHaveText('1 of 4');
  await query.press('Shift+F3');
  await expect(status).toHaveText('4 of 4');
  expect(await page.evaluate(() => window.searchFixture.locations.at(-1)?.pageId)).toBe('p2');
  await query.press('F3');
  await expect(status).toHaveText('1 of 4');
  await previous.click();
  await expect(status).toHaveText('4 of 4');
  await expect(previous).toBeFocused();
  await next.click();
  await expect(status).toHaveText('1 of 4');
  await page.getByRole('button', { name: 'Page 2: hit 中文 中文搜索', exact: true }).click();
  await expect(status).toHaveText('4 of 4');
  await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(1);
  await expect(page.locator('button[aria-pressed="true"] mark')).toHaveText('hit');
  expect(await page.evaluate(() => window.searchFixture.calls)).toBe(2);
});

test('updates case/word criteria, invalidates stale results and explains empty results', async ({ page }) => {
  const query = page.getByRole('textbox', { name: 'Find text', exact: true });
  const status = page.getByRole('status');
  await query.fill('hit');
  await query.press('Enter');
  await expect(status).toHaveText('1 of 4');
  await page.getByRole('checkbox', { name: 'Match case' }).check();
  await expect(page.getByRole('button', { name: 'Next match', exact: true })).toBeDisabled();
  await expect(page.locator('button[aria-pressed]')).toHaveCount(0);
  await query.press('Shift+Enter');
  await expect(status).toHaveText('3 of 3');
  await page.getByRole('checkbox', { name: 'Whole words', exact: true }).check();
  await query.press('Enter');
  await expect(status).toHaveText('1 of 2');
  await page.getByRole('checkbox', { name: 'Match case' }).uncheck();
  await query.press('Enter');
  await expect(status).toHaveText('1 of 3');
  await query.fill('中文');
  await query.press('Enter');
  await expect(status).toHaveText('1 of 1');
  await query.fill('missing');
  await query.press('Enter');
  await expect(status).toHaveText('No matches found');
  await expect(page.getByRole('button', { name: 'Previous match', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Replace selected match' })).toBeDisabled();
});

test('does not intercept other editing fields, IME or modified shortcuts; cleans up on unmount', async ({ page }) => {
  const query = page.getByRole('textbox', { name: 'Find text', exact: true });
  await query.fill('hit');
  for (const event of [{ key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'Enter', ctrlKey: true }]) {
    await query.dispatchEvent('keydown', event);
  }
  expect(await page.evaluate(() => window.searchFixture.calls)).toBe(0);
  await query.press('Enter');
  await expect(page.getByRole('status')).toHaveText('1 of 4');
  for (const name of ['Replace with', 'Other input', 'Other textarea']) {
    const field = page.getByRole('textbox', { name, exact: true });
    await field.focus();
    await field.press('F3');
    await field.press('Shift+F3');
    await field.press('Enter');
  }
  await page.locator('[contenteditable] span').dispatchEvent('keydown', { key: 'F3' });
  await query.dispatchEvent('keydown', { key: 'F3', isComposing: true });
  await query.press('Control+F3');
  await expect(page.getByRole('status')).toHaveText('1 of 4');
  expect(await page.evaluate(() => window.searchFixture.locations.length)).toBe(1);
  // Outside an input F3 is owned by the mounted search panel.
  expect(await page.evaluate(() => !document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true, cancelable: true })))).toBe(true);
  await expect(page.getByRole('status')).toHaveText('2 of 4');
  await page.evaluate(() => window.searchFixture.unmount());
  expect(await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true, cancelable: true })))).toBe(true);
});

test('shows progress, stops extraction and navigates partial results without accepting late pages', async ({ page }) => {
  const query = page.getByRole('textbox', { name: 'Find text', exact: true });
  await page.evaluate(() => { window.searchFixture.held = true; });
  await query.fill('hit');
  await query.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Searching… 0 / 2 pages · 0 matches');
  await expect(page.getByRole('button', { name: 'Find', exact: true })).toBeDisabled();
  await query.press('Enter');
  expect(await page.evaluate(() => window.searchFixture.calls)).toBe(1);
  await page.evaluate(() => window.searchFixture.release());
  await expect(page.getByRole('status')).toHaveText('Searching… 1 / 2 pages · 3 matches');
  await expect(page.getByRole('button', { name: 'Next match', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Stop search' }).click();
  await expect(page.getByRole('status')).toHaveText('Search stopped · 0 of 3');
  await query.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Search stopped · 1 of 3');
  await page.evaluate(() => window.searchFixture.release());
  await expect(page.getByRole('status')).toHaveText('Search stopped · 1 of 3');
  await expect(page.locator('button[aria-pressed]')).toHaveCount(3);
});

test('discards in-flight results after changing query, options, revision or engine', async ({ page }) => {
  const query = page.getByRole('textbox', { name: 'Find text', exact: true });
  await page.evaluate(() => { window.searchFixture.held = true; });
  for (const change of ['query', 'option', 'revision', 'engine']) {
    await query.fill('hit');
    await query.press('Enter');
    await expect(page.getByRole('status')).toHaveText('Searching… 0 / 2 pages · 0 matches');
    if (change === 'query') await query.fill('new');
    if (change === 'option') await page.getByRole('checkbox', { name: 'Match case' }).check();
    if (change === 'revision') await page.evaluate(() => window.searchFixture.update({ revision: 2 }));
    if (change === 'engine') await page.evaluate(() => window.searchFixture.update({ newEngine: true }));
    await expect(page.getByRole('status')).toHaveText('Enter text and press Enter to search.');
    await page.evaluate(() => window.searchFixture.release());
    await expect(page.getByRole('status')).toHaveText('Enter text and press Enter to search.');
    await expect(page.locator('button[aria-pressed]')).toHaveCount(0);
  }
  expect(await page.evaluate(() => window.searchFixture.locations)).toEqual([]);
  expect(await page.evaluate(() => window.searchFixture.calls)).toBe(4);
});

test('preserves selected UTF-16 range for replace and disables controls until commit', async ({ page }) => {
  const query = page.getByRole('textbox', { name: 'Find text', exact: true });
  await query.fill('hit');
  await query.press('Enter');
  await expect(page.getByRole('status')).toHaveText('1 of 4');
  await page.getByRole('textbox', { name: 'Replace with', exact: true }).fill('New');
  await page.evaluate(() => { window.searchFixture.replaceHeld = true; });
  await page.getByRole('button', { name: 'Replace selected match' }).click();
  await expect(query).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next match', exact: true })).toBeDisabled();
  await page.evaluate(() => window.searchFixture.releaseReplace());
  await expect(query).toBeEnabled();
  await expect(page.getByRole('status')).toHaveText('Enter text and press Enter to search.');
  expect(await page.evaluate(() => window.searchFixture.transactions[0]?.commands[0])).toMatchObject({ range: [3, 6], text: 'New' });
  expect(await page.evaluate(() => window.searchFixture.busy)).toEqual([true, false]);
  await query.press('Enter');
  await expect(page.getByRole('status')).toHaveText('1 of 3');
});

test('respects disabled controls, permits read-only search and surfaces extraction errors', async ({ page }) => {
  const query = page.getByRole('textbox', { name: 'Find text', exact: true });
  await query.fill('hit');
  await page.evaluate(() => window.searchFixture.update({ disabled: true }));
  await expect(query).toBeDisabled();
  await expect(query).toHaveAttribute('readonly', '');
  await expect(query).toBeFocused();
  expect(await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true, cancelable: true })))).toBe(true);
  expect(await page.evaluate(() => window.searchFixture.calls)).toBe(0);
  await page.evaluate(() => window.searchFixture.update({ disabled: false, readOnly: true }));
  await query.press('Enter');
  await expect(page.getByRole('status')).toHaveText('1 of 4');
  await expect(page.getByRole('textbox', { name: 'Replace with', exact: true })).toHaveCount(0);
  await query.fill('new');
  await page.evaluate(() => { window.searchFixture.fail = true; });
  await query.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Search fixture failed');
  await expect(page.getByRole('status')).toHaveText('Search failed · 0 of 0');
  await expect(page.getByRole('button', { name: 'Find', exact: true })).toBeEnabled();
});
