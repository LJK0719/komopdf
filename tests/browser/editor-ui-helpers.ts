import type { Page } from '@playwright/test';

export async function setEditorLanguage(page: Page, locale: 'en' | 'zh-CN') {
  await page.getByRole('button', { name: /^(File|文件)$/, exact: true }).click();
  await page.getByRole('combobox', { name: /^(Language|语言)$/, exact: true }).selectOption(locale);
  await page.keyboard.press('Escape');
}

export async function ribbonControl(page: Page, name: string) {
  const toolbar = page.getByRole('toolbar', { name: 'Document tools', exact: true });
  const button = toolbar.getByRole('button', { name, exact: true });
  if (await button.isVisible()) return button;
  await toolbar.getByRole('button', { name: 'More tools', exact: true }).click();
  return page.getByRole('menuitem', { name, exact: true });
}

export async function clickRibbonCommand(page: Page, name: string) {
  await (await ribbonControl(page, name)).click();
}
