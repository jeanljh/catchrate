// Enums and defaults. types.ts derives its types from these and llm.ts builds
// the model schema from them, so new values go here.

import type { OpName } from './types.js';

// must list every MutationOp variant in types.ts
export const OPS = ['replace', 'remove', 'add', 'move', 'copy', 'status', 'setBody'] as const satisfies readonly OpName[];

export const MAX_OPS = 10;

export const RISKS = [
  'wrong-calculation',
  'missing-data',
  'extra-data',
  'wrong-data',
  'wrong-entity',
  'error-handling',
  'wrong-state',
  'stale-data',
  'other',
] as const;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// "openai" covers any OpenAI-compatible API. ollama and lmstudio are the same
// thing with a local default URL.
export const PROVIDERS = ['claude', 'openai', 'ollama', 'lmstudio'] as const;

// only Claude has a default; the other providers need --model
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_EFFORT = 'medium' satisfies (typeof EFFORTS)[number];

export const DEFAULT_MAX_PER_TEST = 8;

// relative to the project being audited
export const DEFAULT_OUT_DIR = '.catchrate';
