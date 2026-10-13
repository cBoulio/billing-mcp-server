# billing-mcp-server

TypeScript MCP server (stdio) that connects Claude to Larkspur Cloud, a fictional billing system.
Seed data mirrors `support-agent-evals` (same ids and values); keep them in sync if either changes.

## Commands

- `npm ci` - install (the `.npmrc` sets `legacy-peer-deps` to work around an npm 10 peer bug)
- `npm run build` - compile `src/` to `dist/` with `tsc`
- `npm test` - vitest: domain, store, and in-process MCP client/server tests
- `npm run lint` - typecheck everything, including tests
- `npm run smoke` - spawn `dist/index.js` over stdio and call it (build first)
- `npm start` - run the server on stdio

## Layout

- `src/data.ts` seed data and constants, `src/policy.ts` policy text and date helpers
- `src/billing.ts` domain service and guardrails, `src/store.ts` state, `src/audit.ts` audit log
- `src/server.ts` MCP tools/resources/prompts, `src/index.ts` CLI entry

## Rules

- This is a public repo. No secrets, tokens, or real customer data; all data is fictional.
- Nothing about Caleb's employer, clients, or job search goes in this repo.
- Never write to stdout from server code: it is the JSON-RPC channel. Use stderr.
- Policy that the server enforces lives in `BillingService`, not in tool handlers.
- Pin exact dependency versions. Run lint, test, and smoke before calling a change done.
