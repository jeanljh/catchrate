// Shapes of the JSON files passed between record, propose and run.

import type { EFFORTS, PROVIDERS, RISKS } from './constants.js';

export type ProviderId = (typeof PROVIDERS)[number];

/** matched on method + pathname */
export interface Target {
  method: string;
  path: string;
}

/** paths are RFC 6901 JSON pointers */
export type MutationOp =
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'status'; value: number }
  | { op: 'setBody'; value: unknown };

export type OpName = MutationOp['op'];

export type Risk = (typeof RISKS)[number];

export type Effort = (typeof EFFORTS)[number];

/** A simulated backend bug. */
export interface Mutant {
  id: string;
  source: 'heuristic' | 'llm';
  title: string;
  risk: Risk;
  rationale: string;
  target: Target;
  ops: MutationOp[];
  /** a Playwright assertion, or advice, that would catch it */
  assertionHint: string;
}

export interface Rejected {
  title: string;
  reason: string;
}

export interface ProposalResult {
  mutants: Mutant[];
  rejected: Rejected[];
  note?: string;
}

export interface Exchange {
  method: string;
  url: string;
  path: string;
  status: number;
  contentType: string;
  body: string | null;
  truncated?: boolean;
}

/** recordings/<slug>.json */
export interface Recording {
  key: string;
  project: string;
  titlePath: string[];
  title: string;
  file: string;
  line: number;
  status: string;
  recordedAt: string;
  exchanges: Exchange[];
  snapshot: string | null;
}

export interface MutantsTest {
  key: string;
  project: string;
  titlePath: string[];
  title: string;
  file: string;
  mutants: Mutant[];
  rejected: Rejected[];
  note?: string;
}

/** mutants.json */
export interface MutantsFile {
  version: 1;
  generatedAt: string;
  generator: { source: 'heuristic' | 'llm'; provider?: ProviderId; model?: string; effort?: Effort };
  tests: MutantsTest[];
}

export type PlanEntry = { id: string; control: true } | { id: string; control?: false; target: Target; ops: MutationOp[] };

/** written by the runner, read by the fixture */
export interface RunPlan {
  key: string;
  runId: string;
  entries: PlanEntry[];
}

/** written by the fixture after each repeat */
export interface Outcome {
  id: string;
  control: boolean;
  status: string | undefined;
  intercepted: number;
  applied: number;
  routeErrors: string[];
  /** final page, one entry per accessibility snapshot line (redacted) */
  snapshot: string[] | null;
  error: string | null;
  durationMs: number;
}

export type MutantOutcome = 'killed' | 'survived' | 'not-applied' | 'no-visible-effect' | 'skipped' | 'error';

export interface MutantResult extends Mutant {
  outcome: MutantOutcome;
  detail?: string;
}

export type TestStatus = 'ok' | 'unstable' | 'missing' | 'error';

export interface TestResult {
  key: string;
  project: string;
  titlePath: string[];
  title: string;
  file: string;
  status: TestStatus;
  detail?: string;
  mutants: MutantResult[];
  durationMs?: number;
}

export interface Counts {
  killed: number;
  survived: number;
  notApplied: number;
  noVisibleEffect: number;
  error: number;
  skipped: number;
}

export interface ReportTest extends TestResult {
  counts: Counts;
  /** caught / (caught + missed); null if nothing was reachable */
  score: number | null;
}

export interface ReportMeta {
  source?: string;
  provider?: string;
  model?: string;
  mutantsFile?: string;
}

/** report.json */
export interface Report extends ReportMeta {
  version: 1;
  generatedAt: string;
  summary: Counts & { tests: number; mutants: number; score: number | null };
  tests: ReportTest[];
}
