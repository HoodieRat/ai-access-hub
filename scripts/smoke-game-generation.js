#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ override: true });

const baseUrl = process.env.HUB_BASE_URL || 'http://127.0.0.1:3099';
const apiUrl = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
const token = process.env.HUB_CLIENT_TOKEN || process.env.HUB_ADMIN_TOKEN || '';
const aliases = (process.env.SMOKE_GAME_ALIASES || 'strong-code,strong-free,fast-free')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

if (!token) {
  console.error('Missing HUB_CLIENT_TOKEN or HUB_ADMIN_TOKEN in environment/.env');
  process.exit(2);
}

const prompt = [
  'Create a complete playable retro game as a single self-contained HTML file.',
  'Include inline CSS and JavaScript in the same HTML file.',
  'Use keyboard controls and display score and game-over restart behavior.',
  'Return only the finished HTML code.',
].join(' ');

function extractContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return '';
  return content.trim();
}

function extractHtml(content) {
  const fenced = content.match(/```html\s*([\s\S]*?)```/i) || content.match(/```\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : content;
  if (!/^<!doctype html>|<html[\s>]/i.test(raw)) return raw;
  return raw;
}

async function callAlias(alias) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const body = {
      model: alias,
      stream: false,
      temperature: 0.6,
      max_tokens: 1536,
      messages: [{ role: 'user', content: prompt }],
    };

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // keep raw text for diagnostics
    }

    if (!res.ok) {
      const msg = json?.error?.message || text || `HTTP ${res.status}`;
      return { ok: false, alias, status: res.status, message: msg };
    }

    const content = extractContent(json);
    if (!content || content.length < 300) {
      return { ok: false, alias, status: 200, message: 'Model returned empty or too-short content' };
    }

    const html = extractHtml(content);
    const looksLikeGame = /(canvas|requestAnimationFrame|keydown|score|game over)/i.test(html);
    if (!looksLikeGame) {
      return { ok: false, alias, status: 200, message: 'Response did not look like a playable game output' };
    }

    return {
      ok: true,
      alias,
      status: 200,
      html,
      provider: json?._hub?.provider_id || 'unknown',
      upstreamModel: json?._hub?.upstream_model || 'unknown',
      qualityTier: json?._hub?.quality_tier || 'unknown',
    };
  } catch (error) {
    return {
      ok: false,
      alias,
      status: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

(async () => {
  const failures = [];
  for (const alias of aliases) {
    // eslint-disable-next-line no-await-in-loop
    const result = await callAlias(alias);
    if (!result.ok) {
      failures.push(result);
      console.warn(`[smoke:game] alias=${alias} failed status=${result.status} message=${result.message}`);
      continue;
    }

    const outDir = path.join(process.cwd(), 'logs');
    const outPath = path.join(outDir, 'smoke-game-output.html');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, result.html, 'utf8');

    console.log('[smoke:game] success');
    console.log(`[smoke:game] alias=${result.alias} provider=${result.provider} model=${result.upstreamModel} tier=${result.qualityTier}`);
    console.log(`[smoke:game] output=${outPath}`);
    process.exit(0);
  }

  console.error('[smoke:game] failed across all aliases');
  for (const failure of failures) {
    console.error(`- alias=${failure.alias} status=${failure.status} message=${failure.message}`);
  }
  process.exit(1);
})();
