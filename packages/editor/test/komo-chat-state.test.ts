import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AiClientError } from '@pdf-editor/ai-client';
import { chatHistory, chatFailure, type ChatExchange } from '../src/ui/komo-chat-state.js';
import { AiMarkdown } from '../src/ui/AiMarkdown.js';

describe('komo conversation state and display', () => {
  it('uses only completed exchanges in follow-up history', () => {
    const completed: ChatExchange = { id: 'one', prompt: 'question', status: 'complete', answer: 'answer' };
    expect(chatHistory([completed, { id: 'two', prompt: 'stopped', status: 'cancelled' },
      { id: 'three', prompt: 'failed', status: 'failed' }, { id: 'four', prompt: 'pending', status: 'pending' }]))
      .toEqual([{ role: 'user', text: 'question' }, { role: 'assistant', text: 'answer' }]);
  });
  it('explains rate limits, network failures and oversized requests without upstream text', () => {
    expect(chatFailure(new AiClientError('HTTP_ERROR', 'private upstream', 429)).message).toContain('Wait a moment');
    expect(chatFailure(new TypeError('fetch failed')).message).toContain('connection');
    expect(chatFailure(new AiClientError('HTTP_ERROR', 'private upstream', 413))).toMatchObject({ action: 'page' });
    expect(chatFailure(new Error('private upstream')).message).not.toContain('private upstream');
  });
  it('renders headings and GFM tables without HTML, script URLs or remote images', () => {
    const html = renderToStaticMarkup(createElement(AiMarkdown, { text: '# Heading\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![tracker](https://example.com/pixel.png)' }));
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<table>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
  });
});
