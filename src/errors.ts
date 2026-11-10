// Fails one test. The CLI falls back to heuristics for it and carries on.
export class ProposeError extends Error {}

// Bad key, server down, unknown model: every test would fail the same way,
// so stop instead.
export class SetupError extends ProposeError {}
