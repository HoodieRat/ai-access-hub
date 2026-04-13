/**
 * Cache layer: exact cache + semantic cache.
 *
 * Exact cache: SHA-256 hash of (model, sorted messages, temperature, etc.)
 * Semantic cache: cosine similarity of prompt embeddings (when embeddings available).
 */

import { createHash, randomBytes } from 'crypto';
import type { AdapterRequest, AdapterResponse } from './types';
import { getDb } from './db';
import { registry } from './registry';

const EXACT_CACHE_TTL_MS = 4 * 60 * 60_000;    // 4 hours
const SEMANTIC_CACHE_TTL_MS = 2 * 60 * 60_000;  // 2 hours
const SEMANTIC_SIMILARITY_THRESHOLD = 0.93;       // cosine similarity floor

// ─── Exact cache ──────────────────────────────────────────────────────────────

export function computeCacheKey(req: AdapterRequest): string {
  const key = {
    model: req.model,
    messages: req.messages.map(m => ({ role: m.role, content: m.content })),
    temperature: req.temperature ?? 1,
    maxTokens: req.maxTokens,
    tools: req.tools,
    stop: req.stop,
    responseFormat: req.responseFormat,
  };
  return createHash('sha256').update(JSON.stringify(key)).digest('hex');
}

export interface CachedResponse {
  content: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  providerId: string;
  modelId: string;
}

export function getExactCache(cacheKey: string): CachedResponse | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT response, usage, provider_id, model_id FROM exact_cache WHERE cache_key = ? AND expires_at > ?'
  ).get(cacheKey, Date.now()) as
    | { response: string; usage: string; provider_id: string; model_id: string }
    | undefined;

  if (!row) return null;

  try {
    db.prepare('UPDATE exact_cache SET hit_count = hit_count + 1 WHERE cache_key = ?').run(cacheKey);
    const response = JSON.parse(row.response) as { content: string; finishReason: string | null };
    const usage = JSON.parse(row.usage) as { promptTokens: number; completionTokens: number; totalTokens: number };
    return { ...response, usage, providerId: row.provider_id, modelId: row.model_id };
  } catch {
    return null;
  }
}

export function setExactCache(
  cacheKey: string,
  response: CachedResponse,
  ttlMs = EXACT_CACHE_TTL_MS,
): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO exact_cache (cache_key, provider_id, model_id, response, usage, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      response = excluded.response,
      usage = excluded.usage,
      expires_at = excluded.expires_at,
      hit_count = 0
  `).run(
    cacheKey,
    response.providerId,
    response.modelId,
    JSON.stringify({ content: response.content, finishReason: response.finishReason }),
    JSON.stringify(response.usage),
    now,
    now + ttlMs,
  );
}

// ─── Semantic cache ───────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getEmbedding(text: string): Promise<number[] | null> {
  // Try providers that support embeddings in priority order
  const embeddingProviders = ['local', 'gemini', 'cohere', 'cloudflare'];

  for (const pid of embeddingProviders) {
    const adapter = registry.getAdapter(pid);
    if (!adapter || !adapter.isEnabled() || !adapter.isAuthenticated()) continue;
    if (!adapter.capabilities.embeddings) continue;

    try {
      const models = await adapter.listModels();
      const embModel = models.find(m => m.capabilities.embeddings && !m.capabilities.chat);
      if (!embModel) continue;

      const result = await adapter.executeEmbeddings({ input: text, model: embModel.id });
      if (result.embeddings.length > 0) return result.embeddings[0];
    } catch {
      continue;
    }
  }
  return null;
}

export async function getSemanticCache(prompt: string): Promise<CachedResponse | null> {
  const embedding = await getEmbedding(prompt);
  if (!embedding) return null;

  const db = getDb();
  const rows = db.prepare(
    'SELECT id, embedding, response, usage, provider_id, model_id, hit_count FROM semantic_cache WHERE expires_at > ? ORDER BY created_at DESC LIMIT 100'
  ).all(Date.now()) as Array<{
    id: string;
    embedding: string;
    response: string;
    usage: string;
    provider_id: string;
    model_id: string;
    hit_count: number;
  }>;

  let bestMatch: { id: string; similarity: number; row: typeof rows[0] } | null = null;

  for (const row of rows) {
    try {
      const storedEmbedding = JSON.parse(row.embedding) as number[];
      const similarity = cosineSimilarity(embedding, storedEmbedding);
      if (similarity >= SEMANTIC_SIMILARITY_THRESHOLD) {
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { id: row.id, similarity, row };
        }
      }
    } catch {
      continue;
    }
  }

  if (!bestMatch) return null;

  db.prepare('UPDATE semantic_cache SET hit_count = hit_count + 1 WHERE id = ?').run(bestMatch.id);
  try {
    const response = JSON.parse(bestMatch.row.response) as { content: string; finishReason: string | null };
    const usage = JSON.parse(bestMatch.row.usage) as { promptTokens: number; completionTokens: number; totalTokens: number };
    return { ...response, usage, providerId: bestMatch.row.provider_id, modelId: bestMatch.row.model_id };
  } catch {
    return null;
  }
}

export async function setSemanticCache(
  prompt: string,
  response: CachedResponse,
  ttlMs = SEMANTIC_CACHE_TTL_MS,
): Promise<void> {
  const embedding = await getEmbedding(prompt);
  if (!embedding) return;

  const db = getDb();
  const now = Date.now();
  const id = randomBytes(16).toString('hex');
  const promptHash = createHash('sha256').update(prompt).digest('hex');

  db.prepare(`
    INSERT INTO semantic_cache (id, prompt_hash, embedding, response, provider_id, model_id, usage, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    promptHash,
    JSON.stringify(embedding),
    JSON.stringify({ content: response.content, finishReason: response.finishReason }),
    response.providerId,
    response.modelId,
    JSON.stringify(response.usage),
    now,
    now + ttlMs,
  );
}

// ─── Cache stats ──────────────────────────────────────────────────────────────
export function getCacheStats(): {
  exactEntries: number;
  exactHits: number;
  semanticEntries: number;
  semanticHits: number;
} {
  const db = getDb();
  const exact = db.prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(hit_count), 0) as hits FROM exact_cache WHERE expires_at > ?').get(Date.now()) as { cnt: number; hits: number };
  const semantic = db.prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(hit_count), 0) as hits FROM semantic_cache WHERE expires_at > ?').get(Date.now()) as { cnt: number; hits: number };

  return {
    exactEntries: exact.cnt,
    exactHits: exact.hits,
    semanticEntries: semantic.cnt,
    semanticHits: semantic.hits,
  };
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
export function cleanExpiredCache(): void {
  const db = getDb();
  const now = Date.now();
  db.prepare('DELETE FROM exact_cache WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM semantic_cache WHERE expires_at < ?').run(now);
}
