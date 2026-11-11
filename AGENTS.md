# AGENTS.md

## Project overview
TypeScript cluster harness, cross-chain flow scenarios and debugging tools for Wire.

## Working rules
- Prefer minimal, targeted changes and existing orchestration steps.
- Read `CLAUDE.md` and `STYLE.md`; they define the build, port and flow rules.
- Do not add dependencies without approval.
- Inspect callers and scenario prerequisites before changing contract steps.

## Commands
- install: `pnpm install` (pinned package manager; Node >=24.9)
- dev: `pnpm compile:watch`
- build: `pnpm build`
- test: `pnpm test`; live flows use `node scripts/run-flow.mjs` and the heartbeat monitor.
- lint: `pnpm lint`
- typecheck: `pnpm exec tsc -b <affected-package>`

## Architecture notes
- Main entrypoints: `packages/cluster-tool`, `packages/flow-*`, `scripts/run-flow.mjs`.
- Important modules: cluster orchestration steps, chain clients and reporting.
- Sensitive areas: signing, bootstrap state and host-global port allocation.
- Generated code / files to avoid editing directly: `lib/`, `dist/`, producer-owned OPP models.

## Change-specific rules
- Update contract callers and flow assertions together; do not pre-create NFT claim accounts.
- Obtain every port from `BindConfigProvider`, including tests.
- Preserve failed assertions and canonical flow reporting; do not manufacture successful settlement.

## Verification
Before finishing:
- Run affected types and focused tests; identify unrun live flows.
- Verify behavior changed as intended and summarize remaining risks.

## Security / safety
- Never commit secrets, `.env` values or signed payloads.
- Infrastructure changes, deployments and destructive operations require explicit authorization.
