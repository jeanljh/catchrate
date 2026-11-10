import type { ProviderId } from '../types.js';

export interface CompletionRequest {
  system: string;
  user: string;
  /** JSON Schema for the reply */
  schema: Record<string, unknown>;
  /** some APIs insist on a name */
  schemaName: string;
}

export interface CompletionResult {
  /** should contain one JSON object */
  text: string;
  inputTokens: number;
  outputTokens: number;
}

// Throw SetupError when every request would fail, ProposeError when only this
// one did.
export interface MutantProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly defaultConcurrency: number;
  /** cheap sanity check before any test is sent */
  check(): Promise<void>;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
