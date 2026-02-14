# Contributing

## Scope

This repository powers a production MCP server for web perception and action execution.

## Development setup

```bash
npm install
npx playwright install --with-deps chromium
npm run build
npm run lint
npm test
```

## Branching and commits

- Keep changes atomic.
- Use one functional change per commit.
- Document any protocol or schema changes in `CHANGELOG.md`.

## Testing and gates

Before opening PRs, run:

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm test`
- `npm run benchmark`

## Security checks

- Keep URL allowlist/denylist logic explicit.
- Never commit traces with secrets.
- Keep `maskSecrets` logic active for logs and action text.
