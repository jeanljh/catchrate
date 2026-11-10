// Drop-in replacement for @playwright/test's `test`. It does nothing unless the
// CLI sets CATCHRATE_MODE:
//   record  save the API responses each test sees, plus a final page snapshot
//   mutate  serve one mutated response per repeat (repeat 0 is the control)

import { test as base, expect } from '@playwright/test';
import type { Page, Response, TestInfo } from '@playwright/test';
import { applyMutation, matchesTarget } from './mutations.js';
import { redactBody, redactText, stripQuery } from './redact.js';
import { paths, readJson, safeJoin, slug, testKey, writeJson } from './store.js';
import { firstLine } from './util.js';
import type { Exchange, Outcome, Recording, RunPlan } from './types.js';

const MAX_BODY_CHARS = 200_000;

type Use = (value: undefined) => Promise<void>;
interface Ctx {
  page: Page;
  use: Use;
  testInfo: TestInfo;
  key: string;
  outDir: string;
}

export interface CatchrateFixtures {
  /** auto fixture, tests never use it directly */
  catchrate: undefined;
}

export const test = base.extend<CatchrateFixtures>({
  catchrate: [
    async ({ page }, use, testInfo) => {
      const mode = process.env.CATCHRATE_MODE;
      const outDir = process.env.CATCHRATE_DIR;
      if (!mode || !outDir) return use(undefined);
      const key = testKey(testInfo.project.name, testInfo.titlePath);
      if (mode === 'record') return record({ page, use, testInfo, key, outDir });
      if (mode === 'mutate') return mutate({ page, use, testInfo, key, outDir });
      return use(undefined);
    },
    { auto: true },
  ],
});

export { expect };

const csv = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

async function record({ page, use, testInfo, key, outDir }: Ctx): Promise<void> {
  const types = new Set(csv(process.env.CATCHRATE_RESOURCE_TYPES || 'fetch,xhr'));
  // Recordings end up on disk and maybe in an LLM prompt, so mask secrets
  // unless --no-redact was passed.
  const redact = process.env.CATCHRATE_REDACT !== 'off';
  const extraKeys = csv(process.env.CATCHRATE_REDACT_KEYS);
  const context = page.context();
  const exchanges: Exchange[] = [];
  const pending: Promise<void>[] = [];

  const onResponse = (response: Response) => {
    const request = response.request();
    if (!types.has(request.resourceType())) return;
    const url = response.url();
    const entry: Exchange = {
      method: request.method(),
      url: stripQuery(url),
      path: new URL(url).pathname,
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
      body: null,
    };
    exchanges.push(entry);
    pending.push(
      response
        .text()
        .then((text) => {
          // redact first, truncate after, so the JSON still parses
          const safe = redact ? redactBody(text, extraKeys) : text;
          entry.truncated = safe.length > MAX_BODY_CHARS;
          entry.body = entry.truncated ? safe.slice(0, MAX_BODY_CHARS) : safe;
        })
        .catch(() => {}),
    );
  };

  context.on('response', onResponse);
  try {
    await use(undefined);
  } finally {
    context.off('response', onResponse);
    await Promise.allSettled(pending);
    const snapshot = await snapshotOf(page);
    const recording: Recording = {
      key,
      project: testInfo.project.name,
      titlePath: testInfo.titlePath,
      title: testInfo.title,
      file: testInfo.file,
      line: testInfo.line,
      status: testInfo.status ?? 'unknown',
      recordedAt: new Date().toISOString(),
      exchanges,
      snapshot: snapshot !== null && redact ? redactText(snapshot) : snapshot,
    };
    writeJson(safeJoin(paths(outDir).recordings, `${slug(key)}.json`), recording);
  }
}

async function mutate({ page, use, testInfo, key, outDir }: Ctx): Promise<void> {
  const planFile = process.env.CATCHRATE_PLAN;
  const plan = planFile ? readJson<RunPlan>(planFile) : null;
  if (!plan || plan.key !== key) return use(undefined);
  const entry = plan.entries[testInfo.repeatEachIndex];
  if (!entry) return use(undefined);

  // intercepted: the app made the request. applied: we served a mutated reply.
  // A reply that only lands after the test ended still counts as intercepted;
  // the test never waited for that data, which is exactly the weakness.
  let intercepted = 0;
  let applied = 0;
  const routeErrors: string[] = [];

  if (!entry.control) {
    const { target, ops } = entry;
    await page.context().route(
      (url) => url.pathname === target.path,
      async (route) => {
        const request = route.request();
        if (!matchesTarget(target, request.method(), request.url())) return route.fallback();
        intercepted += 1;
        // Fetch once, serve a mutated copy. If the mutation won't apply, pass the
        // real response through rather than sending the request twice.
        let response;
        try {
          response = await route.fetch();
        } catch (e) {
          routeErrors.push(`fetch failed: ${(e as Error).message}`);
          return route.fallback().catch(() => {});
        }
        try {
          const mutated = applyMutation({ status: response.status(), headers: response.headers(), body: await response.text() }, ops);
          await route.fulfill({ status: mutated.status, headers: mutated.headers, body: mutated.body });
          applied += 1;
        } catch (e) {
          routeErrors.push((e as Error).message);
          await route.fulfill({ response }).catch(() => {});
        }
      },
    );
  }

  const started = Date.now();
  try {
    await use(undefined);
  } finally {
    // The runner compares this with the control runs' pages: no visible change
    // means no UI assertion could have caught the bug.
    const snapshot = await snapshotOf(page);
    const outcome: Outcome = {
      id: entry.id,
      control: Boolean(entry.control),
      status: testInfo.status,
      intercepted,
      applied,
      routeErrors,
      snapshot: snapshot === null ? null : redactText(snapshot).split('\n'),
      error: firstLine(testInfo.error?.message),
      durationMs: Date.now() - started,
    };
    // entry.id comes from mutants.json, which people commit and could edit
    writeJson(safeJoin(paths(outDir).outcomes, plan.runId, `${entry.id}.json`), outcome);
  }
}

async function snapshotOf(page: Page): Promise<string | null> {
  try {
    return await page.locator('body').ariaSnapshot({ timeout: 2_000 });
  } catch {
    // page closed or mid-navigation; we can live without the snapshot
    return null;
  }
}
