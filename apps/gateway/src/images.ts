import type { AiRequest } from '@pdf-editor/contracts';
import type { GatewayLimits } from './config.js';

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function decodeBase64(value: string): Buffer {
  if (!value || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new ImageValidationError('Image must use standard base64 encoding');
  }
  return Buffer.from(value, 'base64');
}

function pngDimensions(bytes: Buffer): [number, number] {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ImageValidationError('Invalid PNG file header');
  }
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function jpegDimensions(bytes: Buffer): [number, number] {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new ImageValidationError('Invalid JPEG file header');
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) break;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return [width, height];
    }
    offset += length;
  }
  throw new ImageValidationError('Invalid JPEG dimensions header');
}

export function validateImages(request: AiRequest, limits: GatewayLimits): void {
  const images = request.context.images ?? [];
  if (images.length > limits.imageCount) throw new ImageValidationError(`Image count cannot exceed ${limits.imageCount}`);
  let totalBytes = 0;
  for (const image of images) {
    const bytes = decodeBase64(image.data);
    totalBytes += bytes.byteLength;
    if (totalBytes > limits.imageFileBytes) throw new ImageValidationError('Total compressed image file bytes exceed limit');
    const [width, height] = image.mimeType === 'image/png' ? pngDimensions(bytes) : jpegDimensions(bytes);
    if (width <= 0 || height <= 0 || Math.max(width, height) > limits.imageLongestEdge) {
      throw new ImageValidationError(`Image longest edge cannot exceed ${limits.imageLongestEdge} pixels`);
    }
  }
}
