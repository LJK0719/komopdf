import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_LIMITS, AI_MODEL } from '@pdf-editor/contracts';

export type GatewayLimits = {
  inFlight: number;
  imageInFlight: number;
  perIpInFlight: number;
  perIpPerMinute: number;
  textBodyBytes: number;
  imageBodyBytes: number;
  agentBodyBytes: number;
  imageCount: number;
  imageFileBytes: number;
  imageLongestEdge: number;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  upstreamFrameBytes: number;
  upstreamStreamBytes: number;
  visibleResultBytes: number;
  maxOutputTokens: number;
  agentMaxOutputTokens: number;
};

export type GatewayConfig = {
  provider: {
    baseUrl: string;
    model: typeof AI_MODEL;
    displayName: string;
  };
  credentialName: string;
  limits: GatewayLimits;
};

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../gateway.config.json', import.meta.url));

const DEFAULT_LIMITS: GatewayLimits = {
  inFlight: AI_LIMITS.inFlight,
  imageInFlight: AI_LIMITS.imageInFlight,
  perIpInFlight: AI_LIMITS.perIpInFlight,
  perIpPerMinute: AI_LIMITS.perIpPerMinute,
  textBodyBytes: AI_LIMITS.textBodyBytes,
  imageBodyBytes: AI_LIMITS.imageBodyBytes,
  agentBodyBytes: AI_LIMITS.imageBodyBytes,
  imageCount: AI_LIMITS.imageCount,
  imageFileBytes: AI_LIMITS.imageFileBytes,
  imageLongestEdge: AI_LIMITS.imageLongestEdge,
  connectTimeoutMs: AI_LIMITS.connectTimeoutMs,
  requestTimeoutMs: AI_LIMITS.requestTimeoutMs,
  upstreamFrameBytes: AI_LIMITS.upstreamBytes,
  upstreamStreamBytes: AI_LIMITS.upstreamBytes * 4,
  visibleResultBytes: AI_LIMITS.visibleResultBytes,
  maxOutputTokens: AI_LIMITS.maxOutputTokens,
  agentMaxOutputTokens: 32_768,
};

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid config field: ${key}`);
  return value;
}

function positiveInteger(record: Record<string, unknown>, key: keyof GatewayLimits, fallback: number): number {
  const value = record[key] ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`Invalid config limit: ${key}`);
  return value as number;
}

export async function loadGatewayConfig(path = DEFAULT_CONFIG_PATH): Promise<GatewayConfig> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const root = asRecord(raw, 'Config');
  const provider = asRecord(root.provider, 'provider');
  const limits = asRecord(root.limits ?? {}, 'limits');
  const baseUrl = new URL(stringField(provider, 'baseUrl'));
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('provider.baseUrl must be an HTTPS URL without credentials, query parameters, or hash');
  }
  const model = stringField(provider, 'model');
  if (model !== AI_MODEL) throw new Error(`provider.model must be ${AI_MODEL}`);
  const credentialName = stringField(root, 'credentialName');
  if (credentialName.includes('/') || credentialName.includes('\\')) throw new Error('credentialName cannot contain path separators');

  return {
    provider: {
      baseUrl: baseUrl.toString().replace(/\/$/, ''),
      model,
      displayName: stringField(provider, 'displayName'),
    },
    credentialName,
    limits: {
      inFlight: positiveInteger(limits, 'inFlight', DEFAULT_LIMITS.inFlight),
      imageInFlight: positiveInteger(limits, 'imageInFlight', DEFAULT_LIMITS.imageInFlight),
      perIpInFlight: positiveInteger(limits, 'perIpInFlight', DEFAULT_LIMITS.perIpInFlight),
      perIpPerMinute: positiveInteger(limits, 'perIpPerMinute', DEFAULT_LIMITS.perIpPerMinute),
      textBodyBytes: positiveInteger(limits, 'textBodyBytes', DEFAULT_LIMITS.textBodyBytes),
      imageBodyBytes: positiveInteger(limits, 'imageBodyBytes', DEFAULT_LIMITS.imageBodyBytes),
      agentBodyBytes: positiveInteger(limits, 'agentBodyBytes', DEFAULT_LIMITS.agentBodyBytes),
      imageCount: positiveInteger(limits, 'imageCount', DEFAULT_LIMITS.imageCount),
      imageFileBytes: positiveInteger(limits, 'imageFileBytes', DEFAULT_LIMITS.imageFileBytes),
      imageLongestEdge: positiveInteger(limits, 'imageLongestEdge', DEFAULT_LIMITS.imageLongestEdge),
      connectTimeoutMs: positiveInteger(limits, 'connectTimeoutMs', DEFAULT_LIMITS.connectTimeoutMs),
      requestTimeoutMs: positiveInteger(limits, 'requestTimeoutMs', DEFAULT_LIMITS.requestTimeoutMs),
      upstreamFrameBytes: positiveInteger(limits, 'upstreamFrameBytes', DEFAULT_LIMITS.upstreamFrameBytes),
      upstreamStreamBytes: positiveInteger(limits, 'upstreamStreamBytes', DEFAULT_LIMITS.upstreamStreamBytes),
      visibleResultBytes: positiveInteger(limits, 'visibleResultBytes', DEFAULT_LIMITS.visibleResultBytes),
      maxOutputTokens: positiveInteger(limits, 'maxOutputTokens', DEFAULT_LIMITS.maxOutputTokens),
      agentMaxOutputTokens: positiveInteger(limits, 'agentMaxOutputTokens', DEFAULT_LIMITS.agentMaxOutputTokens),
    },
  };
}

export async function readCredential(config: GatewayConfig, credentialFile?: string): Promise<string> {
  const systemdDirectory = process.env.CREDENTIALS_DIRECTORY;
  const path = credentialFile
    ? (isAbsolute(credentialFile) ? credentialFile : join(process.cwd(), credentialFile))
    : systemdDirectory
      ? join(systemdDirectory, config.credentialName)
      : undefined;
  if (!path) throw new Error('Missing credential: use --credential-file or provide via systemd credentials');
  const content = (await readFile(path, 'utf8')).trim();
  let value = content;
  // 开发机直接读取既有 vault JSON；生产继续支持 systemd 的单行凭证。
  if (content.startsWith('{')) {
    let credential: Record<string, unknown>;
    try { credential = asRecord(JSON.parse(content), 'Credential'); }
    catch { throw new Error('Invalid credential JSON'); }
    if (typeof credential.api_key !== 'string' ||
        (credential.base_url !== undefined && credential.base_url !== config.provider.baseUrl) ||
        (credential.model !== undefined && credential.model !== config.provider.model)) {
      throw new Error('Credential does not match current model configuration');
    }
    value = credential.api_key.trim();
  }
  if (!value || /[\r\n]/.test(value)) throw new Error('Invalid credential file content');
  return value;
}
