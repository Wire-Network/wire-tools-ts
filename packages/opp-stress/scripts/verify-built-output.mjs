#!/usr/bin/env node

import Assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import Fs from "node:fs"
import { createRequire } from "node:module"
import Os from "node:os"
import Path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ScriptFile = fileURLToPath(import.meta.url),
  Root = Path.resolve(Path.dirname(ScriptFile), "../../.."),
  FixtureFlag = "--fixture=tamper-referenced-artifact",
  Usage = `Usage: pnpm --filter @wireio/test-opp-stress run test:built -- [${FixtureFlag}]`
const Packages = [
  {
    name: "@wireio/debugging-shared",
    outputs: ["packages/debugging-shared/lib"]
  },
  {
    name: "@wireio/debugging-server",
    outputs: ["packages/debugging-server/lib", "packages/debugging-server/dist"]
  },
  {
    name: "@wireio/test-opp-stress",
    outputs: ["packages/opp-stress/lib"]
  },
  {
    name: "@wireio/test-flow-swap-stress-saturation",
    outputs: ["packages/flow-swap-stress-saturation/lib"]
  }
]

/** Create the built-output verifier over replaceable package/runtime boundaries.
 * @param {ReturnType<typeof createDefaultDependencies>} dependencies Package execution and fixture collaborators.
 * @returns {{verify: (tamper: boolean) => Promise<object>, runCli: (args: readonly string[]) => Promise<number>}} Import-safe verifier and CLI operations.
 */
export function createBuiltOutputTool(dependencies = createDefaultDependencies()) {
  const verify = async tamper => {
    const staleSentinel = Path.join(
      dependencies.root,
      "packages/opp-stress/lib",
      `.todo25-stale-${dependencies.randomUUID()}`
    )
    Fs.mkdirSync(Path.dirname(staleSentinel), { recursive: true })
    Fs.writeFileSync(staleSentinel, "stale\n")
    Packages.forEach(entry =>
      assertPackageScript(dependencies, entry.name, "clean")
    )
    Packages.flatMap(entry => entry.outputs).forEach(output =>
      Assert.equal(
        Fs.existsSync(Path.join(dependencies.root, output)),
        false,
        `clean left generated output: ${output}`
      )
    )
    Packages.forEach(entry =>
      assertPackageScript(dependencies, entry.name, "build")
    )
    Assert.equal(
      Fs.existsSync(staleSentinel),
      false,
      "stale sentinel survived rebuild"
    )
    const temporaryRoot = Fs.mkdtempSync(Path.join(Os.tmpdir(), "opp-stress-built-"))
    try {
      return {
        ...(await dependencies.verifyFixture(temporaryRoot, tamper)),
        sentinelRemoved: !Fs.existsSync(staleSentinel)
      }
    } finally {
      Fs.rmSync(temporaryRoot, { recursive: true, force: true })
    }
  }

  const runCli = async forwardedArgs => {
    const args =
      forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs
    if (args.includes("--help")) {
      dependencies.writeStdout(`${Usage}\n`)
      return 0
    }
    if (args.length > 1 || (args.length === 1 && args[0] !== FixtureFlag)) {
      dependencies.writeStderr(`${Usage}\n`)
      return 2
    }
    const tamper = args[0] === FixtureFlag
    dependencies.writeStdout(`${JSON.stringify(await verify(tamper))}\n`)
    return tamper ? 1 : 0
  }

  return { verify, runCli }
}

function createDefaultDependencies() {
  return {
    root: Root,
    randomUUID,
    runPackageScript: (packageName, script) =>
      spawnSync("pnpm", ["--filter", packageName, "run", script], {
        cwd: Root,
        stdio: "inherit"
      }),
    verifyFixture: (temporaryRoot, tamper) => verifyEmittedFixture(Root, temporaryRoot, tamper),
    writeStdout: text => process.stdout.write(text),
    writeStderr: text => process.stderr.write(text)
  }
}

function assertPackageScript(dependencies, packageName, script) {
  const result = dependencies.runPackageScript(packageName, script)
  Assert.equal(result.error, undefined, `${packageName} ${script} failed to start`)
  Assert.equal(result.signal, null, `${packageName} ${script} was interrupted`)
  Assert.equal(result.status, 0, `${packageName} ${script} exited ${result.status}`)
}

async function verifyEmittedFixture(root, temporaryRoot, tamper) {
  const built = await loadBuiltModules(root)
  Assert.equal(built.flow.isObservationDecimal("1"), true)
  const storageDir = Path.join(temporaryRoot, "opp")
  Fs.mkdirSync(storageDir)
  const envelopeData = built.models.Envelope.toBinary(
    built.models.Envelope.create({
      epochIndex: 7,
      epochEnvelopeIndex: 0,
      epochTimestamp: 1n,
      envelopeHash: new Uint8Array(32),
      previousEnvelopeHash: new Uint8Array(32),
      messages: []
    })
  )
  await built.persistence.EnvelopePersistence.persist({
    storageDir,
    envelopeData,
    batchOpName: "verify-built-output",
    endpointsType: built.models.DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
  })
  const strictResult = await built.reader.readEnvelopeIntegrity(
    storageDir,
    built.baseline.createEnvelopeBaseline([])
  )
  const metrics = await built.metrics.collectOppEnvelopeSaturationMetrics(
    storageDir
  )
  Assert.equal(strictResult.valid.length, 1)
  Assert.equal(strictResult.issues.length, 0)
  Assert.equal(metrics.envelopeCount, 1)
  Assert.equal(
    metrics.health.kind,
    built.metricTypes.OppEnvelopeTelemetryHealthKind.Healthy
  )

  const clusterPath = Path.join(temporaryRoot, "cluster")
  Fs.mkdirSync(clusterPath)
  Fs.writeFileSync(Path.join(clusterPath, "cluster-config.json"), "{}\n")
  const run = await built.runPersistence.RunEvidencePersistence.allocate({
    clusterPath,
    rampConfig: {
      initialCount: 3,
      multiplier: 3,
      maxCount: 243,
      phaseTimeoutMs: 240_000
    },
    requiredEndpoints: [built.runTypes.RunEvidenceEndpoint.OutpostEthereumDepot],
    provenance: {
      wireBuildPath: Path.join(temporaryRoot, "wire-build"),
      ethereumPath: Path.join(temporaryRoot, "ethereum"),
      solanaPath: Path.join(temporaryRoot, "solana")
    },
    startedAtMs: "100"
  })
  const snapshot = await run.captureClusterConfig()
  await run.publishSetup({
    schemaVersion: built.runTypes.RunEvidenceSchemaVersion,
    stage: built.runTypes.RunEvidenceStage.Setup,
    status: built.runTypes.RunEvidenceSetupStatus.Succeeded,
    startedAtMs: "101",
    endedAtMs: "102",
    clusterConfigCreated: true
  })
  if (tamper) {
    Fs.writeFileSync(
      Path.join(run.runDirectory, snapshot.path),
      '{"tampered":true}\n'
    )
  }
  const report = built.verifier.verifyRunEvidence(run.runDirectory)
  Assert.equal(report.schemaVersion, built.runTypes.RunEvidenceSchemaVersion)
  if (tamper) {
    Assert.equal(report.valid, false)
    Assert.ok(
      report.issues.some(
        issue =>
          issue.code ===
            built.verifier.RunEvidenceVerificationIssueCode.HashMismatch &&
          issue.path === snapshot.path
      ),
      "tamper did not produce the referenced-artifact hash mismatch"
    )
  } else {
    Assert.equal(report.valid, true)
    Assert.equal(
      report.verdict,
      built.verifier.RunEvidenceVerificationVerdict.InProgress
    )
  }
  return {
    runDirectory: run.runDirectory,
    verdict: report.verdict,
    valid: report.valid,
    issues: report.issues.map(issue => issue.code),
    strictValid: strictResult.valid.length,
    healthyEnvelopeCount: metrics.envelopeCount,
    tampered: tamper
  }
}

async function loadBuiltModules(root) {
  const sharedEsm = Path.join(root, "packages/debugging-shared/lib/esm")
  const serverPersistenceFile = Path.join(
    root,
    "packages/debugging-server/lib/cjs/routes/opp/EnvelopePersistence.js"
  )
  const oppOutput = Path.join(root, "packages/opp-stress/lib/out")
  const require = createRequire(import.meta.url)
  return {
    reader: await import(
      pathToFileURL(Path.join(sharedEsm, "opp/EnvelopeIntegrityReader.js")).href
    ),
    baseline: await import(
      pathToFileURL(Path.join(sharedEsm, "opp/envelopeBaseline.js")).href
    ),
    persistence: require(serverPersistenceFile),
    metrics: require(Path.join(oppOutput, "envelopeMetrics.js")),
    metricTypes: require(Path.join(oppOutput, "envelopeMetricTypes.js")),
    runPersistence: require(Path.join(oppOutput, "runEvidencePersistence.js")),
    runTypes: require(Path.join(oppOutput, "runEvidenceTypes.js")),
    verifier: require(Path.join(oppOutput, "runEvidenceVerifier.js")),
    flow: require(
      Path.join(
        root,
        "packages/flow-swap-stress-saturation/lib/out/flowObservationParserSupport.js"
      )
    ),
    models: createRequire(serverPersistenceFile)("@wireio/opp-typescript-models")
  }
}

if (process.argv[1] !== undefined && Path.resolve(process.argv[1]) === ScriptFile) {
  createBuiltOutputTool()
    .runCli(process.argv.slice(2))
    .then(exitCode => {
      process.exitCode = exitCode
    })
    .catch(error => {
      process.stderr.write(
        `built-output verification failed: ${error instanceof Error ? error.stack : String(error)}\n`
      )
      process.exitCode = 1
    })
}
