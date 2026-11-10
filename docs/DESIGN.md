# catchrate: design

## Problem

A passing E2E test proves the page loaded. It does not prove the test would notice the price is wrong, an item is missing, or an error was shown as a success. Coding agents and self-healing tools now edit tests all the time, so teams need a measured answer to "would this suite catch a bug here?" No current tool gives one for Playwright suites:

- The existing Playwright "mutation" tools (playwright-mutation-gate, apophasis) flip the test's own assertions. They show an assertion is binding, not that the suite catches app bugs.
- Mutation tools for unit tests (Stryker, PIT, mutmut, mutahunter) change source code, so they never exercise the UI.
- The academic tools (MAEWU 2021, Mutta 2024) are not LLM-driven, don't mutate network data, and aren't packaged for Playwright.

## What it does

1. **Record.** Run the suite once through a Playwright fixture. For each passing test, save the API responses it saw (method, path, status, JSON body) and an accessibility snapshot of the final page (what a user could see).
2. **Propose.** Generate 5–10 *semantic mutants* per test. Each one is a realistic backend bug expressed as a deterministic edit to one recorded response, e.g.:
   - the cart total is off by one
   - the first line item is dropped
   - the checkout returns 500
   - the order belongs to another user

   Mutants come from Claude (`--llm`) or from built-in heuristics (offline, free). Either way they are written as data, never code: a JSON-Patch subset plus status and body replacement. Each mutant is dry-run against the recording, and any that don't apply are discarded.
3. **Run.** For each test, run two unmutated controls (first and last) plus every mutant in a single Playwright process (`--repeat-each`, `--retries=0`). The fixture serves the mutated response by intercepting with `context.route()` and `route.fetch()`. Each outcome is one of:
   - **killed**: the test failed.
   - **survived**: the test passed even though the bug was injected.
   - **not-applied**: the target request never happened.
   - **no visible change**: the test passed, but the final page's accessibility snapshot matched the controls'. Lines that differ between the two controls, and clock-like lines, count as live data: there only the format is compared, with digits masked. Like not-applied, it doesn't count toward the score.
   - **error**: no result was recorded.

   If either control run fails, the test is marked unstable and its results are discarded.
4. **Report.** Write the mutation score per test, a list of surviving mutants grouped by business risk, and the assertion that would have caught each one. Output goes to `report.md` and `report.json`.
5. **Heal check (`diff`).** Re-run the same mutants after a test changes, for example after a self-heal or an agent's edit. Any mutant the test used to kill but now survives means the change weakened the test, however harmless the diff looks. The exit code is 1 in that case, so it can gate CI.

## Design decisions

- **Mutate at the network boundary.** No access to the app's source is needed, it works with any backend stack, and the tests themselves stay untouched.
- **Mutants are data, not code.** The LLM never writes executable code, which keeps runs deterministic and reviewable. The same mutant file replays exactly in CI.
- **Use the accessibility snapshot to cut equivalent mutants.** A mutant that changes a value the user never sees can't be caught by any UI test. The heuristic generator only mutates values that appear in the final page snapshot, and the LLM prompt includes the snapshot too.
- **Key tests by project name and title path, not by line number.** This keeps mutant sets stable when a heal edits the file.
- **Keep the LLM out of the run loop.** Claude is called once per test at propose time. Runs cost nothing beyond browser time.

## Components

| File | Role |
|---|---|
| `src/fixture.ts` | Playwright fixture: records in record mode; intercepts and mutates in mutate mode; writes outcome files |
| `src/mutations.ts` | Mutation operations (`replace`, `remove`, `add`, `move`, `copy`, `status`, `setBody`) plus validation and dry-run |
| `src/heuristics.ts` | Offline mutant generator that uses the accessibility snapshot to skip values the user never sees |
| `src/llm.ts` | Model-agnostic LLM proposer: prompt, output schema, validation and dry-run of each suggested mutant |
| `src/providers/` | Model backends behind one interface (`check()`, `complete()`): Claude (structured output, server-side refusal fallback) and OpenAI-compatible (OpenAI, OpenRouter, Gemini, Ollama, LM Studio …), which steps down from JSON schema to JSON mode to plain text when a server lacks support |
| `src/runner.ts` | Spawns Playwright for the record and mutate phases and collects outcomes |
| `src/report.ts` | Markdown and JSON report, scores, heal diff |
| `src/cli.ts` | `record`, `propose`, `run`, `audit`, `diff` |
| `examples/shop` | Demo app with one strong, one medium and one weak test, plus a "healed" (weakened) variant |
| `src/types.ts` | Shared data shapes (recordings, mutants, outcomes, reports) |
| `src/redact.ts` | Masks credential-like keys and value patterns before recordings hit disk or a model |
| `src/validate.ts` | Treats `mutants.json` and `report.json` as untrusted input: id format, known operations, shape |
| `src/constants.ts` | Single source of truth for operations, risk categories, effort levels and defaults |
| `src/util.ts` | Regex/attribute escaping and message trimming helpers |
| `test/` | Unit tests (`node --test`, TypeScript, run against `dist/`) |

## Acceptance criteria for v0.1

- Unit tests pass for mutation operations, heuristics, LLM output validation and diff.
- On the demo shop, the weak test scores visibly lower than the strong test, and every survivor carries an assertion hint.
- Swapping in the healed spec makes `diff` report the newly surviving mutants and exit 1.
- The Claude path is exercised whenever credentials are available. Without them it's covered by unit tests with a stubbed client.

## Out of scope for v1

- Mutating the DOM directly (MAEWU-style) or WebSocket and server-sent-event traffic.
- Non-Playwright runners such as Cypress or WebdriverIO.
- Mobile apps. The same idea would apply through an Appium proxy.
- Automatically writing the missing assertions into test files. v1 only suggests them.
