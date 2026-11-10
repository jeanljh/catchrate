import { SetupError } from '../errors.js';
import type { Effort, ProviderId } from '../types.js';
import { ClaudeProvider } from './claude.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { MutantProvider } from './types.js';

export { ClaudeProvider } from './claude.js';
export type { ClaudeClient, ClaudeProviderOptions } from './claude.js';
export { OpenAICompatibleProvider, extractJson } from './openai-compatible.js';
export type { OpenAICompatibleOptions } from './openai-compatible.js';
export type { CompletionRequest, CompletionResult, MutantProvider } from './types.js';

export const PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', exampleModel: 'the model ID from your provider' },
  ollama: { baseUrl: 'http://localhost:11434/v1', keyEnv: undefined, exampleModel: 'qwen3:14b (see `ollama list`)' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', keyEnv: undefined, exampleModel: 'the model ID shown in LM Studio' },
} as const;

// works for any OpenAI-compatible server and wins over OPENAI_API_KEY
export const GENERIC_KEY_ENV = 'CATCHRATE_API_KEY';

export interface ProviderSettings {
  provider?: ProviderId;
  model?: string;
  /** claude only */
  effort?: Effort;
  /** overrides the preset URL */
  baseUrl?: string;
  /** default: CATCHRATE_API_KEY, then the preset's own variable */
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
}

export function createProvider({ provider = 'claude', model, effort, baseUrl, apiKey, env = process.env }: ProviderSettings = {}): MutantProvider {
  if (provider === 'claude') return new ClaudeProvider({ model, effort });

  const preset = PRESETS[provider];
  if (!model) throw new SetupError(`--model is required with --provider ${provider} (for example ${preset.exampleModel}).`);
  const url = baseUrl ?? preset.baseUrl;
  const key = apiKey ?? env[GENERIC_KEY_ENV] ?? (preset.keyEnv ? env[preset.keyEnv] : undefined);
  const keyHint = preset.keyEnv ? `Set ${preset.keyEnv} or ${GENERIC_KEY_ENV}.` : `Set ${GENERIC_KEY_ENV} if this server needs a key.`;
  if (!key && provider === 'openai' && !baseUrl) {
    throw new SetupError(`No API key for ${url}. ${keyHint}`);
  }
  return new OpenAICompatibleProvider({ id: provider, baseUrl: url, model, apiKey: key || undefined, keyHint });
}
