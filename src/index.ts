// Public API. The fixture is its own entry point: catchrate/fixture.
export {
  DEFAULT_EFFORT,
  DEFAULT_MAX_PER_TEST,
  DEFAULT_MODEL,
  DEFAULT_OUT_DIR,
  EFFORTS,
  MAX_OPS,
  OPS,
  PROVIDERS,
  RISKS,
} from './constants.js';
export { ProposeError, SetupError } from './errors.js';
export { applyMutation, dryRun, validateMutant, describeOps, matchesTarget, MutationError } from './mutations.js';
export { proposeHeuristic } from './heuristics.js';
export type { HeuristicOptions } from './heuristics.js';
export { proposeWithLLM, toMutants, buildUserPrompt, MUTANT_SCHEMA, SYSTEM_PROMPT } from './llm.js';
export type { LLMOptions, LLMResult, RawProposal } from './llm.js';
export { createProvider, ClaudeProvider, OpenAICompatibleProvider, PRESETS, GENERIC_KEY_ENV } from './providers/index.js';
export type {
  ClaudeClient,
  ClaudeProviderOptions,
  CompletionRequest,
  CompletionResult,
  MutantProvider,
  OpenAICompatibleOptions,
  ProviderSettings,
} from './providers/index.js';
export { record, runMutants, classify } from './runner.js';
export type { RunOptions, RecordOptions, RecordResult } from './runner.js';
export { REDACTED, isSecretKey, redactBody, redactJson, redactText, stripQuery } from './redact.js';
export { MUTANT_ID, parseMutantsFile, parseReport } from './validate.js';
export { buildReport, renderMarkdown, diffReports, renderDiffMarkdown } from './report.js';
export type { Diff, DiffItem } from './report.js';
export type * from './types.js';
export { renderHtml, renderDiffHtml, CSP } from './html.js';
