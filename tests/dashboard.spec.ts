import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
) as { version: string };

const PUBLIC_PAGES = [
  { id: 'overview', contentId: 'overview-content', expectedTexts: [/Uptime|Doctor|Routable Providers/i, /Free Usage Left|Official Ceilings|Estimated Ceilings|No Quota Data/i] },
  { id: 'providers', contentId: 'providers-content', expectedText: /Provider|Read-only|Actions/i },
  { id: 'models', contentId: 'models-content', expectedText: /Model Aliases|All Available Models/i },
  { id: 'usage', contentId: 'usage-content', expectedTexts: [/Total Requests|Cache Hit Rate|By Provider/i, /Free Usage Matrix|Metric|Confidence/i] },
  { id: 'warnings', contentId: 'warnings-content', expectedText: /warning|No active warnings|Read-only/i },
  { id: 'doctor', contentId: 'doctor-content', expectedText: /Overall|Provider Details|Checks/i },
] as const;

const ADMIN_PAGES = [
  { id: 'controls', contentId: 'controls-content', expectedText: /Mode Flags|Provider Test|Request Classifier/i },
  { id: 'logs', contentId: 'logs-content', expectedText: /No logs yet|Provider\/Model|Status/i },
  { id: 'tokens', contentId: 'tokens-content', expectedText: /Create Token|Existing Tokens|Project/i },
  { id: 'copilot-auth', contentId: 'copilot-content', expectedText: /GitHub Copilot OAuth|Start Device Auth Flow/i },
] as const;

const PROTECTED_READ_ENDPOINTS = new Set([
  '/v1/providers',
  '/v1/models',
  '/v1/usage',
]);

async function openDashboard(page: Page): Promise<void> {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.nav');
}

async function openPage(page: Page, pageId: string): Promise<void> {
  await page.locator(`[data-page="${pageId}"]`).click();
  await expect(page.locator(`#page-${pageId}`)).toHaveClass(/active/);
}

async function waitForContent(page: Page, contentId: string): Promise<void> {
  await expect.poll(async () => page.evaluate((targetId) => {
    const el = document.getElementById(targetId);
    if (!el) return 'missing';
    if (el.querySelector('.spinner')) return 'loading';
    const text = (el.textContent ?? '').trim();
    return text.length > 0 ? 'ready' : 'empty';
  }, contentId), {
    timeout: 15_000,
  }).toBe('ready');
}

test.describe('dashboard public navigation', () => {
  test('health and overview expose the package version', async ({ request }) => {
    const healthResponse = await request.get('/health');
    expect(healthResponse.ok()).toBeTruthy();
    const health = await healthResponse.json();
    expect(health).toMatchObject({
      status: 'ok',
      version: PACKAGE_VERSION.version,
    });

    const overviewResponse = await request.get('/dashboard/api/overview');
    expect(overviewResponse.ok()).toBeTruthy();
    const overview = await overviewResponse.json();
    expect(overview).toMatchObject({
      hub_version: PACKAGE_VERSION.version,
    });
  });

  test('public pages render without protected read API calls', async ({ page, baseURL }) => {
    const seenProtected = new Set<string>();
    const origin = new URL(baseURL ?? 'http://127.0.0.1:3000').origin;

    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === origin && PROTECTED_READ_ENDPOINTS.has(url.pathname)) {
        seenProtected.add(url.pathname);
      }
    });

    await openDashboard(page);

    for (const pageDef of PUBLIC_PAGES) {
      await openPage(page, pageDef.id);
      await waitForContent(page, pageDef.contentId);
      const expectedTexts = 'expectedTexts' in pageDef ? pageDef.expectedTexts : [pageDef.expectedText];
      for (const expectedText of expectedTexts) {
        await expect(page.locator(`#${pageDef.contentId}`)).toContainText(expectedText);
      }
    }

    expect([...seenProtected]).toEqual([]);
  });

  test('admin pages render automatically on localhost without localStorage setup', async ({ page }) => {
    await openDashboard(page);

    await expect.poll(async () => page.evaluate(() => localStorage.getItem('hub_admin_token'))).toBe(null);

    for (const pageDef of ADMIN_PAGES) {
      await openPage(page, pageDef.id);
      await waitForContent(page, pageDef.contentId);
      await expect(page.locator(`#${pageDef.contentId}`)).toContainText(pageDef.expectedText);
    }
  });

  test('route preview renders candidate and skip diagnostics', async ({ page }) => {
    let requestBody: Record<string, unknown> | null = null;

    await page.route('**/v1/admin/force-route', async route => {
      requestBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          classified_as: 'code_generation',
          preview: {
            classifiedAs: 'code_generation',
            alias: 'strong-code',
            stabilityLevel: 'strict',
            effectiveModes: {
              freeOnly: false,
              localOnly: false,
              premiumEnabled: true,
            },
            priorityOrder: ['copilot', 'github-models', 'mistral'],
            candidates: [{
              providerId: 'github-models',
              modelId: 'gpt-4o',
              score: 0.731,
              qualityTier: 'tier_code_strong',
              isFree: true,
              aliases: ['strong-code', 'strong-free'],
              aliasMatch: 'broadened',
              aliasMatchReason: 'requested=strong-code; matched=strong-free',
            }],
            skipCounts: {
              alias_mismatch: 2,
              premium_disabled: 1,
            },
            skipped: [
              {
                providerId: 'openrouter',
                modelId: 'openai/gpt-4o-mini',
                reason: 'alias_mismatch',
                detail: 'requested=strong-code',
              },
              {
                providerId: 'copilot',
                reason: 'premium_disabled',
              },
            ],
          },
        }),
      });
    });

    await openDashboard(page);
    await expect(page.locator('body')).not.toContainText('Ã');
    await openPage(page, 'controls');
    await waitForContent(page, 'controls-content');
    await page.locator('#classify-input').fill('Write a TypeScript router fix.');
    await page.locator('#preview-route-alias').selectOption('strong-code');
    await page.locator('#preview-stability-level').selectOption('strict');
    await page.locator('#preview-preferred-provider').fill('github-models');
    await page.getByRole('button', { name: 'Preview Route' }).click();

    await expect(page.locator('#route-preview-result')).toContainText('Candidate Order');
    await expect(page.locator('#route-preview-result')).toContainText('github-models');
    await expect(page.locator('#route-preview-result')).toContainText('strict');
    await expect(page.locator('#route-preview-result')).toContainText('broadened');
    await expect(page.locator('#route-preview-result')).toContainText(/alias[ _]mismatch/i);
    expect(requestBody).toMatchObject({
      model_alias: 'strong-code',
      stability_level: 'strict',
      preferred_provider: 'github-models',
      messages: [{ role: 'user', content: 'Write a TypeScript router fix.' }],
    });
  });

  test('copilot auth init sends a non-empty json body', async ({ page }) => {
    let requestHeaders: Record<string, string> | null = null;
    let requestBody: string | null | undefined;

    await page.route('**/v1/admin/copilot-auth/init', async route => {
      requestHeaders = route.request().headers();
      requestBody = route.request().postData();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          verification_uri: 'https://github.com/login/device',
          user_code: 'ABCD-EFGH',
          device_code: 'device-code',
          expires_in: 900,
        }),
      });
    });

    await openDashboard(page);
    await openPage(page, 'copilot-auth');
    await page.getByRole('button', { name: 'Start Device Auth Flow' }).click();

    await expect(page.locator('#copilot-auth-result')).toContainText('Step 1:');
    expect(requestBody).toBe('{}');
    expect(requestHeaders?.['content-type']).toContain('application/json');
  });
});
