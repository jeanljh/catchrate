// Claude via the Anthropic SDK.

import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../constants.js';
import { ProposeError, SetupError } from '../errors.js';
import { redactText } from '../redact.js';
import type { Effort } from '../types.js';
import type { CompletionRequest, CompletionResult, MutantProvider } from './types.js';

/** narrowed so tests can pass a stub */
export type ClaudeClient = Pick<Anthropic, 'models' | 'beta'>;

export interface ClaudeProviderOptions {
  client?: ClaudeClient;
  model?: string;
  effort?: Effort;
}

const CREDENTIALS_HELP = 'Set ANTHROPIC_API_KEY or run `ant auth login`, or drop --llm to use the offline heuristics.';

export class ClaudeProvider implements MutantProvider {
  readonly id = 'claude' as const;
  readonly model: string;
  readonly defaultConcurrency = 4;
  readonly effort: Effort;
  private readonly client: ClaudeClient;

  constructor({ client, model = DEFAULT_MODEL, effort = DEFAULT_EFFORT }: ClaudeProviderOptions = {}) {
    this.client = client ?? new Anthropic();
    this.model = model;
    this.effort = effort;
  }

  // models.retrieve is free and catches a bad key or model name before any test
  // is sent. Rate limits and 5xx here aren't worth stopping for.
  async check(): Promise<void> {
    try {
      await this.client.models.retrieve(this.model);
    } catch (e) {
      if (e instanceof Anthropic.NotFoundError) throw new SetupError(`Model "${this.model}" was not found. Check --model.`);
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        throw new SetupError(`Claude API credentials were rejected. ${CREDENTIALS_HELP}`);
      }
      if (!(e instanceof Anthropic.APIError)) {
        // thrown before any request, e.g. no credentials configured
        throw new SetupError(`Could not call the Claude API: ${(e as Error).message}\n${CREDENTIALS_HELP}`);
      }
    }
  }

  async complete({ system, user, schema }: CompletionRequest): Promise<CompletionResult> {
    let response;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        // if a safety classifier declines, the API retries on Anthropic's fallback model
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: this.effort, format: { type: 'json_schema', schema } },
        system,
        messages: [{ role: 'user', content: user }],
      });
    } catch (e) {
      throw translateError(e);
    }

    if (response.stop_reason === 'refusal') {
      throw new ProposeError(`the model declined this request (${response.stop_details?.category ?? 'no category given'})`);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ProposeError('the response hit max_tokens before the JSON was complete');
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { text, inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 };
  }
}

function translateError(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new SetupError(`Claude API credentials were rejected. ${CREDENTIALS_HELP}`);
  }
  if (e instanceof Anthropic.RateLimitError) return new ProposeError('rate limited after retries');
  if (e instanceof Anthropic.BadRequestError) return new ProposeError(`bad request: ${redactText(e.message)}`);
  if (e instanceof Anthropic.APIError) return new ProposeError(`API error ${e.status ?? ''}: ${redactText(e.message)}`);
  return e instanceof Error ? e : new Error(String(e));
}
