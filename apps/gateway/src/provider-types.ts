import type { AiUsage } from '@pdf-editor/contracts';

export type JsonSchema = Record<string, unknown>;
export type ProviderPart = { text: string } | { inlineData: { mimeType: 'image/png' | 'image/jpeg'; data: string } };
export type ProviderInput = {
  systemInstruction: string;
  parts: ProviderPart[];
  responseSchema: JsonSchema;
  maxOutputTokens: number;
};
export type ProviderResult = {
  text: string;
  finishReason: string | null;
  usage: AiUsage | null;
};
export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'finish'; finishReason: string }
  | { type: 'usage'; usage: AiUsage };

export interface ProviderAdapter {
  generate(input: ProviderInput, signal: AbortSignal): Promise<ProviderResult>;
  stream(input: ProviderInput, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
