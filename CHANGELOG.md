# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **HTML report.** `run` now also writes `report.html`, a single self-contained page:
  - overall and per-test scores, with missed bugs first
  - filters by outcome and risk
  - a copy button for each suggested assertion
  - light and dark mode, and phone layouts

  The page makes no network requests, and its Content-Security-Policy allows only its own inline script, pinned by hash.
- `--html <file>` for `diff` (before/after page) and `report` (re-render a saved `report.json`).
- CI uploads the HTML reports as an artifact. README screenshots are in `docs/images/`.
- `--provider` option to propose mutants with backends other than Claude:
  - `openai`: OpenAI, or any OpenAI-compatible API through `--base-url` (OpenRouter, Gemini's compatible endpoint, vLLM, llama.cpp).
  - `ollama` and `lmstudio`: presets for local models, so no data leaves the machine.
- Automatic step-down of structured output for servers that don't support it: JSON schema, then JSON mode, then plain text.
- Setup check before any test is sent: invalid keys, unreachable servers and unknown models stop the run with a clear message (`SetupError`).
- `CATCHRATE_API_KEY` for any OpenAI-compatible server.

### Changed

- The LLM code is split into a model-agnostic part (`llm.ts`: prompt, schema, validation) and providers (`src/providers/`).

### Security

- **Secret redaction in recordings.** Values under credential-like keys (and everything beneath them) are masked, along with JWT, Bearer, `sk-…`, GitHub and AWS key patterns anywhere in bodies and page snapshots. Query strings are dropped from recorded URLs. New `--redact-keys` and `--no-redact` options.
- **`mutants.json` is validated on load.** Ids must match `m_<hex>`, and file writes are confined to the output folder, so a tampered file can't write elsewhere.
- **JSON Pointers can't reach `__proto__`, `constructor` or `prototype`.**
- **Report text from tests, responses and models is escaped:** no raw HTML, no live links, no breaking out of `<details>` blocks.
- **The OpenAI-compatible provider is stricter about keys and URLs.** It refuses to send an API key over plain HTTP to a non-local host, rejects non-http(s) base URLs and URLs with embedded credentials, and masks keys echoed in server errors.
- **The demo server is local only.** It binds to `127.0.0.1` and sends `X-Content-Type-Options` and `Content-Security-Policy` headers.
- **CI is hardened:**
  - Actions are pinned to commit SHAs, and checkouts use `persist-credentials: false`.
  - Jobs have timeouts.
  - New dependency audit and npm signature check.
  - New CodeQL workflow.
  - CI fails if the demo's fake token appears in a recording.
- Content hashes now use SHA-256, and run ids use `crypto.randomUUID`.

### Changed

- **Each test runs unchanged twice** (first and last) instead of once. A failure in either run marks the test unstable, which catches more flaky tests.
- **The offline generator blanks string values** (a realistic "missing data" bug) when no sibling value is available, instead of reversing them.
- **Formatting fields get their own mutants,** with a hint to assert the exact formatted text. Covers `digits`, `decimals`, `precision`, `currency`, `locale`, `unit`, `timezone` and similar fields, which change how values look without appearing on the page.
- **A lone digit next to letters doesn't count as visible.** The "2" in a "2h" button no longer makes the value `2` count as shown on the page.

### Fixed

- **"No visible change" didn't work on pages with live data.** Any page with a clock, ticker or live prices looked different on every run, so invisible bugs were counted as missed. Found on a real trading-chart suite, where it understated the catch rate (32% instead of 52%). Live lines are now detected from the two control runs, and only their format is compared.
- **Tagged tests were never selected.** Tests declared with `{ tag: ... }` were reported as missing during `run`, because Playwright appends tags to the title that `--grep` matches against.
- **One bad request downgraded the output format for the whole run.** The OpenAI-compatible provider treated any HTTP 400 as "structured output unsupported" and used a weaker response format from then on. It now steps down only when the error is about the response format; other errors fail just that test.
- **Bad numeric options were caught late.** They're now checked before any work starts: `--max-per-test` 1–50, `--min-score` 0–100, and `--workers` and `--timeout` at least 1. Previously a bad `--min-score` surfaced only after a full audit.
- **Run data piled up.** `plans/` and `outcomes/` are cleared at the start of each run instead of growing forever.
- **Near-duplicate mutants from nested lists.** Lists inside later list items no longer produce them.
- **Garbled error message.** With a local OpenAI-compatible server, the "is it running?" hint no longer says "model server server".
- The CI report upload skipped the hidden `.catchrate/` folder, so the artifact was silently empty. It now uploads, and fails if no files are found.
- The offline generator no longer skips boolean fields such as `paid` or `valid`. Its identifier check matched any key ending in "id".
- Short strings such as `ok` no longer count as visible on the page when they only appear inside a longer word such as `broken`.
- Test titles containing quotes or angle brackets no longer break the markup of the LLM prompt.

## [0.1.0] - 2026-11-09

### Added

- Playwright fixture (`catchrate/fixture`) with two modes:
  - **record:** saves each test's API responses and a snapshot of the final page.
  - **mutate:** serves one mutated response per repeat of a test.
- Mutation operations: a JSON Patch subset (`replace`, `remove`, `add`, `move`, `copy`) plus `status` and `setBody`. Every mutant is validated and dry-run before use.
- Offline mutant generator that targets values visible on the page, drops list items, and simulates server errors.
- Claude mutant generator (`--llm`): structured JSON output, server-side refusal fallback, and a credential check before any test is sent.
- Runner that runs an unmutated control plus every mutant in one Playwright process per test. Each mutant is classified as killed, survived, not reached, no visible change, skipped or error.
- Markdown and JSON reports with a suggested assertion for every missed bug.
- `diff` command that flags tests that stopped catching bugs, with exit code 1 for CI gating.
- Demo shop with strong, medium, weak and "healed" tests.
- Automatic `.env` loading in the CLI.

[Unreleased]: https://github.com/jeanljh/catchrate/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jeanljh/catchrate/releases/tag/v0.1.0
