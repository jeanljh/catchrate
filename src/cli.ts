#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposeHeuristic } from './heuristics.js';
import { DEFAULT_EFFORT, DEFAULT_MAX_PER_TEST, DEFAULT_MODEL, DEFAULT_OUT_DIR, EFFORTS, PROVIDERS } from './constants.js';
import { ProposeError } from './errors.js';
import { proposeWithLLM } from './llm.js';
import { ClaudeProvider, createProvider, GENERIC_KEY_ENV, OpenAICompatibleProvider } from './providers/index.js';
import type { MutantProvider } from './providers/index.js';
import { renderDiffHtml, renderHtml } from './html.js';
import { buildReport, diffReports, renderDiffMarkdown, renderMarkdown } from './report.js';
import { defaultWorkers, record, runMutants } from './runner.js';
import { paths, readDirJson, readJson, writeJson } from './store.js';
import type { OutPaths } from './store.js';
import type { Effort, MutantsFile, MutantsTest, ProposalResult, ProviderId, Recording } from './types.js';
import { pct } from './util.js';
import { parseMutantsFile, parseReport } from './validate.js';

const HELP = `catchrate: would your Playwright tests catch a real backend bug?

Usage: catchrate <command> [options]

Commands:
  audit                 record, propose and run in one go (the usual entry point)
  record                run the suite once and save each test's API responses
  propose               generate simulated bugs (mutants) from the recordings
  run                   run every mutant and write report.json, .md and .html
  diff <before> <after> compare two report.json files; exits 1 if a test got weaker
  report [report.json]  print a saved report as Markdown, or write it as HTML with --html

Options:
  --cwd <dir>           project to audit, where Playwright runs (default: current directory)
  --config <file>       Playwright config file
  --project <name>      only this Playwright project
  --grep <regex>        only tests whose title matches (record, audit)
  --out-dir <dir>       where recordings, mutants and reports go (default: <cwd>/${DEFAULT_OUT_DIR})
  --llm                 propose mutants with an LLM instead of the offline heuristics
  --provider <name>     ${PROVIDERS.join(' | ')} (default: claude; implies --llm)
                          openai   = any OpenAI-compatible API (OpenAI, OpenRouter, Gemini, vLLM ...)
                          ollama   = local Ollama at http://localhost:11434/v1
                          lmstudio = local LM Studio at http://localhost:1234/v1
  --model <id>          model name (default for claude: ${DEFAULT_MODEL}; required for the others)
  --base-url <url>      server URL for openai/ollama/lmstudio, e.g. https://openrouter.ai/api/v1
  --effort <level>      Claude only: ${EFFORTS.join(' | ')} (default: ${DEFAULT_EFFORT})
  --max-per-test <n>    mutants per test (default: ${DEFAULT_MAX_PER_TEST})
  --mutants <file>      mutants file to run (default: <out-dir>/mutants.json)
  --out <file>          run: report JSON to write; .md and .html go next to it (default: <out-dir>/report.json)
                        diff: also write the Markdown diff to this file
  --html <file>         diff, report: write a self-contained HTML page
  --workers <n>         parallel browsers per test during run (default: ${defaultWorkers()})
  --timeout <ms>        per-test timeout during run (default: the Playwright config's)
  --min-score <0-100>   exit 1 if the overall catch rate is below this (run, audit)
  --redact-keys <a,b>   extra JSON keys to mask in recordings (record, audit)
  --no-redact           store response bodies unmasked (not recommended)
  -v, --version         print the version
  -h, --help            show this help

Tests must import { test, expect } from 'catchrate/fixture' instead of '@playwright/test'.
A .env file in the current directory is loaded automatically. API keys: ANTHROPIC_API_KEY (claude),
OPENAI_API_KEY (openai), or ${GENERIC_KEY_ENV} for any OpenAI-compatible server. Local servers need none.`;

const VALUE_FLAGS = new Set(['cwd', 'config', 'project', 'grep', 'out-dir', 'provider', 'base-url', 'model', 'effort', 'redact-keys', 'max-per-test', 'mutants', 'out', 'workers', 'timeout', 'min-score', 'html']);
const BOOL_FLAGS = new Set(['llm', 'help', 'version', 'no-redact']);

export interface CliOptions {
  _: string[];
  [flag: string]: string | boolean | string[] | undefined;
}

class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '-v') {
      opts.version = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      opts._.push(arg);
      continue;
    }
    const [name = '', inline] = arg.slice(2).split(/=(.*)/s);
    let value: string | undefined = inline;
    if (BOOL_FLAGS.has(name)) {
      opts[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
      }
      opts[name] = value;
    } else {
      throw new UsageError(`unknown option --${name}`);
    }
  }
  return opts;
}

const isEffort = (e: string): e is Effort => (EFFORTS as readonly string[]).includes(e);
const isProvider = (p: string): p is ProviderId => (PROVIDERS as readonly string[]).includes(p);

const str = (opts: CliOptions, name: string): string | undefined => (typeof opts[name] === 'string' ? (opts[name] as string) : undefined);

const NUMBER_RANGES: Record<string, { min: number; max?: number }> = {
  'max-per-test': { min: 1, max: 50 },
  workers: { min: 1 },
  timeout: { min: 1 },
  'min-score': { min: 0, max: 100 },
};

function intOption(opts: CliOptions, name: keyof typeof NUMBER_RANGES): number | undefined {
  const raw = str(opts, name);
  if (raw === undefined) return undefined;
  const { min, max } = NUMBER_RANGES[name]!;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    throw new UsageError(`--${name} must be a whole number ${max === undefined ? `of at least ${min}` : `from ${min} to ${max}`}`);
  }
  return n;
}

interface Context {
  cwd: string;
  outDir: string;
  dirs: OutPaths;
  config?: string;
  project?: string;
}

function context(opts: CliOptions): Context {
  const cwd = path.resolve(str(opts, 'cwd') ?? '.');
  const outDir = path.resolve(str(opts, 'out-dir') ?? path.join(cwd, DEFAULT_OUT_DIR));
  const config = str(opts, 'config');
  return { cwd, outDir, dirs: paths(outDir), config: config ? path.resolve(config) : undefined, project: str(opts, 'project') };
}

const log = (...a: unknown[]) => console.error(...a);

async function cmdRecord(opts: CliOptions): Promise<void> {
  const ctx = context(opts);
  log(`Recording API responses in ${ctx.cwd} ...`);
  const redactKeys = (str(opts, 'redact-keys') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  if (opts['no-redact']) log('Warning: --no-redact stores response bodies unmasked; keep .catchrate/ out of version control.');
  const result = await record({ ...ctx, grep: str(opts, 'grep'), redact: !opts['no-redact'], redactKeys });
  if (!result.passed.length && !result.failed.length) {
    throw new Error(`No recordings were written (Playwright exit code ${result.code}). Check that your tests import { test } from 'catchrate/fixture'.`);
  }
  log(`Recorded ${result.passed.length} passing tests.`);
  if (result.failed.length) log(`${result.failed.length} tests did not pass and will be skipped: ${result.failed.map((r) => r.key).join('; ')}`);
}

function providerFrom(opts: CliOptions, providerOpt: string | undefined): MutantProvider {
  const provider = providerOpt ?? 'claude';
  if (!isProvider(provider)) throw new UsageError(`--provider must be one of ${PROVIDERS.join(', ')}`);
  const effort = str(opts, 'effort');
  if (effort !== undefined && !isEffort(effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}`);
  if (effort !== undefined && provider !== 'claude') log(`Note: --effort only applies to Claude; ignored for ${provider}.`);
  const baseUrl = str(opts, 'base-url');
  if (baseUrl !== undefined && provider === 'claude') throw new UsageError('--base-url only applies to OpenAI-compatible providers (openai, ollama, lmstudio)');
  return createProvider({ provider, model: str(opts, 'model'), effort, baseUrl });
}

async function cmdPropose(opts: CliOptions): Promise<void> {
  const ctx = context(opts);
  const maxPerTest = intOption(opts, 'max-per-test') ?? DEFAULT_MAX_PER_TEST;
  const recordings = readDirJson<Recording>(ctx.dirs.recordings).filter((r) => r.status === 'passed');
  if (!recordings.length) throw new Error(`No passing recordings in ${ctx.dirs.recordings}. Run "catchrate record" first.`);

  let byKey: Map<string, ProposalResult>;
  let generator: MutantsFile['generator'];
  const providerOpt = str(opts, 'provider');
  if (opts.llm || providerOpt) {
    const provider = providerFrom(opts, providerOpt);
    const where = provider instanceof OpenAICompatibleProvider ? ` at ${provider.baseUrl}` : '';
    log(`Asking ${provider.id}:${provider.model}${where} for up to ${maxPerTest} mutants per test (${recordings.length} tests) ...`);
    const { results, failures, usage } = await proposeWithLLM(recordings, { provider, maxPerTest, log });
    byKey = results;
    // fall back to heuristics for any test the model choked on
    for (const f of failures) {
      const rec = recordings.find((r) => r.key === f.key)!;
      byKey.set(f.key, { ...proposeHeuristic(rec, { maxPerTest }), note: `LLM failed (${f.reason}); used heuristics` });
    }
    log(`Token usage: ${usage.inputTokens} input, ${usage.outputTokens} output.`);
    generator = { source: 'llm', provider: provider.id, model: provider.model, ...(provider instanceof ClaudeProvider ? { effort: provider.effort } : {}) };
  } else {
    byKey = new Map(recordings.map((r) => [r.key, proposeHeuristic(r, { maxPerTest })]));
    generator = { source: 'heuristic' };
  }

  const tests: MutantsTest[] = recordings.map((r) => {
    const res = byKey.get(r.key) ?? { mutants: [], rejected: [] };
    return {
      key: r.key,
      project: r.project,
      titlePath: r.titlePath,
      title: r.title,
      file: r.file,
      mutants: res.mutants,
      rejected: res.rejected,
      ...(res.note ? { note: res.note } : {}),
    };
  });
  const data: MutantsFile = { version: 1, generatedAt: new Date().toISOString(), generator, tests };
  writeJson(ctx.dirs.mutants, data);
  const total = tests.reduce((n, t) => n + t.mutants.length, 0);
  log(`Wrote ${total} mutants for ${tests.length} tests to ${path.relative(process.cwd(), ctx.dirs.mutants) || ctx.dirs.mutants}.`);
}

async function cmdRun(opts: CliOptions): Promise<number> {
  const ctx = context(opts);
  const mutantsOpt = str(opts, 'mutants');
  const mutantsFile = mutantsOpt ? path.resolve(mutantsOpt) : ctx.dirs.mutants;
  if (!fs.existsSync(mutantsFile)) throw new Error(`No mutants file at ${mutantsFile}. Run "catchrate propose" first.`);
  const mutantsData = parseMutantsFile(readJson<unknown>(mutantsFile), mutantsFile);
  const workers = intOption(opts, 'workers') ?? defaultWorkers();
  const timeout = intOption(opts, 'timeout');
  const total = mutantsData.tests.reduce((n, t) => n + t.mutants.length, 0);
  log(`Running ${total} mutants across ${mutantsData.tests.length} tests (${workers} workers) ...`);

  const { results } = await runMutants({
    ...ctx,
    mutantsData,
    workers,
    timeout,
    onTest: (r) => {
      const killed = r.mutants.filter((m) => m.outcome === 'killed').length;
      const survived = r.mutants.filter((m) => m.outcome === 'survived').length;
      const label = r.status === 'ok' ? `${killed} caught, ${survived} missed` : r.status;
      log(`  ${r.titlePath.join(' › ')}: ${label} (${((r.durationMs ?? 0) / 1000).toFixed(1)}s)`);
    },
  });

  const report = buildReport({ results, meta: { source: mutantsData.generator?.source, provider: mutantsData.generator?.provider, model: mutantsData.generator?.model, mutantsFile } });
  const outOpt = str(opts, 'out');
  const outJson = outOpt ? path.resolve(outOpt) : ctx.dirs.reportJson;
  const base = outJson.replace(/\.json$/i, '');
  const outMd = `${base}.md`;
  const outHtml = `${base}.html`;
  writeJson(outJson, report);
  fs.writeFileSync(outMd, renderMarkdown(report));
  fs.writeFileSync(outHtml, renderHtml(report));
  const s = report.summary;
  log(
    `\nCatch rate: ${pct(s.score)} ` +
      `(${s.killed} caught, ${s.survived} missed, ${s.notApplied} not reached, ${s.noVisibleEffect} no visible change, ${s.error + s.skipped} errors or skipped)`,
  );
  log(`Report: ${outMd}`);
  log(`HTML:   ${outHtml}`);

  const minScore = intOption(opts, 'min-score');
  if (minScore !== undefined && (s.score ?? 0) * 100 < minScore) {
    log(`Catch rate is below --min-score ${minScore}.`);
    return 1;
  }
  return 0;
}

function cmdDiff(opts: CliOptions): number {
  const [beforeFile, afterFile] = opts._;
  if (!beforeFile || !afterFile) throw new UsageError('diff needs two report.json files: catchrate diff <before> <after>');
  const load = (f: string) => parseReport(readJson<unknown>(path.resolve(f)), f);
  const diff = diffReports(load(beforeFile), load(afterFile));
  const md = renderDiffMarkdown(diff);
  const out = str(opts, 'out');
  if (out) fs.writeFileSync(path.resolve(out), md);
  const html = str(opts, 'html');
  if (html) writeHtml(html, renderDiffHtml(diff));
  console.log(md);
  return diff.regressed ? 1 : 0;
}

function cmdReport(opts: CliOptions): number {
  const ctx = context(opts);
  const file = opts._[0] ? path.resolve(opts._[0]) : ctx.dirs.reportJson;
  const report = parseReport(readJson<unknown>(file), file);
  const html = str(opts, 'html');
  if (html) writeHtml(html, renderHtml(report));
  else console.log(renderMarkdown(report));
  return 0;
}

function writeHtml(file: string, html: string): void {
  const target = path.resolve(file);
  fs.writeFileSync(target, html);
  log(`HTML: ${target}`);
}

function version(): string {
  const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return readJson<{ version: string }>(pkg).version;
}

// Returns the exit code instead of exiting, so tests can call it.
export async function main(argv: readonly string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    log(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (opts.version) {
    console.log(version());
    return 0;
  }
  const [command, ...rest] = opts._;
  opts._ = rest;
  if (opts.help || !command) {
    console.log(HELP);
    return opts.help ? 0 : 2;
  }
  try {
    // catch a bad --min-score now, not after a ten-minute audit
    for (const name of Object.keys(NUMBER_RANGES)) intOption(opts, name);
    switch (command) {
      case 'record':
        await cmdRecord(opts);
        return 0;
      case 'propose':
        await cmdPropose(opts);
        return 0;
      case 'run':
        return await cmdRun(opts);
      case 'audit':
        await cmdRecord(opts);
        await cmdPropose(opts);
        return await cmdRun(opts);
      case 'diff':
        return cmdDiff(opts);
      case 'report':
        return cmdReport(opts);
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) log(`${e.message}\n\n${HELP}`);
    else if (e instanceof ProposeError) log(`Error: ${e.message}`);
    else log(`Error: ${(e as Error).message}`);
    return 2;
  }
}

// Variables already set in the environment win over .env.
export function loadDotEnv(file = path.resolve('.env')): boolean {
  if (!fs.existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

function invokedDirectly(): boolean {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  loadDotEnv();
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
