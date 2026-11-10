# Security Policy

## Supported versions

Until 1.0, only the latest release gets security fixes.

## Reporting a vulnerability

Please **don't** open a public issue. Report it privately through GitHub instead:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what impact you expect.

You should get an acknowledgement within a few days. A fix or mitigation will be coordinated with you before anything is disclosed.

## How catchrate handles your data

### Recordings are redacted by default

`record` saves each test's API responses to `.catchrate/recordings/`. Before anything is written:
- Values under credential-like JSON keys are replaced with `[REDACTED]`, including everything nested beneath them. Examples: `password`, `*token*`, `apiKey`, `authorization`, `cookie`, `secret`, `credentials`, `ssn`, `cvv`.
- Strings that look like JWTs, `Bearer` tokens, `sk-…` API keys, GitHub tokens or AWS access keys are masked wherever they appear, including in the page snapshot.
- Query strings are dropped from recorded URLs.

To mask project-specific fields, add `--redact-keys accountNumber,dob`. `--no-redact` turns redaction off; avoid it, especially with `--llm`.

Redaction is pattern-based and can't catch everything (a secret under an innocent key name, or personal data shown on the page). The recordings and the `.catchrate/` folder are git-ignored by default; keep them that way.

### `--llm` sends data to the model provider you choose

The provider receives the test's source file, the redacted responses and the redacted page snapshot.
- With `--provider ollama` or `lmstudio`, nothing leaves your machine.
- With a hosted provider (Claude, OpenAI, OpenRouter …), don't use `--llm` on suites that run against production or real customer data.

API keys are read only from the environment or a local `.env` file, which is git-ignored. They're never written to recordings, mutants or reports, and they're masked if a server echoes them in an error. A key is never sent over plain `http://` to another machine: use `https://`. Plain HTTP is allowed only for `localhost`.

### Model output is treated as untrusted

Recorded responses and test code can contain text that tries to steer the model (prompt injection). The worst that can do is produce useless mutants:
- The model can only return mutation data in a fixed JSON schema: a request target plus JSON Patch-style operations.
- Each mutant is validated and dry-run, and is never executed as code.
- JSON Pointers into `__proto__`, `constructor` and `prototype` are rejected.

### `mutants.json` is validated

You're meant to commit `mutants.json` and re-run it in CI, so it's validated on every `run`:
- Ids must match `m_<hex>`. Ids become file names, and a tampered id must not be able to write outside the output folder; file writes are also checked to stay inside it.
- Operations must be known ones, and risk categories must be valid.

### Reports are safe to post as PR comments

Report text that comes from tests, responses or a model is escaped. It can't inject HTML, live links or images, or break out of the report's own markup.

### The demo app

`examples/shop` listens on `127.0.0.1` only and sends `X-Content-Type-Options` and `Content-Security-Policy` headers. Its `sessionToken` is fake and exists to show redaction working; CI fails if that token ever appears in a recording.

## Repository hardening

- **Least privilege in CI.** Workflows run with `contents: read`; CodeQL adds `security-events: write` only for its own job. Checkouts don't keep the GitHub token (`persist-credentials: false`).
- **Pinned actions.** Third-party actions are pinned to full commit SHAs. Dependabot updates them weekly, along with npm dependencies.
- **Dependency checks.** CI fails on high or critical advisories in runtime dependencies and verifies npm package signatures.
- **Code scanning.** CodeQL with the `security-extended` queries runs on every push, every pull request, and weekly.

After publishing, turn on these in **Settings → Code security**:
- Private vulnerability reporting
- Dependabot alerts
- Secret scanning with push protection
