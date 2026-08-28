# AGENTS.md

## Project overview

TypeScript monorepo for provisioning local Wire/Ethereum/Solana clusters and
running OPP FlowScenarios through a shared PhaseGroup → Phase → Step → Report
engine.

## Working rules

- Prefer minimal, targeted changes.
- Follow existing patterns before introducing new abstractions.
- Do not add dependencies without approval.
- For non-trivial changes, inspect surrounding code paths first.
- Read `CLAUDE.md` and the relevant `STYLE.md` sections; manifest rules are
  authoritative.
- Use pnpm only and run live flows through `scripts/run-flow.mjs` with the
  heartbeat monitor.
- Pass FlowScenario-specific CLI arguments after the runner's literal `--`.

## Commands

- install: `pnpm install`
- dev: `pnpm compile:watch`
- build: `pnpm build`
- test: `pnpm test`
- lint: `pnpm lint`
- typecheck: `pnpm exec tsc -b tsconfig.json --pretty false`

## Architecture notes

- Main entrypoints: `packages/cluster-tool/src/cli/index.ts`,
  `packages/flow-*/src/index.ts`, `scripts/run-flow.mjs`.
- Important modules: cluster orchestration under
  `packages/cluster-tool/src/orchestration`, runtime config under
  `packages/cluster-tool/src/config`, and reports under
  `packages/cluster-tool/src/report`.
- Sensitive areas: cluster keys, signing providers, process lifecycle, port
  allocation, chain identities, and external deployment configuration.
- Generated code / files to avoid editing directly: `lib/`, `dist/`,
  `*.tsbuildinfo`, generated OPP models, and sibling-repo build outputs.

## Change-specific rules

- If touching API contracts, update tests and consumers.
- If touching database schema, update migrations and rollback path.
- If touching auth, preserve existing middleware/order and verify edge cases.
- Every write, transaction, or process spawn must own a Step; cross-step state
  uses typed OutputKeys.
- Every port comes from BindConfigProvider; do not hand-select or probe ports
  outside the registry.

## Verification

Before finishing:

- run relevant tests
- run lint/typecheck if relevant
- verify behavior changed as intended
- summarize assumptions and remaining risks

## Security / safety

- Never commit secrets or edit `.env` values into source.
- Be careful with destructive scripts, migrations, and infra configs.
- Never include cluster keys, private keys, or credentials in reports or
  archives.
