import { loadUiMessages } from '@pdf-editor/editor/i18n-resources';
import type { UiLocale } from '@pdf-editor/editor/i18n-locales';

export function loadEditorClient() { return import('./editor-client'); }

export async function preloadEditor(locale: UiLocale) {
  const [messages] = await Promise.all([loadUiMessages(locale), loadEditorClient()]);
  return messages;
}
