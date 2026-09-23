import { describe, expect, it } from 'vitest';
import type { AiRequest } from '@pdf-editor/contracts';
import type { GatewayLimits } from '../src/config.js';
import { ImageValidationError, validateImages } from '../src/images.js';

const limits: GatewayLimits = {
  inFlight: 12, imageInFlight: 2, perIpInFlight: 2, perIpPerMinute: 60,
  textBodyBytes: 512 * 1024, imageBodyBytes: 3 * 1024 * 1024, agentBodyBytes: 3 * 1024 * 1024,
  imageCount: 2, imageFileBytes: 2 * 1024 * 1024, imageLongestEdge: 1536,
  connectTimeoutMs: 10_000, requestTimeoutMs: 180_000,
  upstreamFrameBytes: 1024 * 1024, upstreamStreamBytes: 4 * 1024 * 1024,
  visibleResultBytes: 512 * 1024, maxOutputTokens: 8192, agentMaxOutputTokens: 32_768,
};

function pngHeader(width: number, height: number): string {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}

function imageRequest(mimeType: 'image/png' | 'image/jpeg', data: string): AiRequest {
  return {
    protocolVersion: 1, requestId: 'r', feature: 'image.explain', document: { id: 'd', revision: 0 },
    context: {
      scope: 'selection', evidence: [], images: [{ mimeType, data }],
    },
    instruction: 'explain', options: {},
  };
}

describe('image validation', () => {
  it('accepts a bounded PNG header', () => {
    expect(() => validateImages(imageRequest('image/png', pngHeader(120, 80)), limits)).not.toThrow();
  });

  it('rejects MIME/header mismatches and overlong dimensions', () => {
    expect(() => validateImages(imageRequest('image/jpeg', pngHeader(120, 80)), limits)).toThrow(ImageValidationError);
    expect(() => validateImages(imageRequest('image/png', pngHeader(1537, 1)), limits)).toThrow(/longest edge/);
  });

  it('rejects noncanonical base64', () => {
    expect(() => validateImages(imageRequest('image/png', 'not base64'), limits)).toThrow(/base64/);
  });
});
