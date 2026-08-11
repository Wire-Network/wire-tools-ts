# AGENTS.md

## Project overview
TypeScript monorepo for WIRE cluster orchestration, flow scenarios, readiness diagnostics, and debugging tools.

## Working rules
- Prefer minimal, targeted changes.
- Follow the orchestration and naming rules in `CLAUDE.md` and `STYLE.md`.
- Do not add dependencies without approval.
- Inspect adjacent flow and cluster-tool patterns before adding abstractions.

## Commands
- install: `pnpm install`
- dev: use the canonical `scripts/run-flow.mjs` runner documented in `CLAUDE.md`
- build: `pnpm build`
- test: `pnpm test`
- lint: `pnpm lint`
- typecheck: `pnpm build`

## Architecture notes
- Main entrypoints: `packages/cluster-tool/src/` and `packages/flow-*/src/`.
- Important modules: orchestration Steps/Phases/PhaseGroups, chain clients, process management, reports, and flow contexts.
- Sensitive areas: OPP protocol timing, bind-registry ports, process cleanup, generated contract types, and cross-chain custody logic.
- Generated code must be updated through its owning generator, never edited directly.

## Change-specific rules
- If touching contract actions or tables, use generated SDK types and update tests.
- If touching flow behavior, preserve Report evidence and the canonical runner contract.
- If touching process/network configuration, obtain every port from `BindConfigProvider`.

## Verification
Before finishing:
- run relevant tests
- run lint/typecheck if relevant
- verify behavior changed as intended
- summarize assumptions and remaining risks

## Security / safety
- Never commit secrets or edit `.env` values into source.
- Be careful with destructive scripts, migrations, and infrastructure configuration.
