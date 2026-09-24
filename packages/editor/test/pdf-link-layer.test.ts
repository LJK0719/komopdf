import { describe, expect, it, vi } from 'vitest';
import type { PageModel, PdfAnnotationInfo, RenderResult } from '@pdf-editor/contracts';
import { PdfLinkLayer } from '../src/ui/PdfLinkLayer.js';
import React from 'react';
import { renderToString } from 'react-dom/server';

const dummyPage: PageModel = {
  id: 'page-1',
  widthPt: 300,
  heightPt: 300,
  rotation: 0,
  objects: [],
};

const dummyRender: RenderResult = {
  width: 375,
  height: 375,
  stride: 1500,
  format: 'rgba',
  pixels: new ArrayBuffer(0),
  revision: 0,
};

describe('PdfLinkLayer', () => {
  it('renders only genuine internal links pointing to known pages in pageOrder', () => {
    const annotations: PdfAnnotationInfo[] = [
      // 1. Valid internal link to page 2
      {
        id: 'link-1',
        pageId: 'page-1',
        subtype: 'link',
        bounds: { x: 20, y: 70, width: 100, height: 30 },
        text: '',
        color: [0, 0, 0],
        opacity: 1,
        targetPageId: 'page-2',
        targetTopPt: 250,
      },
      // 2. Link with non-existent targetPageId (broken link)
      {
        id: 'link-broken',
        pageId: 'page-1',
        subtype: 'link',
        bounds: { x: 20, y: 110, width: 100, height: 30 },
        text: '',
        color: [0, 0, 0],
        opacity: 1,
        targetPageId: 'page-nonexistent',
      },
      // 3. Link without targetPageId (e.g. external URI or unsupported action)
      {
        id: 'link-external',
        pageId: 'page-1',
        subtype: 'link',
        bounds: { x: 20, y: 150, width: 100, height: 30 },
        text: '',
        color: [0, 0, 0],
        opacity: 1,
      },
      // 4. Highlight annotation (not a link)
      {
        id: 'annot-hl',
        pageId: 'page-1',
        subtype: 'highlight',
        bounds: { x: 20, y: 190, width: 100, height: 30 },
        text: 'Important',
        color: [1, 1, 0],
        opacity: 0.5,
      },
    ];

    const pageOrder = ['page-1', 'page-2', 'page-3'];
    const onNavigate = vi.fn();

    const element = React.createElement(PdfLinkLayer, {
      annotations,
      page: dummyPage,
      render: dummyRender,
      pageOrder,
      disabled: false,
      onNavigate,
    });

    const html = renderToString(element);

    // Only 1 link button rendered
    expect(html).toContain('pdf-link-annotation');
    expect(html).toContain('data-target-page-id="page-2"');
    expect(html).toContain('data-target-page-number="2"');
    expect(html).toContain('aria-label="Go to page 2"');

    // Broken and external links are NOT rendered
    expect(html).not.toContain('page-nonexistent');
    expect(html).not.toContain('link-external');
    expect(html).not.toContain('annot-hl');
  });

  it('renders nothing when no internal links exist', () => {
    const annotations: PdfAnnotationInfo[] = [
      {
        id: 'external-only',
        pageId: 'page-1',
        subtype: 'link',
        bounds: { x: 20, y: 20, width: 50, height: 20 },
        text: '',
        color: [0, 0, 0],
        opacity: 1,
      },
    ];

    const element = React.createElement(PdfLinkLayer, {
      annotations,
      page: dummyPage,
      render: dummyRender,
      pageOrder: ['page-1', 'page-2'],
      onNavigate: vi.fn(),
    });

    const html = renderToString(element);
    expect(html).toBe('');
  });
});
