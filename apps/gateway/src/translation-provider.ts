import type { GatewayConfig } from './config.js';
import { openResponse, ProviderError, readSseResponse } from './gemini.js';
import type { ProviderAdapter, ProviderEvent, ProviderInput, ProviderResult } from './provider-types.js';

type ChatChunk = {
  error?: unknown;
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
};

/** Translation keeps the configured model, but uses its low-effort Chat Completions API. */
export class TranslationProvider implements ProviderAdapter {
  constructor(private readonly config: GatewayConfig, private readonly apiKey: string) {}

  async generate(input: ProviderInput, signal: AbortSignal): Promise<ProviderResult> {
    let text = '', finishReason: string | null = null;
    for await (const event of this.stream(input, signal)) {
      if (event.type === 'text') text += event.text;
      if (event.type === 'finish') finishReason = event.finishReason;
    }
    return { text, finishReason, usage: null };
  }

  async *stream(input: ProviderInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const body = Buffer.from(JSON.stringify({
      model: this.config.provider.model,
      reasoning_effort: 'low',
      stream: true,
      max_tokens: input.maxOutputTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: input.systemInstruction },
        { role: 'user', content: input.parts.map(part => 'text' in part ? part.text : '').join('\n') },
      ],
    }));
    const url = new URL(`${this.config.provider.baseUrl}/v1/chat/completions`);
    const response = await openResponse(url, body, '', signal, this.config.limits.connectTimeoutMs, {
      authorization: `Bearer ${this.apiKey}`, accept: 'text/event-stream',
    });
    try {
      for await (const chunk of readSseResponse<ChatChunk>(response, this.config.limits.upstreamFrameBytes, this.config.limits.upstreamStreamBytes)) {
        if (chunk.error) throw new ProviderError('UPSTREAM_PROTOCOL', 'Upstream stream failed');
        const choice = chunk.choices?.[0];
        if (typeof choice?.delta?.content === 'string' && choice.delta.content) yield { type: 'text', text: choice.delta.content };
        if (choice?.finish_reason) {
          yield { type: 'finish', finishReason: choice.finish_reason === 'stop' ? 'STOP' : choice.finish_reason };
          return;
        }
      }
    } finally { response.destroy(); }
  }
}
