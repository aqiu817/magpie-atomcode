# Contributing

## Development

Requirements: Node.js 20+ and npm. Bun is optional but supported because magpie's plugin host uses it.

```bash
npm test
npm run test:coverage
npm run pack:check
```

For coverage thresholds, use Node 24:

```bash
npm run test:coverage:enforce
```

## Pull requests

- Follow TDD: add or update a failing test before implementation.
- Keep changes focused and use Conventional Commit style for commits.
- Preserve the single-export rule in `index.mjs`; OpenCode treats every export as a plugin entry.
- Do not weaken origin checks, response bounds, credential handling, or redirect restrictions without a security rationale and regression tests.
- Update both `README.md` and `README.zh-CN.md` for user-visible behavior.
- Never include real tokens, `plugin-auth.json`, OAuth state values, account IDs, or unredacted logs.

## Protocol changes

Upstream protocols are unofficial and may change. Add an offline fixture for any new response shape and keep live-account probes manual and explicit because they consume quota.
