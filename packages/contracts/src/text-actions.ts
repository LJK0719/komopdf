import { z } from 'zod';

export const TEXT_ACTIONS = ['translate', 'explain', 'summarize', 'proofread', 'rewrite', 'shorten'] as const;
export type TextAction = typeof TEXT_ACTIONS[number];

export const TEXT_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'zh', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'ar', name: 'العربية' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'th', name: 'ไทย' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'sv', name: 'Svenska' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'uk', name: 'Українська' },
  { code: 'he', name: 'עברית' },
] as const;

const supportedLanguages = new Set<string>(TEXT_LANGUAGES.map(language => language.code));
const languageSchema = z.string().refine(code => supportedLanguages.has(code), 'Unsupported language');
const idSchema = z.string().min(1).max(200);
const toneSchema = z.enum(['neutral', 'formal', 'concise', 'friendly', 'professional', 'academic']);

export const textActionRequestSchema = z.object({
  requestId: idSchema,
  action: z.enum(TEXT_ACTIONS),
  segments: z.array(z.object({ id: idSchema, text: z.string().min(1) }).strict()).min(1).max(12),
  sourceLanguage: z.string().refine(code => code === 'auto' || supportedLanguages.has(code), 'Unsupported source language'),
  targetLanguage: languageSchema,
  tone: toneSchema,
}).strict().superRefine((request, ctx) => {
  const ids = new Set<string>();
  request.segments.forEach((segment, index) => {
    if (ids.has(segment.id)) ctx.addIssue({ code: 'custom', path: ['segments', index, 'id'], message: 'Duplicate segment id' });
    ids.add(segment.id);
  });
});
export type TextActionRequest = z.infer<typeof textActionRequestSchema>;

export const textActionResultSchema = z.object({
  requestId: idSchema,
  action: z.enum(TEXT_ACTIONS),
  // Language detection may return BCP-47 tags outside the UI list, or auto/und/mul/zxx.
  detectedLanguage: z.string().max(64).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/),
  segments: z.array(z.object({ id: idSchema, text: z.string().min(1), reason: z.string().optional() }).strict()).min(1).max(12),
}).strict().superRefine((result, ctx) => {
  const ids = new Set<string>();
  result.segments.forEach((segment, index) => {
    if (ids.has(segment.id)) ctx.addIssue({ code: 'custom', path: ['segments', index, 'id'], message: 'Duplicate segment id' });
    ids.add(segment.id);
  });
});
export type TextActionResult = z.infer<typeof textActionResultSchema>;
