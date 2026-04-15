/**
 * Chat completions route.
 * Handles both POST /v1/chat/completions and POST /v1/responses.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteRequest } from '../types';
import { classifyRequest, route, RouteExecutionError } from '../router';
import { insertRequestLog } from '../db';
import { randomBytes } from 'crypto';

const AUTO_ROUTE_RETRY_ATTEMPTS = 2;
const AUTO_ROUTE_RETRY_BASE_DELAY_MS = 250;
const HUB_ALIAS_SET = new Set<string>([
  'agent-build',
  'fast-free',
  'strong-free',
  'strong-code',
  'strong-long-context',
  'local-fast',
  'local-strong',
  'premium-code',
  'premium-review',
  'frontier-manual',
  'embeddings-fast',
  'embeddings-strong',
  'rerank-strong',
  'reasoning-free',
]);

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  const handler = makeCompletionHandler(app);

  app.post('/v1/chat/completions', handler);
  app.post('/v1/responses', handler);
}

function getErrorResponseMeta(errMsg: string): { statusCode: number; retryable: boolean } {
  const normalized = errMsg.toLowerCase();

  const isRateLimited =
    normalized.includes('http 429')
    || normalized.includes('status 429')
    || normalized.includes('rate limit')
    || normalized.includes('tokens per minute limit exceeded')
    || normalized.includes('too many tokens processed')
    || normalized.includes('too_many_tokens_error')
    || normalized.includes('token_quota_exceeded')
    || normalized.includes('quota is exhausted')
    || normalized.includes('no remaining')
    || normalized.includes('token headroom');

  if (isRateLimited) {
    return { statusCode: 429, retryable: true };
  }

  if (normalized.includes('context window') || normalized.includes('hard cap') || normalized.includes('max output')) {
    return { statusCode: 400, retryable: false };
  }

  if (normalized.includes('no available providers')) {
    return { statusCode: 503, retryable: true };
  }

  return { statusCode: 500, retryable: false };
}

function isHubAlias(model: string | undefined): boolean {
  return !!model && HUB_ALIAS_SET.has(model.trim());
}

function getAliasRelaxation(alias: string, attempt: number, requestClass: ReturnType<typeof classifyRequest>): string {
  const normalizedAlias = alias.trim();
  if (attempt <= 0) return normalizedAlias;

  if (requestClass === 'repo_scaffold') {
    if (normalizedAlias === 'strong-code') {
      return attempt === 1 ? 'agent-build' : 'strong-free';
    }

    if (normalizedAlias === 'agent-build') {
      return attempt === 1 ? 'strong-free' : 'strong-long-context';
    }
  }

  if (requestClass === 'tiny_text_utility') {
    if (normalizedAlias === 'strong-code' || normalizedAlias === 'strong-free') {
      return attempt === 1 ? 'fast-free' : 'strong-free';
    }
  }

  if (normalizedAlias === 'strong-code') {
    return attempt === 1 ? 'strong-free' : 'fast-free';
  }

  if (normalizedAlias === 'strong-free') {
    return attempt === 1 ? 'fast-free' : 'strong-long-context';
  }

  if (normalizedAlias === 'fast-free') {
    return attempt === 1 ? 'strong-free' : 'strong-long-context';
  }

  return normalizedAlias;
}

function buildRetryRouteRequest(routeReq: RouteRequest, attempt: number): RouteRequest {
  const requestClass = classifyRequest(routeReq);
  const nextReq: RouteRequest = {
    ...routeReq,
    cache_policy: 'bypass',
    stability_level: 'normal',
  };

  const existingHops = typeof routeReq.max_provider_hops === 'number'
    ? Math.floor(routeReq.max_provider_hops)
    : null;
  if (existingHops === null || existingHops < 3) {
    nextReq.max_provider_hops = 3;
  }

  const normalizedModel = typeof routeReq.model === 'string' ? routeReq.model.trim() : '';
  const isPinnedModel = !!normalizedModel && !isHubAlias(normalizedModel);
  if (!isPinnedModel) {
    delete nextReq.preferred_provider;
  }

  if (typeof nextReq.model_alias === 'string' && isHubAlias(nextReq.model_alias)) {
    nextReq.model_alias = getAliasRelaxation(nextReq.model_alias, attempt + 1, requestClass);
  }

  if (!nextReq.model_alias && typeof nextReq.model === 'string' && isHubAlias(nextReq.model)) {
    nextReq.model_alias = getAliasRelaxation(nextReq.model, attempt + 1, requestClass);
    delete nextReq.model;
  }

  if (typeof nextReq.max_tokens === 'number' && nextReq.max_tokens > 1536) {
    nextReq.max_tokens = 1536;
  }

  return nextReq;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCompletionHandler(app: FastifyInstance) {
  return async function completionHandler(
    req: FastifyRequest<{ Body: RouteRequest }>,
    reply: import('fastify').FastifyReply,
  ) {
    const body = req.body;
    const projectId = (req as unknown as { projectId?: string }).projectId ?? null;
    const start = Date.now();
    const requestId = randomBytes(16).toString('hex');

    try {
      const initialRouteReq: RouteRequest = { ...body, project_id: body.project_id ?? projectId ?? undefined };
      const result = await route(initialRouteReq);

      const latencyMs = Date.now() - start;

      // Log the request
      insertRequestLog({
        id: requestId,
        projectId,
        classifiedAs: result.routeDecision.classifiedAs,
        selectedProvider: result.providerId,
        selectedModel: result.upstreamModel,
        qualityTier: result.qualityTier,
        cacheHit: result.cacheHit,
        promptTokens: result.estimatedUsage.promptTokens,
        completionTokens: result.estimatedUsage.completionTokens,
        latencyMs,
        success: true,
        fallbackChain: [result.routeDecision.selectedProvider],
        downgraded: result.warnings.some(w => w.toLowerCase().includes('downgrad')),
        timestamp: Date.now(),
      });

      // Add hub metadata to response
      const hubMeta = {
        _hub: {
          request_id: requestId,
          provider_id: result.providerId,
          upstream_model: result.upstreamModel,
          normalized_alias: result.normalizedAlias,
          quality_tier: result.qualityTier,
          cache_hit: result.cacheHit,
          route_decision: result.routeDecision,
          warnings: result.warnings,
          downgrade_approval_required: result.downgradeApprovalRequired,
          latency_ms: latencyMs,
        },
      };

      if (result.downgradeApprovalRequired) {
        reply.code(202).send({
          ...hubMeta,
          ...result.output as object,
        });
        return;
      }

      if (body.stream && result.streamResponse) {
        // Stream the response
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Hub-Request-Id', requestId);
        reply.raw.setHeader('X-Hub-Provider', result.providerId);
        reply.raw.setHeader('X-Hub-Model', result.upstreamModel);
        reply.raw.setHeader('X-Hub-Quality-Tier', result.qualityTier);

        // Append a final hub metadata comment before [DONE]
        const stream = result.streamResponse;
        stream.pipe(reply.raw, { end: false });
        stream.on('end', () => {
          const finalChunk = `data: ${JSON.stringify({ _hub: hubMeta._hub })}\n\ndata: [DONE]\n\n`;
          reply.raw.end(finalChunk);
          insertRequestLog({
            id: requestId + '-stream',
            projectId,
            classifiedAs: result.routeDecision.classifiedAs,
            selectedProvider: result.providerId,
            selectedModel: result.upstreamModel,
            qualityTier: result.qualityTier,
            cacheHit: false,
            promptTokens: result.estimatedUsage.promptTokens,
            completionTokens: 0,
            latencyMs: Date.now() - start,
            success: true,
            fallbackChain: [result.routeDecision.selectedProvider],
            downgraded: false,
            timestamp: Date.now(),
          });
        });
        stream.on('error', (err) => {
          reply.raw.end();
          app.log.error({ err }, 'Stream error');
        });
        return reply;
      }

      // Non-streaming
      reply.send({
        ...result.output as object,
        ...hubMeta,
      });
    } catch (e: unknown) {
      if (e instanceof Error) {
        let recoveredResult = null as Awaited<ReturnType<typeof route>> | null;
        let currentError: unknown = e;
        let currentReq: RouteRequest = { ...body, project_id: body.project_id ?? projectId ?? undefined };

        for (let attempt = 0; attempt < AUTO_ROUTE_RETRY_ATTEMPTS; attempt++) {
          const errMsg = currentError instanceof Error ? currentError.message : String(currentError);
          const errorMeta = getErrorResponseMeta(errMsg);
          if (!errorMeta.retryable) break;

          currentReq = buildRetryRouteRequest(currentReq, attempt);
          const delayMs = AUTO_ROUTE_RETRY_BASE_DELAY_MS * (attempt + 1);
          app.log.warn({
            requestId,
            attempt: attempt + 1,
            delayMs,
            reason: errMsg.slice(0, 180),
          }, 'Transient route failure; retrying with relaxed fallback settings');
          await delay(delayMs);

          try {
            recoveredResult = await route(currentReq);
            break;
          } catch (retryError) {
            currentError = retryError;
          }
        }

        if (recoveredResult) {
          const latencyMs = Date.now() - start;
          insertRequestLog({
            id: requestId,
            projectId,
            classifiedAs: recoveredResult.routeDecision.classifiedAs,
            selectedProvider: recoveredResult.providerId,
            selectedModel: recoveredResult.upstreamModel,
            qualityTier: recoveredResult.qualityTier,
            cacheHit: recoveredResult.cacheHit,
            promptTokens: recoveredResult.estimatedUsage.promptTokens,
            completionTokens: recoveredResult.estimatedUsage.completionTokens,
            latencyMs,
            success: true,
            fallbackChain: [recoveredResult.routeDecision.selectedProvider],
            downgraded: recoveredResult.warnings.some(w => w.toLowerCase().includes('downgrad')),
            timestamp: Date.now(),
          });

          const hubMeta = {
            _hub: {
              request_id: requestId,
              provider_id: recoveredResult.providerId,
              upstream_model: recoveredResult.upstreamModel,
              normalized_alias: recoveredResult.normalizedAlias,
              quality_tier: recoveredResult.qualityTier,
              cache_hit: recoveredResult.cacheHit,
              route_decision: recoveredResult.routeDecision,
              warnings: recoveredResult.warnings,
              downgrade_approval_required: recoveredResult.downgradeApprovalRequired,
              latency_ms: latencyMs,
            },
          };

          if (body.stream && recoveredResult.streamResponse) {
            reply.raw.setHeader('Content-Type', 'text/event-stream');
            reply.raw.setHeader('Cache-Control', 'no-cache');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.setHeader('X-Hub-Request-Id', requestId);
            reply.raw.setHeader('X-Hub-Provider', recoveredResult.providerId);
            reply.raw.setHeader('X-Hub-Model', recoveredResult.upstreamModel);
            reply.raw.setHeader('X-Hub-Quality-Tier', recoveredResult.qualityTier);

            const stream = recoveredResult.streamResponse;
            stream.pipe(reply.raw, { end: false });
            stream.on('end', () => {
              const finalChunk = `data: ${JSON.stringify({ _hub: hubMeta._hub })}\n\ndata: [DONE]\n\n`;
              reply.raw.end(finalChunk);
            });
            stream.on('error', (err) => {
              reply.raw.end();
              app.log.error({ err }, 'Stream error after auto-retry recovery');
            });
            return reply;
          }

          reply.send({
            ...recoveredResult.output as object,
            ...hubMeta,
          });
          return;
        }

        e = currentError;
      }

      const latencyMs = Date.now() - start;
      const errMsg = e instanceof Error ? e.message : String(e);
      const routeError = e instanceof RouteExecutionError ? e : null;
      const errorMeta = getErrorResponseMeta(errMsg);

      insertRequestLog({
        id: requestId,
        projectId,
        classifiedAs: routeError?.classifiedAs ?? classifyRequest(body),
        selectedProvider: routeError?.selectedProvider ?? 'unknown',
        selectedModel: routeError?.selectedModel ?? 'unknown',
        qualityTier: routeError?.qualityTier ?? 'tier_free_fast',
        cacheHit: false,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs,
        success: false,
        errorCode: errMsg.slice(0, 100),
        fallbackChain: routeError?.fallbackChain ?? [],
        downgraded: false,
        timestamp: Date.now(),
      });

      app.log.error({ err: e }, 'Route error');
      reply.code(errorMeta.statusCode).send({
        error: {
          message: errMsg,
          type: 'routing_error',
          code: 'routing_failed',
          retryable: errorMeta.retryable,
        },
      });
    }
  };
}
