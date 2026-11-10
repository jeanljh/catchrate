// Anything that speaks OpenAI's chat completions API: OpenAI, OpenRouter, Gemini's
// compat endpoint, Ollama, LM Studio, vLLM, llama.cpp.
//
// Structured output support is patchy, so start with json_schema and step down
// to json_object, then plain text, when a server rejects it. llm.ts validates
// whatever comes back anyway.

import { ProposeError, SetupError } from '../errors.js';
import { redactText } from '../redact.js';
import type { ProviderId } from '../types.js';
import type { CompletionRequest, CompletionResult, MutantProvider } from './types.js';

type FormatMode = 'json_schema' | 'json_object' | 'none';
const MODES: readonly FormatMode[] = ['json_schema', 'json_object', 'none'];
const FORMAT_ERROR = /response_format|json_schema|json_object|schema|structured|format/i;

const SERVER_NAME: Record<Exclude<ProviderId, 'claude'>, string> = { openai: 'the model server', ollama: 'Ollama', lmstudio: 'LM Studio' };

export interface OpenAICompatibleOptions {
  id: Exclude<ProviderId, 'claude'>;
  baseUrl: string;
  model: string;
  /** local servers usually don't need one */
  apiKey?: string;
  /** for key errors, e.g. "Set OPENAI_API_KEY." */
  keyHint?: string;
  maxRetries?: number;
  /** local models can be slow */
  timeoutMs?: number;
}

interface ChatResponse {
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatibleProvider implements MutantProvider {
  readonly id: Exclude<ProviderId, 'claude'>;
  readonly model: string;
  readonly baseUrl: string;
  readonly defaultConcurrency: number;
  private readonly apiKey?: string;
  private readonly keyHint: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  /** strictest format this server has accepted so far */
  private mode: FormatMode = 'json_schema';

  constructor({ id, baseUrl, model, apiKey, keyHint = 'Set CATCHRATE_API_KEY.', maxRetries = 2, timeoutMs = 600_000 }: OpenAICompatibleOptions) {
    this.id = id;
    this.baseUrl = checkBaseUrl(baseUrl, Boolean(apiKey));
    this.model = model;
    this.apiKey = apiKey;
    this.keyHint = keyHint;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    // one GPU, one model: parallel requests would just queue
    this.defaultConcurrency = isLocal(this.baseUrl) ? 1 : 4;
  }

  // GET /models catches a dead server, a bad key or a mistyped model up front.
  async check(): Promise<void> {
    let res: Response;
    try {
      res = await this.fetch('GET', '/models');
    } catch (e) {
      const hint = isLocal(this.baseUrl) ? ` Is ${SERVER_NAME[this.id]} running?` : '';
      throw new SetupError(`Could not reach ${this.baseUrl}: ${causeOf(e)}.${hint}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new SetupError(`${this.baseUrl} rejected the API key (HTTP ${res.status}). ${this.keyHint}`);
    }
    if (!res.ok) return; // Not every server implements /models; the first real request will tell.
    const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
    const ids = (body?.data ?? []).map((m) => m?.id).filter((id): id is string => typeof id === 'string');
    if (ids.length && !ids.includes(this.model)) {
      const shown = ids.slice(0, 15).join(', ') + (ids.length > 15 ? ', ...' : '');
      throw new SetupError(`Model "${this.model}" isn't available at ${this.baseUrl}. Available: ${shown}`);
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    for (let i = MODES.indexOf(this.mode); i < MODES.length; i++) {
      const mode = MODES[i]!;
      const res = await this.post('/chat/completions', this.body(request, mode));
      if (res.status === 401 || res.status === 403) {
        throw new SetupError(`${this.baseUrl} rejected the API key (HTTP ${res.status}). ${this.keyHint}`);
      }
      if (res.ok) return parseChoice((await res.json().catch(() => ({}))) as ChatResponse);
      const message = await errorMessage(res);
      // Only a complaint about the response format means "try a looser one". Any
      // other 400 (prompt too long, say) mustn't downgrade every later request.
      if (res.status === 400 && mode !== 'none' && FORMAT_ERROR.test(message)) {
        this.mode = MODES[i + 1]!;
        continue;
      }
      throw new ProposeError(`HTTP ${res.status} from ${this.baseUrl}: ${redactText(message)}`);
    }
    throw new ProposeError(`${this.baseUrl} rejected every response format`);
  }

  private body({ system, user, schema, schemaName }: CompletionRequest, mode: FormatMode): Record<string, unknown> {
    // no schema enforcement, so put the schema in the prompt
    const instructions =
      mode === 'json_schema'
        ? system
        : `${system}\n\nReply with a single JSON object and nothing else. It must match this JSON Schema:\n${JSON.stringify(schema)}`;
    return {
      model: this.model,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: user },
      ],
      ...(mode === 'json_schema' ? { response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } } } : {}),
      ...(mode === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
    };
  }

  // retries 429s, 5xx and network errors
  private async post(path: string, body: unknown): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetch('POST', path, body);
        if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
          await sleep(retryDelay(res, attempt));
          continue;
        }
        return res;
      } catch (e) {
        lastError = e;
        if (attempt < this.maxRetries) await sleep(1000 * 2 ** attempt);
      }
    }
    throw new ProposeError(`request to ${this.baseUrl} failed: ${causeOf(lastError)}`);
  }

  private fetch(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

// servers disagree on error shapes: {error: {message}}, {error: "..."}, {message}, plain text
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: string | { message?: string }; message?: string };
    const msg = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message);
    if (msg) return msg;
  } catch {
    // not JSON
  }
  return text.trim().slice(0, 300) || 'no details';
}

function parseChoice(body: ChatResponse): CompletionResult {
  const choice = body.choices?.[0];
  if (!choice) throw new ProposeError('the response had no choices');
  if (choice.message?.refusal) throw new ProposeError(`the model declined this request: ${choice.message.refusal}`);
  if (choice.finish_reason === 'content_filter') throw new ProposeError('the response was blocked by a content filter');
  if (choice.finish_reason === 'length') throw new ProposeError('the response hit the token limit before the JSON was complete');
  return {
    text: extractJson(choice.message?.content ?? ''),
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
  };
}

// models like to wrap JSON in ``` fences or chat around it
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  return start !== -1 && end > start ? candidate.slice(start, end + 1) : candidate.trim();
}

// http(s) only, no user:pass@ in the URL, and never send a key over plain http
// to another machine.
function checkBaseUrl(raw: string, hasKey: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SetupError(`--base-url is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SetupError(`--base-url must use http or https, not ${url.protocol}`);
  if (url.username || url.password) throw new SetupError('--base-url must not contain credentials; pass the key in CATCHRATE_API_KEY instead');
  const clean = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  if (hasKey && url.protocol === 'http:' && !isLocal(clean)) {
    throw new SetupError(`Refusing to send an API key over unencrypted HTTP to ${url.host}. Use an https:// URL.`);
  }
  return clean;
}

function isLocal(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

function retryDelay(res: Response, attempt: number): number {
  const header = Number(res.headers.get('retry-after'));
  return Number.isFinite(header) && header >= 0 ? Math.min(header, 60) * 1000 : 1000 * 2 ** attempt;
}

function causeOf(e: unknown): string {
  if (!(e instanceof Error)) return redactText(String(e));
  const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
  return redactText(cause?.code ?? cause?.message ?? e.message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
