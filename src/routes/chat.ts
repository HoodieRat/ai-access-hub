/**
 * Chat completions route.
 * Handles both POST /v1/chat/completions and POST /v1/responses.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteRequest } from '../types';
import { route } from '../router';
import { insertRequestLog } from '../db';
import { randomBytes } from 'crypto';
import { classifyRequest } from '../router';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  const handler = makeCompletionHandler(app);

  app.post('/v1/chat/completions', handler);
  app.post('/v1/responses', handler);
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
      const routeReq: RouteRequest = { ...body, project_id: body.project_id ?? projectId ?? undefined };
      const result = await route(routeReq);

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
      const latencyMs = Date.now() - start;
      const errMsg = e instanceof Error ? e.message : String(e);

      insertRequestLog({
        id: requestId,
        projectId,
        classifiedAs: 'normal_chat',
        selectedProvider: 'unknown',
        selectedModel: 'unknown',
        qualityTier: 'tier_free_fast',
        cacheHit: false,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs,
        success: false,
        errorCode: errMsg.slice(0, 100),
        fallbackChain: [],
        downgraded: false,
        timestamp: Date.now(),
      });

      app.log.error({ err: e }, 'Route error');
      reply.code(500).send({
        error: {
          message: errMsg,
          type: 'routing_error',
          code: 'routing_failed',
          retryable: false,
        },
      });
    }
  };
}
