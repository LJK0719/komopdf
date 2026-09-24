import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  AI_FEATURES, AI_TEMPLATE_VERSION, PROTOCOL_VERSION, aiRequestSchema, createEnvelope,
  type AiRequest, type AiUsage,
} from '@pdf-editor/contracts';
import { AdmissionController, type AdmissionLease } from './admission.js';
import {
  AnthropicMessagesProxy, AnthropicProxyError,
  type AnthropicEndpoint, type AnthropicForwarder,
} from './anthropic.js';
import type { GatewayConfig } from './config.js';
import { GeminiNativeAdapter, ProviderError } from './gemini.js';
import { ImageValidationError, validateImages } from './images.js';
import type { ProviderAdapter } from './provider-types.js';
import { extractAnswerTextPrefix, finishSse, sendEvent, sendEventBestEffort, splitUtf8, startSse } from './sse.js';
import { prepareProviderInput } from './templates.js';
import { OutputValidationError, parseAndValidateResult } from './validation.js';

const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { error: { type: 'object', additionalProperties: false, properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] } },
  required: ['error'],
} as const;
const REQUEST_BODY_SCHEMA = { type: 'object' } as const;
const OUTBOUND_DELTA_BYTES = 16 * 1024;

export type RuntimeLogRecord = {
  event: 'ai_request';
  timestamp: string;
  requestIdHash: string;
  feature: string;
  protocolVersion: number;
  templateVersion: string;
  model: string;
  durationMs: number;
  status: string;
  finishReason: string | null;
  usage: AiUsage | null;
  hasImage: boolean;
  errorCode?: string | null;
  upstreamStatus?: number;
};

export type GatewayRuntimeLogger = { write(record: RuntimeLogRecord): void };
export type BuildGatewayOptions = {
  config: GatewayConfig;
  apiKey?: string;
  provider?: ProviderAdapter;
  agentProxy?: AnthropicForwarder;
  runtimeLogger?: GatewayRuntimeLogger;
};

class RequestTimeoutError extends Error {
  constructor() { super('Request processing timed out'); this.name = 'RequestTimeoutError'; }
}
class ClientCancelledError extends Error {
  constructor() { super('Client disconnected'); this.name = 'ClientCancelledError'; }
}
class IncompleteOutputError extends Error {
  constructor() { super('Model output did not complete'); this.name = 'IncompleteOutputError'; }
}
class AgentRequestError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentRequestError'; }
}

const stdoutLogger: GatewayRuntimeLogger = {
  write(record) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  },
};

function isLoopback(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  return normalized === '::1' || normalized.startsWith('127.');
}

function publicLimits(config: GatewayConfig): Record<string, number> {
  const limits = config.limits;
  return {
    inFlight: limits.inFlight,
    imageInFlight: limits.imageInFlight,
    perIpInFlight: limits.perIpInFlight,
    perIpPerMinute: limits.perIpPerMinute,
    textBodyBytes: limits.textBodyBytes,
    imageBodyBytes: limits.imageBodyBytes,
    imageCount: limits.imageCount,
    imageFileBytes: limits.imageFileBytes,
    imageLongestEdge: limits.imageLongestEdge,
    connectTimeoutMs: limits.connectTimeoutMs,
    requestTimeoutMs: limits.requestTimeoutMs,
    upstreamBytes: limits.upstreamFrameBytes,
    visibleResultBytes: limits.visibleResultBytes,
    maxOutputTokens: limits.maxOutputTokens,
  };
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

type AnthropicErrorType = 'invalid_request_error' | 'rate_limit_error' | 'api_error' | 'overloaded_error';
type PreparedAgentRequest = { body: Buffer; stream: boolean; hasImage: boolean };

function anthropicErrorBody(type: AnthropicErrorType, message: string): { type: 'error'; error: { type: AnthropicErrorType; message: string } } {
  return { type: 'error', error: { type, message } };
}

function rawJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    try {
      response.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
      response.end();
    } catch {
      if (!response.destroyed) response.destroy();
    }
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-length', String(payload.byteLength));
  response.end(payload);
}

function requestHeader(value: string | string[] | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw new AgentRequestError(`Multiple ${name} headers are not accepted`);
  return value;
}

function forwardedAnthropicHeaders(request: FastifyRequest): { version?: string; beta?: string } {
  const version = requestHeader(request.headers['anthropic-version'], 'anthropic-version');
  const beta = requestHeader(request.headers['anthropic-beta'], 'anthropic-beta');
  if (version && (version.length > 64 || !/^\d{4}-\d{2}-\d{2}$/.test(version))) {
    throw new AgentRequestError('Invalid anthropic-version header');
  }
  if (beta && (beta.length > 4096 || !/^[A-Za-z0-9.,_ -]+$/.test(beta))) {
    throw new AgentRequestError('Invalid anthropic-beta header');
  }
  return { ...(version ? { version } : {}), ...(beta ? { beta } : {}) };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

function scanAgentContent(value: unknown, config: GatewayConfig, state: { images: number; totalBytes: number }): void {
  if (typeof value === 'string' || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) scanAgentContent(item, config, state);
    return;
  }
  const block = record(value);
  if (!block) return;
  if (block.type === 'document') throw new AgentRequestError('Raw document attachments are not accepted');
  if (block.type === 'image') {
    state.images += 1;
    if (state.images > config.limits.imageCount) throw new AgentRequestError('Too many image attachments');
    const source = record(block.source);
    if (source?.media_type === 'application/pdf') throw new AgentRequestError('PDF attachments are not accepted');
    if (source?.type !== 'base64') throw new AgentRequestError('Only inline base64 image sources are accepted');
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(source.media_type))) {
      throw new AgentRequestError('Unsupported image media type');
    }
    if (typeof source.data !== 'string') throw new AgentRequestError('Invalid base64 image source');
    const bytes = base64Bytes(source.data);
    if (bytes > config.limits.imageFileBytes) throw new AgentRequestError('Image attachment exceeds size limit');
    state.totalBytes += bytes;
    if (state.totalBytes > config.limits.imageFileBytes) throw new AgentRequestError('Total image attachments exceed size limit');
    return;
  }
  if (block.type === 'tool_result') scanAgentContent(block.content, config, state);
}

function prepareAgentRequest(body: unknown, endpoint: AnthropicEndpoint, config: GatewayConfig): PreparedAgentRequest {
  const source = record(body);
  if (!source) throw new AgentRequestError('Request body must be a JSON object');
  if (source.fallbacks !== undefined) throw new AgentRequestError('Model fallbacks are not available on this endpoint');
  if (source.mcp_servers !== undefined || source.container !== undefined) {
    throw new AgentRequestError('Remote tool runtimes are not available on this endpoint');
  }
  if (Array.isArray(source.tools)) {
    for (const tool of source.tools) {
      if (record(tool)?.type !== undefined) throw new AgentRequestError('Server-side tools are not available on this endpoint');
    }
  }
  if (endpoint === 'messages') {
    if (!Number.isSafeInteger(source.max_tokens) || (source.max_tokens as number) <= 0) {
      throw new AgentRequestError('max_tokens must be a positive integer');
    }
    if ((source.max_tokens as number) > config.limits.agentMaxOutputTokens) {
      throw new AgentRequestError(`max_tokens exceeds the service limit of ${config.limits.agentMaxOutputTokens}`);
    }
    if (source.stream !== undefined && typeof source.stream !== 'boolean') throw new AgentRequestError('stream must be a boolean');
  }
  const scan = { images: 0, totalBytes: 0 };
  const messages = Array.isArray(source.messages) ? source.messages : [];
  for (const message of messages) scanAgentContent(record(message)?.content, config, scan);
  scanAgentContent(source.system, config, scan);
  const forwarded = { ...source, model: config.provider.model };
  return {
    body: Buffer.from(JSON.stringify(forwarded), 'utf8'),
    stream: endpoint === 'messages' && source.stream === true,
    hasImage: scan.images > 0,
  };
}

function safeAgentProxyError(error: unknown, timeout: boolean): { statusCode: number; type: AnthropicErrorType; message: string; status: string } {
  if (timeout) return { statusCode: 504, type: 'overloaded_error', message: 'AI request processing timed out', status: 'timeout' };
  if (error instanceof AnthropicProxyError) {
    if (error.code === 'CONNECT_TIMEOUT') {
      return { statusCode: 504, type: 'overloaded_error', message: 'Temporarily unable to connect to AI service', status: 'upstream_timeout' };
    }
    if (error.code === 'UPSTREAM_HTTP') {
      const upstreamStatus = error.upstreamStatus ?? 502;
      const statusCode = [400, 404, 405, 409, 413, 422, 429, 501].includes(upstreamStatus) ? upstreamStatus : 502;
      const type: AnthropicErrorType = statusCode === 429 ? 'rate_limit_error' : statusCode >= 500 ? 'api_error' : 'invalid_request_error';
      return { statusCode, type, message: `Upstream returned HTTP ${upstreamStatus}`, status: 'upstream_error' };
    }
    if (error.code === 'UPSTREAM_LIMIT') {
      return { statusCode: 502, type: 'api_error', message: 'Upstream response exceeded the service limit', status: 'upstream_limit' };
    }
  }
  return { statusCode: 502, type: 'api_error', message: 'AI service temporarily unavailable', status: 'upstream_error' };
}

async function usageEvent(response: ServerResponse, usage: AiUsage | null, reason: string, signal: AbortSignal): Promise<void> {
  if (usage) await sendEvent(response, { type: 'usage', usage }, signal);
  else await sendEvent(response, { type: 'usage', usage: null, reason }, signal);
}

function usageEventBestEffort(response: ServerResponse, usage: AiUsage | null, reason: string): void {
  if (usage) sendEventBestEffort(response, { type: 'usage', usage });
  else sendEventBestEffort(response, { type: 'usage', usage: null, reason });
}

function safeError(error: unknown, timeout: boolean): { code: string; message: string; status: string } {
  if (timeout) return { code: 'REQUEST_TIMEOUT', message: 'AI request processing timed out', status: 'timeout' };
  if (error instanceof IncompleteOutputError || error instanceof OutputValidationError) {
    return { code: 'INVALID_MODEL_OUTPUT', message: 'Model did not return a safe and complete result', status: 'invalid_output' };
  }
  if (error instanceof ProviderError && error.code === 'CONNECT_TIMEOUT') {
    return { code: 'UPSTREAM_TIMEOUT', message: 'Temporarily unable to connect to AI service', status: 'upstream_timeout' };
  }
  return { code: 'UPSTREAM_UNAVAILABLE', message: 'AI service temporarily unavailable', status: 'upstream_error' };
}

function parseRequest(body: unknown, imageRoute: boolean, config: GatewayConfig): AiRequest {
  const parsed = aiRequestSchema.safeParse(body);
  if (!parsed.success) throw new ImageValidationError('Request body does not conform to AI protocol');
  const request = parsed.data;
  const hasImages = (request.context.images?.length ?? 0) > 0;
  if (hasImages !== imageRoute) {
    throw new ImageValidationError(imageRoute ? 'Image request must contain images' : 'Requests with images must use the image route');
  }
  validateImages(request, config.limits);
  return request;
}

export function buildGateway(options: BuildGatewayOptions): FastifyInstance {
  const provider = options.provider ?? (options.apiKey ? new GeminiNativeAdapter(options.config, options.apiKey) : undefined);
  if (!provider) throw new Error('Must provide provider or apiKey');
  const agentProxy = options.agentProxy ?? (options.apiKey ? new AnthropicMessagesProxy(options.config, options.apiKey) : undefined);
  const runtimeLogger = options.runtimeLogger ?? stdoutLogger;
  const admission = new AdmissionController(options.config.limits);
  const leases = new WeakMap<FastifyRequest, AdmissionLease>();
  const admittedAt = new WeakMap<FastifyRequest, number>();
  const app = Fastify({
    logger: false,
    bodyLimit: Math.max(options.config.limits.imageBodyBytes, options.config.limits.agentBodyBytes),
    requestTimeout: options.config.limits.requestTimeoutMs,
    trustProxy: (address, hop) => hop === 0 && isLoopback(address),
  });

  const release = (request: FastifyRequest): void => {
    leases.get(request)?.release();
    leases.delete(request);
    admittedAt.delete(request);
  };
  app.addHook('onResponse', async request => release(request));
  app.addHook('onError', async request => release(request));
  app.setErrorHandler((error, request, reply) => {
    release(request);
    const agentRoute = request.url.startsWith('/api/agent/');
    const code = (error as { code?: string }).code;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      void reply.code(413).send(agentRoute
        ? anthropicErrorBody('invalid_request_error', 'Request body exceeds size limit')
        : errorBody('BODY_TOO_LARGE', 'Request body exceeds size limit'));
      return;
    }
    const statusCode = (error as { statusCode?: number }).statusCode === 415 ? 415 : 400;
    void reply.code(statusCode).send(agentRoute
      ? anthropicErrorBody('invalid_request_error', statusCode === 415 ? 'Only application/json requests are accepted' : 'Invalid request content')
      : errorBody(statusCode === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'INVALID_REQUEST', 'Invalid request content'));
  });

  const admissionHook = (image: boolean, agent = false) => async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (agent) {
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        await reply.code(415).send(anthropicErrorBody('invalid_request_error', 'Only application/json requests are accepted'));
        return;
      }
    }
    const encoding = request.headers['content-encoding'];
    if (encoding && encoding.toLowerCase() !== 'identity') {
      await reply.code(415).send(agent
        ? anthropicErrorBody('invalid_request_error', 'Compressed request bodies are not accepted')
        : errorBody('CONTENT_ENCODING_NOT_ALLOWED', 'Compressed request body is not accepted'));
      return;
    }
    const result = admission.acquire(request.ip, image);
    if (!result.ok) {
      await reply.code(result.statusCode).send(agent
        ? anthropicErrorBody(result.statusCode === 429 ? 'rate_limit_error' : 'overloaded_error', result.message)
        : errorBody(result.code, result.message));
      return;
    }
    leases.set(request, result);
    admittedAt.set(request, Date.now());
    reply.raw.once('close', result.release);
  };

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/v1/capabilities', async () => ({
    protocolVersion: PROTOCOL_VERSION,
    templateVersion: AI_TEMPLATE_VERSION,
    features: AI_FEATURES,
    model: { id: options.config.provider.model, displayName: options.config.provider.displayName },
    limits: publicLimits(options.config),
  }));

  const handle = (imageRoute: boolean) => async (fastifyRequest: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const startedAt = admittedAt.get(fastifyRequest) ?? Date.now();
    let request: AiRequest;
    try {
      request = parseRequest(fastifyRequest.body, imageRoute, options.config);
    } catch (error) {
      const message = error instanceof ImageValidationError ? error.message : 'Invalid request content';
      await reply.code(400).send(errorBody('INVALID_REQUEST', message));
      return;
    }
    const remainingMs = options.config.limits.requestTimeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      await reply.code(504).send(errorBody('REQUEST_TIMEOUT', 'AI request processing timed out'));
      return;
    }

    const prepared = prepareProviderInput(request, options.config.limits.maxOutputTokens);
    const controller = new AbortController();
    let clientCancelled = false;
    let finishReason: string | null = null;
    let observedUsage: AiUsage | null = null;
    let status = 'started';
    const timeout = setTimeout(() => controller.abort(new RequestTimeoutError()), remainingMs);
    timeout.unref();
    const cancel = (): void => {
      if (reply.raw.writableFinished) return;
      clientCancelled = true;
      controller.abort(new ClientCancelledError());
    };
    fastifyRequest.raw.once('aborted', cancel);
    reply.raw.once('close', cancel);

    reply.hijack();
    startSse(reply.raw);

    try {
      await sendEvent(reply.raw, { type: 'accepted', requestId: request.requestId }, controller.signal);
      await sendEvent(reply.raw, { type: 'progress', message: 'Processing request' }, controller.signal);
      let rawResult = '';
      let emittedText = '';
      if (request.feature === 'document.ask') {
        let resultBytes = 0;
        for await (const event of provider.stream(prepared.input, controller.signal)) {
          if (event.type === 'text') {
            resultBytes += Buffer.byteLength(event.text, 'utf8');
            if (resultBytes > options.config.limits.visibleResultBytes) throw new OutputValidationError('Model visible result exceeds size limit');
            rawResult += event.text;
            const visiblePrefix = extractAnswerTextPrefix(rawResult);
            if (visiblePrefix !== null) {
              if (!visiblePrefix.startsWith(emittedText)) throw new OutputValidationError('Streaming answer prefix mismatch');
              const delta = visiblePrefix.slice(emittedText.length);
              for (const chunk of splitUtf8(delta, OUTBOUND_DELTA_BYTES)) {
                await sendEvent(reply.raw, { type: 'delta', text: chunk }, controller.signal);
              }
              emittedText = visiblePrefix;
            }
          } else if (event.type === 'finish') finishReason = event.finishReason;
          else observedUsage = event.usage;
        }
      } else {
        const generated = await provider.generate(prepared.input, controller.signal);
        rawResult = generated.text;
        finishReason = generated.finishReason;
        observedUsage = generated.usage;
      }

      if (finishReason !== 'STOP') throw new IncompleteOutputError();
      const result = parseAndValidateResult(
        rawResult,
        request,
        prepared.expectedKind,
        prepared.allowedCommands,
        options.config.limits.visibleResultBytes,
      );
      if (request.feature === 'document.ask' && result.kind === 'answer') {
        if (!result.text.startsWith(emittedText)) throw new OutputValidationError('Full answer does not match streaming answer');
        for (const chunk of splitUtf8(result.text.slice(emittedText.length), OUTBOUND_DELTA_BYTES)) {
          await sendEvent(reply.raw, { type: 'delta', text: chunk }, controller.signal);
        }
      }
      await sendEvent(reply.raw, { type: 'result', response: createEnvelope(request, result) }, controller.signal);
      await usageEvent(reply.raw, observedUsage, 'Upstream did not return usage', controller.signal);
      await sendEvent(reply.raw, { type: 'done', requestId: request.requestId }, controller.signal);
      status = 'ok';
    } catch (error) {
      const timeoutReached = controller.signal.reason instanceof RequestTimeoutError;
      if (clientCancelled || controller.signal.reason instanceof ClientCancelledError) {
        status = 'cancelled';
      } else {
        const safe = safeError(error, timeoutReached);
        status = safe.status;
        if (timeoutReached) {
          usageEventBestEffort(reply.raw, observedUsage, 'Request incomplete; upstream usage not acquired');
          sendEventBestEffort(reply.raw, { type: 'error', code: safe.code, message: safe.message });
        } else {
          try {
            await usageEvent(reply.raw, observedUsage, 'Request incomplete; upstream usage not acquired', controller.signal);
            await sendEvent(reply.raw, { type: 'error', code: safe.code, message: safe.message }, controller.signal);
          } catch {
            if (clientCancelled || controller.signal.reason instanceof ClientCancelledError) status = 'cancelled';
            else if (controller.signal.reason instanceof RequestTimeoutError) status = 'timeout';
          }
        }
      }
    } finally {
      try {
        await finishSse(reply.raw, controller.signal);
      } catch {
        if (controller.signal.reason instanceof RequestTimeoutError) status = 'timeout';
        else if (clientCancelled || controller.signal.reason instanceof ClientCancelledError) status = 'cancelled';
        else if (status === 'ok') status = 'downstream_error';
      }
      clearTimeout(timeout);
      fastifyRequest.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', cancel);
      release(fastifyRequest);
      runtimeLogger.write({
        event: 'ai_request',
        timestamp: new Date().toISOString(),
        requestIdHash: createHash('sha256').update(request.requestId).digest('hex').slice(0, 16),
        feature: request.feature,
        protocolVersion: request.protocolVersion,
        templateVersion: AI_TEMPLATE_VERSION,
        model: options.config.provider.model,
        durationMs: Date.now() - startedAt,
        status,
        finishReason,
        usage: observedUsage,
        hasImage: imageRoute,
      });
    }
  };

  const handleAgent = (endpoint: AnthropicEndpoint) => async (fastifyRequest: FastifyRequest, reply: FastifyReply): Promise<void> => {
    let errorCode: string | null = null;
    let upstreamStatus: number | undefined;
    const startedAt = admittedAt.get(fastifyRequest) ?? Date.now();
    if (!agentProxy) {
      await reply.code(503).send(anthropicErrorBody('overloaded_error', 'Agent model service is not configured'));
      return;
    }
    let prepared: PreparedAgentRequest;
    let headers: { version?: string; beta?: string };
    try {
      prepared = prepareAgentRequest(fastifyRequest.body, endpoint, options.config);
      headers = forwardedAnthropicHeaders(fastifyRequest);
    } catch (error) {
      const message = error instanceof AgentRequestError ? error.message : 'Invalid request content';
      await reply.code(400).send(anthropicErrorBody('invalid_request_error', message));
      return;
    }
    const remainingMs = options.config.limits.requestTimeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      await reply.code(504).send(anthropicErrorBody('overloaded_error', 'AI request processing timed out'));
      return;
    }

    const controller = new AbortController();
    let clientCancelled = false;
    let finishReason: string | null = null;
    let observedUsage: AiUsage | null = null;
    let status = 'started';
    const timeout = setTimeout(() => controller.abort(new RequestTimeoutError()), remainingMs);
    timeout.unref();
    const cancel = (): void => {
      if (reply.raw.writableFinished) return;
      clientCancelled = true;
      controller.abort(new ClientCancelledError());
    };
    fastifyRequest.raw.once('aborted', cancel);
    reply.raw.once('close', cancel);
    reply.hijack();

    try {
      const result = await agentProxy.forward({
        endpoint,
        body: prepared.body,
        headers,
        stream: prepared.stream,
        signal: controller.signal,
        response: reply.raw,
      });
      observedUsage = result.usage;
      finishReason = result.finishReason;
      status = result.streamError ? 'upstream_error' : 'ok';
      errorCode = result.errorType ?? null;
    } catch (error) {
      if (error instanceof AnthropicProxyError) {
        errorCode = error.code; upstreamStatus = error.upstreamStatus;
      } else if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(error.code)) {
        errorCode = error.code;
      }
      const timeoutReached = controller.signal.reason instanceof RequestTimeoutError;
      if (timeoutReached) {
        const safe = safeAgentProxyError(error, true);
        status = safe.status;
        rawJson(reply.raw, safe.statusCode, anthropicErrorBody(safe.type, safe.message));
      } else if (clientCancelled || controller.signal.reason instanceof ClientCancelledError) {
        status = 'cancelled';
      } else {
        const safe = safeAgentProxyError(error, false);
        status = safe.status;
        rawJson(reply.raw, safe.statusCode, anthropicErrorBody(safe.type, safe.message));
      }
    } finally {
      clearTimeout(timeout);
      fastifyRequest.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', cancel);
      release(fastifyRequest);
      runtimeLogger.write({
        event: 'ai_request',
        timestamp: new Date().toISOString(),
        requestIdHash: createHash('sha256').update(String(fastifyRequest.id)).digest('hex').slice(0, 16),
        feature: endpoint === 'messages' ? 'agent.messages' : 'agent.count_tokens',
        protocolVersion: 1,
        templateVersion: 'anthropic-v1',
        model: options.config.provider.model,
        durationMs: Date.now() - startedAt,
        status,
        finishReason,
        usage: observedUsage,
        hasImage: prepared.hasImage,
        errorCode,
        ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
      });
    }
  };

  app.post('/api/agent/v1/messages', {
    bodyLimit: options.config.limits.agentBodyBytes,
    onRequest: admissionHook(true, true),
    schema: { body: REQUEST_BODY_SCHEMA },
  }, handleAgent('messages'));
  app.post('/api/agent/v1/messages/count_tokens', {
    bodyLimit: options.config.limits.agentBodyBytes,
    onRequest: admissionHook(true, true),
    schema: { body: REQUEST_BODY_SCHEMA },
  }, handleAgent('count_tokens'));

  app.post('/api/v1/ai/requests', {
    bodyLimit: options.config.limits.textBodyBytes,
    onRequest: admissionHook(false),
    schema: { body: REQUEST_BODY_SCHEMA, response: { 400: ERROR_RESPONSE_SCHEMA, 413: ERROR_RESPONSE_SCHEMA, 415: ERROR_RESPONSE_SCHEMA, 429: ERROR_RESPONSE_SCHEMA, 503: ERROR_RESPONSE_SCHEMA, 504: ERROR_RESPONSE_SCHEMA } },
  }, handle(false));
  app.post('/api/v1/ai/image-requests', {
    bodyLimit: options.config.limits.imageBodyBytes,
    onRequest: admissionHook(true),
    schema: { body: REQUEST_BODY_SCHEMA, response: { 400: ERROR_RESPONSE_SCHEMA, 413: ERROR_RESPONSE_SCHEMA, 415: ERROR_RESPONSE_SCHEMA, 429: ERROR_RESPONSE_SCHEMA, 503: ERROR_RESPONSE_SCHEMA, 504: ERROR_RESPONSE_SCHEMA } },
  }, handle(true));

  return app;
}
