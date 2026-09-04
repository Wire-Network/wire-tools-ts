# AGENTS.md

## Project overview
TypeScript cluster harness and end-to-end FlowScenario suites for the Wire OPP stack.

## Working rules
- Prefer minimal, targeted changes.
- Follow existing patterns before introducing new abstractions.
- Do not add dependencies without approval.
- For non-trivial changes, inspect surrounding code paths first.

## Commands
- install: `pnpm install`
- dev: `pnpm compile:watch`
- build: `pnpm build`
- test: `pnpm test`
- lint: `pnpm lint`
- typecheck: `pnpm compile`

## Architecture notes
- Main entrypoints: `packages/cluster-tool/src/cli` and each `packages/flow-*/src/index.ts`.
- Important modules: `packages/cluster-tool/src/orchestration`, `config`, `cluster`, and `report`.
- Sensitive areas: process lifecycle, generated/persisted keys, bootstrap ordering, and external-chain transactions.
- Generated code / files to avoid editing directly: `lib/`, `*.tsbuildinfo`, and generated contract types.

## Change-specific rules
- If touching API contracts, update tests and consumers.
- If touching database schema, update migrations and rollback path.
- If touching auth, preserve existing middleware/order and verify edge cases.

## Verification
Before finishing:
- run relevant tests
- run lint/typecheck if relevant
- verify behavior changed as intended
- summarize assumptions and remaining risks

## Security / safety
- Never commit secrets or edit `.env` values into source.
- Be careful with destructive scripts, migrations, and infra configs.
