import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { PageModel, RenderResult } from '@pdf-editor/contracts';
import { ObjectSelectionLayer } from '../src/ui/ObjectSelectionLayer.js';

const dummyPage: PageModel = {
  id: 'page-1',
  widthPt: 400,
  heightPt: 600,
  rotation: 0,
  objects: [
    {
      id: 'obj-1',
      pageId: 'page-1',
      type: 'path',
      bounds: { x: 50, y: 50, width: 100, height: 80 },
      transform: [1, 0, 0, 1, 0, 0],
      locator: { pageId: 'page-1', containerPath: [], objectIndex: 0 },
    },
    {
      id: 'obj-2',
      pageId: 'page-1',
      type: 'text',
      bounds: { x: 200, y: 150, width: 80, height: 40 },
      transform: [1, 0, 0, 1, 0, 0],
      locator: { pageId: 'page-1', containerPath: [], objectIndex: 1 },
    },
  ],
};

const dummyRender: RenderResult = {
  width: 500,
  height: 750,
  stride: 2000,
  format: 'rgba',
  pixels: new ArrayBuffer(0),
  revision: 0,
};

describe('ObjectSelectionLayer', () => {
  it('renders no selection box or handles when selectedIds is empty', () => {
    const html = renderToString(
      React.createElement(ObjectSelectionLayer, {
        page: dummyPage,
        render: dummyRender,
        selectedIds: [],
        disabled: false,
        canTransform: true,
        onSelect: vi.fn(),
        onBoxSelect: vi.fn(),
        onEditText: vi.fn(),
        onMove: vi.fn(),
      })
    );

    expect(html).not.toContain('selection-box');
    expect(html).not.toContain('selection-handle');
    expect(html).not.toContain('data-handle="rotate"');
  });

  it('renders bounding box and all 8 scale handles + 1 rotate handle for single object selection', () => {
    const html = renderToString(
      React.createElement(ObjectSelectionLayer, {
        page: dummyPage,
        render: dummyRender,
        selectedIds: ['obj-1'],
        disabled: false,
        canTransform: true,
        onSelect: vi.fn(),
        onBoxSelect: vi.fn(),
        onEditText: vi.fn(),
        onMove: vi.fn(),
      })
    );

    expect(html).toContain('selection-box');
    expect(html).toContain('selection-box-outline');
    expect(html).toContain('selection-rotate-stem');
    expect(html).toContain('data-handle="rotate"');
    expect(html).toContain('aria-label="Rotate selected objects"');

    const expectedHandles = [
      'scale-nw', 'scale-n', 'scale-ne', 'scale-e',
      'scale-se', 'scale-s', 'scale-sw', 'scale-w',
    ];
    for (const h of expectedHandles) {
      expect(html).toContain(`data-handle="${h}"`);
    }
  });

  it('renders unified selection box and handles for multi-object selection', () => {
    const html = renderToString(
      React.createElement(ObjectSelectionLayer, {
        page: dummyPage,
        render: dummyRender,
        selectedIds: ['obj-1', 'obj-2'],
        disabled: false,
        canTransform: true,
        onSelect: vi.fn(),
        onBoxSelect: vi.fn(),
        onEditText: vi.fn(),
        onMove: vi.fn(),
      })
    );

    expect(html).toContain('selection-box');
    expect(html).toContain('data-handle="rotate"');
    expect(html).toContain('data-handle="scale-nw"');
    expect(html).toContain('data-handle="scale-se"');
  });

  it('omits transform handles when canTransform is false', () => {
    const html = renderToString(
      React.createElement(ObjectSelectionLayer, {
        page: dummyPage,
        render: dummyRender,
        selectedIds: ['obj-1'],
        disabled: false,
        canTransform: false,
        onSelect: vi.fn(),
        onBoxSelect: vi.fn(),
        onEditText: vi.fn(),
        onMove: vi.fn(),
      })
    );

    expect(html).toContain('selection-box');
    expect(html).not.toContain('selection-handle');
    expect(html).not.toContain('data-handle="rotate"');
  });

  it('disables handles when disabled prop is true', () => {
    const html = renderToString(
      React.createElement(ObjectSelectionLayer, {
        page: dummyPage,
        render: dummyRender,
        selectedIds: ['obj-1'],
        disabled: true,
        canTransform: true,
        onSelect: vi.fn(),
        onBoxSelect: vi.fn(),
        onEditText: vi.fn(),
        onMove: vi.fn(),
      })
    );

    expect(html).toContain('selection-handle');
    expect(html).toContain('disabled=""');
  });
});
