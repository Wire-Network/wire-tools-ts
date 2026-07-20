// =============================================================================
// wire-tools-ts eslint — MECHANICAL enforcement of the recurring violation
// classes from STYLE.md + wire-platform-manifest/.claude/rules/*.md
// (ts-style-idioms.md is the injected pointer to both).
//
// Scope discipline:
//  - Formatting belongs to prettier (.prettierrc.js): eslint-config-prettier
//    is applied LAST so no rule here can fight it.
//  - The tsconfig compiles with `strictNullChecks: false` (etc/tsconfig/
//    tsconfig.base.json) — no rule below assumes strict-null semantics, and
//    `eqeqeq` allows `!= null` (the sanctioned both-nullish guard).
//  - Syntactic rules only (no type-checked linting).
//  - `error` means the class is BANNED and the tree is clean of it;
//    pre-existing debt is grandfathered per-FILE (see the ratchet block) —
//    prefer-null-over-undefined.md forbids sweeping untouched code, so the
//    list burns down as files are touched, never via a bulk sweep.
//
// Deliberately NOT enforced here (and why):
//  - `new Promise` (STYLE.md prefers Deferred.useCallback for promisifying
//    callback APIs): ~30 legitimate timer/race sites exist — the shape
//    STYLE.md's own timer-hygiene example uses — and the banned promisify
//    case is not syntactically separable from them. Review + STYLE.md govern.
//  - Naming standards (assert*/create*/plan*/run*), orchestration-model
//    rules, facade/options design: semantic — STYLE.md governs.
// =============================================================================
import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import prettier from "eslint-config-prettier"

// STYLE.md "match() over switch always".
const BanSwitch = {
  selector: "SwitchStatement",
  message:
    "Use match() from ts-pattern (STYLE.md 'match() over switch always')."
}

// STYLE.md "Extracted Helper Functions": an immediately-invoked function
// expression hides a nameable operation inside an expression slot — extract a
// named local helper (the claim/pair/pairs pattern) or use
// asOption().tap().get() (2026-07-15 BindConfig incident, twice).
const BanInlineIife = {
  selector:
    "CallExpression[callee.type='ArrowFunctionExpression'], CallExpression[callee.type='FunctionExpression']",
  message:
    "No inline IIFEs — extract a named local helper (STYLE.md 'Extracted Helper Functions')."
}

// prefer-null-over-undefined.md, strictNullChecks:false section: NEVER add a
// `| null` union to a return type — the compiler doesn't enforce it, so it is
// dead ceremony; write the plain type, callers guard with `!= null`.
const BanNullUnionReturn = {
  selector:
    ":function > TSTypeAnnotation.returnType TSUnionType > TSNullKeyword",
  message:
    "No `| null` return-type ceremony — strictNullChecks is OFF, the union is unenforced clutter; write the plain type (prefer-null-over-undefined.md)."
}

// Author law (2026-07-15): no inline (anonymous) object types — every object
// shape gets a NAMED interface/type. Inline function types in parameter
// position stay allowed (STYLE.md's own signatures use them).
const BanInlineTypeLiteral = {
  selector: "TSTypeLiteral",
  message:
    "No inline object types — declare a named interface/type (author law; see STYLE.md 'Interface Design')."
}

// no-pick-in-parameter-types.md (author law, 2026-07-17): a parameter demands
// the minimum REAL data — one field → the indexed-access type
// (`alive: ProcessLivenessSnapshot["alive"]`), several optional fields →
// Partial<T>, the real object → T. A Pick<T,K> parameter forces callers to
// assemble a synthetic one-off object that is neither the domain object nor a
// plain value. Return types and genuine data-model projections are out of
// scope (the selector matches parameter positions only).
const BanPickParameter = {
  selector:
    ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, TSDeclareFunction, TSEmptyBodyFunctionExpression, TSMethodSignature, TSFunctionType) > :matches(Identifier, ObjectPattern, ArrayPattern, RestElement, AssignmentPattern, TSParameterProperty) TSTypeReference[typeName.name='Pick']",
  message:
    'No Pick<T,K> parameter contracts — one field → indexed access (T["field"]), several optional fields → Partial<T>, otherwise T (no-pick-in-parameter-types.md).'
}

// string-unions-derive-from-enums.md (author law, 2026-07-18): a hand-written
// union of string literals is a closed set without its enum. Declare the
// identity enum and use its members — or, when a union TYPE is genuinely
// needed, derive it from an existing enum (`${Enum}` template /
// keyof typeof Enum / a union of Enum.member types) or reuse the generated
// type that already carries the spellings.
const BanStringLiteralUnion = {
  selector: "TSUnionType > TSLiteralType > Literal[raw=/^[\"']/]",
  message:
    "No hand-written string-literal unions — declare the identity enum, or derive the union from one (`${Enum}` / keyof typeof Enum) (string-unions-derive-from-enums.md)."
}

// STYLE.md "asOption" carve-out (author law, 2026-07-18): wrapping an
// ALREADY-AWAITED value in asOption just to tap a side effect and get() it
// back is ceremony — bind the value and use plain statements (or a genuine
// Future pipeline when composing async stages).
const BanAsOptionAwait = {
  selector: "CallExpression[callee.name='asOption'] > AwaitExpression",
  message:
    "Never asOption(await …) — bind the awaited value and use plain statements (or a genuine Future pipeline) (STYLE.md 'asOption')."
}

// STYLE.md "Destructuring over member-coalesce" (author law, 2026-07-18):
// `const local = obj.member ?? Default` re-spells the member name at every
// pull — destructure with defaults/renames instead:
// `const { member: local = Default } = obj`. Computed members (`arr[0]`) and
// optional chains stay accessor-form.
const BanMemberCoalesceDeclarator = {
  selector:
    "VariableDeclarator > LogicalExpression.init[operator='??'] > MemberExpression.left[computed=false]",
  message:
    "Destructure with a default — `const { member: local = Default } = obj` — not `const local = obj.member ?? Default` (STYLE.md 'Destructuring over member-coalesce')."
}

// Pre-existing `| null` return-type debt, grandfathered — prefer-null forbids
// sweeping untouched files. RATCHET: when you touch one of these files, clean
// its return types and DELETE its entry. Never add an entry.
const NullUnionReturnDebtFiles = [
  "packages/cluster-tool/src/clients/solana/SolanaClient.ts",
  "packages/cluster-tool/src/clients/wire/WireClient.ts",
  "packages/cluster-tool/src/clients/wire/WireWallet.ts",
  "packages/cluster-tool/src/orchestration/ClusterBuildPhase.ts",
  "packages/cluster-tool/src/orchestration/OutputStore.ts",
  "packages/cluster-tool/src/report/tools/StepExtraRecorder.ts",
  "packages/cluster-tool/src/utils/fsUtils.ts",
  "packages/debugging-client-tool-tui/src/cli.ts",
  "packages/debugging-client-tool-tui/src/features/opp/OPPTrackingService.ts",
  "packages/debugging-client-tool-tui/src/features/opp/util/EpochSummary.ts",
  "packages/debugging-client-tool-tui/src/store/opp/OPPSelectors.ts",
  "packages/debugging-server/src/routes/opp/OPPRoutes.ts",
  "packages/debugging-shared/src/opp/EnvelopeStorageKey.ts",
  "packages/debugging-shared/src/utils/ProtobufHelpers.ts",
  "packages/test-app-server/src/services/key.ts",
  "packages/test-app-server/src/services/link.ts",
  "packages/cluster-tool/src/clients/wire/RecordingFetchProvider.ts",
  "packages/debugging-client-tool-tui/src/features/opp/util/AttestationCodec.ts",
  "packages/debugging-client-tool-tui/src/features/process-monitor/util/lineRender.tsx",
  "packages/debugging-server/src/streams/EnvelopeWatchStream.ts",
  "packages/debugging-shared/src/opp/EnvelopeRecordReader.ts"
]

// Pre-existing inline-object-type debt, grandfathered under the same ratchet:
// touch a file → name its object types → DELETE its entry. Never add one.
const InlineTypeLiteralDebtFiles = [
  "packages/cluster-tool/src/clients/solana/RecordingConnection.ts",
  "packages/cluster-tool/src/clients/wire/RecordingFetchProvider.ts",
  "packages/cluster-tool/src/clients/wire/WireClient.ts",
  "packages/cluster-tool/src/clients/wire/WireWallet.ts",
  "packages/cluster-tool/src/clients/wire/clio/ClioRunner.ts",
  "packages/cluster-tool/src/orchestration/steps/RegistrySteps.ts",
  "packages/cluster-tool/src/tools/ethereum/EthereumFundingTool.ts",
  "packages/cluster-tool/src/tools/ethereum/EthereumNodeOwnerNftTool.ts",
  "packages/cluster-tool/src/tools/ethereum/EthereumSwapTool.ts",
  "packages/cluster-tool/src/tools/wire/WireDclaimSeedTool.ts",
  "packages/cluster-tool/src/tools/wire/WireUnderwriterTool.ts",
  "packages/cluster-tool/src/types/KeyPair.ts",
  "packages/cluster-tool/src/utils/ethereumUtils.ts",
  "packages/cluster-tool/tests/cli/ClusterBuildOptionsArgs.test.ts",
  "packages/cluster-tool/tests/clients/recordingClients.test.ts",
  "packages/cluster-tool/tests/config/NodeConfig.test.ts",
  "packages/cluster-tool/tests/orchestration/ClusterBuildPhase.test.ts",
  "packages/cluster-tool/tests/orchestration/OutputStore.test.ts",
  "packages/cluster-tool/tests/report/StepExtraRecorder.test.ts",
  "packages/cluster-tool/tests/tools/solana/SolanaOutpostProgramTool.test.ts",
  "packages/cluster-tool/tests/tools/wire/WireDclaimSeedTool.test.ts",
  "packages/cluster-tool/tests/tools/wire/WireOperatorProvisioningTool.test.ts",
  "packages/cluster-tool/tests/tools/wire/WireReserveTool.test.ts",
  "packages/cluster-tool/tests/tools/wire/WireUnderwriterTool.test.ts",
  "packages/debugging-client-shared/tests/subscriptions/DebuggingSubscription.test.ts",
  "packages/debugging-client-tool-tui/src/cli.ts",
  "packages/debugging-client-tool-tui/src/components/PanelComponent.ts",
  "packages/debugging-client-tool-tui/src/components/StatusBarComponent.ts",
  "packages/debugging-client-tool-tui/src/features/opp/panels/EpochTrackerPanel.tsx",
  "packages/debugging-client-tool-tui/src/features/opp/routes/EpochDetailRoute.tsx",
  "packages/debugging-client-tool-tui/src/features/opp/util/AttestationCodec.ts",
  "packages/debugging-client-tool-tui/src/features/process-monitor/panels/LogViewerJSONLine.tsx",
  "packages/debugging-client-tool-tui/src/features/process-monitor/panels/ProcessMonitorPanel.tsx",
  "packages/debugging-client-tool-tui/tests/components/modals/ExitConfirmModal.test.tsx",
  "packages/debugging-client-tool-tui/tests/features/process-monitor/panels/LogViewerJSONLine.test.tsx",
  "packages/debugging-client-tool-tui/tests/features/process-monitor/panels/LogViewerTextLine.test.tsx",
  "packages/debugging-client-tool-tui/tests/hooks/useMultiKeyTrigger.test.tsx",
  "packages/debugging-client-tool-tui/tests/logging/LoggingManager.test.ts",
  "packages/debugging-client-tool-tui/tests/store/middleware/createReduxFileLogger.test.ts",
  "packages/debugging-server/src/routes/opp/OPPRoutes.ts",
  "packages/debugging-server/src/streams/EnvelopeWatchStream.ts",
  "packages/debugging-shared/src/opp/EnvelopeRecordReader.ts",
  "packages/debugging-shared/src/rpc/Paths.ts",
  "packages/flow-reserve-lifecycle/src/steps/ReserveLifecycleScenarioReserveSteps.ts",
  "packages/flow-swap-private-reserves/src/SwapPrivateReservesScenarioArtifacts.ts",
  "packages/flow-swap-private-reserves/src/steps/SwapPrivateReservesScenarioReserveSteps.ts",
  "packages/test-app-server/src/App.tsx",
  "packages/test-app-server/src/components/Toast.tsx"
]

// One config block per exemption signature: a debt file keeps every ban
// EXCEPT the one(s) it is grandfathered for. Computed, so the two ratchet
// lists compose without a hand-maintained matrix.
const AllBans = [
  BanSwitch,
  BanInlineIife,
  BanNullUnionReturn,
  BanInlineTypeLiteral,
  BanPickParameter,
  BanStringLiteralUnion,
  BanAsOptionAwait,
  BanMemberCoalesceDeclarator
]
const debtExemptionBlocks = (() => {
  const exemptionsByFile = new Map()
  NullUnionReturnDebtFiles.forEach(file =>
    exemptionsByFile.set(file, new Set([BanNullUnionReturn.selector]))
  )
  InlineTypeLiteralDebtFiles.forEach(file => {
    if (!exemptionsByFile.has(file)) exemptionsByFile.set(file, new Set())
    exemptionsByFile.get(file).add(BanInlineTypeLiteral.selector)
  })
  const filesBySignature = new Map()
  exemptionsByFile.forEach((exempted, file) => {
    const signature = [...exempted].sort().join("|")
    if (!filesBySignature.has(signature)) filesBySignature.set(signature, [])
    filesBySignature.get(signature).push(file)
  })
  return [...filesBySignature.entries()].map(([signature, files]) => ({
    files,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...AllBans.filter(ban => !signature.includes(ban.selector))
      ]
    }
  }))
})()

export default tseslint.config(
  {
    ignores: [
      "**/lib/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.d.ts",
      // TypeScript is the enforcement target: the style laws + tsconfig
      // govern .ts/.tsx. Plain JS (configs, .pnpmfile.cjs, vendored assets,
      // Node CLI scripts — whose console IS their user interface per the
      // use-logging-framework.md carve-out) is prettier/tsc territory.
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs",
      "**/*.jsx",
      "scripts/**",
      "packages/*/scripts/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // use-logging-framework.md: console is banned; the framework writes
      // through (jest buffers console.*). Carve-outs below.
      "no-console": "error",

      "no-restricted-syntax": ["error", ...AllBans],

      // standard-names-not-invented.md: get-or-throw helpers are assert*,
      // NEVER require* (collides with the Node global; author standard).
      "id-match": [
        "error",
        "^(?!require[A-Z]).*$",
        { properties: false, classFields: false, onlyDeclarations: true }
      ],

      // STYLE.md "No src/ traversal in import/export — EVER".
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/src/*", "**/src"],
              message:
                "No src/ in import specifiers — use the package alias or the barrel (STYLE.md 'No src/ traversal')."
            }
          ]
        }
      ],

      // per-file-logger-and-std-streams.md: raw stream writes live ONLY in
      // the logging appenders (override below).
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "stdout",
          message:
            "process.stdout belongs to the logging appenders only — use getStdoutLogger() (per-file-logger-and-std-streams.md)."
        },
        {
          object: "process",
          property: "stderr",
          message:
            "process.stderr belongs to the logging appenders only — use the logger (per-file-logger-and-std-streams.md)."
        }
      ],

      // prefer-null-over-undefined.md prescribes `!= null` as the guard —
      // eqeqeq must not fight it.
      eqeqeq: ["error", "always", { null: "ignore" }],

      // precise-types-no-unknown-shortcut.md: `any` only at genuine
      // third-party boundaries. Pre-existing debt exists → warn (no sweeps).
      "@typescript-eslint/no-explicit-any": "warn",

      // Defaults that fight house idioms or the loose tsconfig.
      "@typescript-eslint/no-namespace": "off", // companion namespaces ARE the style
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ],
      "@typescript-eslint/no-require-imports": "off", // CJS package family
      // Off deliberately: the house style USES empty object shapes as
      // semantic structure — `interface FooConfig extends Required<FooOptions>
      // {}` (STYLE.md three-layer options), empty NAMED marker interfaces for
      // request shapes (ClusterRequests), and `{}` generic defaults. The rule
      // fights the named-types-everywhere philosophy.
      "@typescript-eslint/no-empty-object-type": "off",
      // New in eslint 10 recommended; `{ cause }` chaining is NOT a codified
      // house law and enforcing it would force edits to untouched files.
      // Candidate for adoption later — off deliberately, not forgotten.
      "preserve-caught-error": "off",
      "prefer-const": "error",
      "no-var": "error"
    }
  },
  ...debtExemptionBlocks,
  {
    // CLI bin entry points (console IS the user interface —
    // use-logging-framework.md carve-out) and the test-app-server's BROWSER
    // React components (their console is the browser devtools; the logging
    // framework targets the Node side).
    files: [
      "packages/*/src/bin/**",
      "packages/*/bin/**",
      "packages/test-app-server/src/components/**"
    ],
    rules: { "no-console": "off" }
  },
  {
    // The sanctioned raw-stream homes (per-file-logger-and-std-streams.md):
    // the routing/file appenders + each package's logger.ts — plus the tests
    // that stub or assert ON those streams by design (the appender's own
    // test, the TUI jest.setup that silences ink's stream writes).
    files: [
      "**/logging/*Appender.ts",
      "**/logger.ts",
      "**/logging/logger.ts",
      "**/tests/logging/*Appender.test.ts",
      "**/tests/jest.setup.ts"
    ],
    rules: { "no-restricted-properties": "off" }
  },
  prettier
)
