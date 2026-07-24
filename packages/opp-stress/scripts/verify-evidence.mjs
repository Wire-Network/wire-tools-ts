#!/usr/bin/env node

import Path from "node:path"

import verifierModule from "../lib/out/runEvidenceVerifier.js"

const Usage =
    "Usage: pnpm --filter @wireio/test-opp-stress exec node scripts/verify-evidence.mjs <runDir> [--json]\n   or: pnpm --filter @wireio/test-opp-stress exec node scripts/verify-evidence.mjs --run-dir <absoluteRunDir> [--json]\nBuild prerequisite: pnpm --filter @wireio/test-opp-stress build",
  invocation = parseInvocation(process.argv.slice(2))

if (invocation === null) {
  process.stderr.write(`${Usage}\n`)
  process.exitCode = 2
} else {
  try {
    const report = verifierModule.verifyRunEvidence(invocation.runDirectory)
    if (invocation.json) process.stdout.write(`${JSON.stringify(report)}\n`)
    else {
      process.stdout.write(
        `${report.verdict} lifecycle=${report.lifecycle ?? "unknown"} issues=${report.issues.length} checked=${report.checkedFiles.length}\n`
      )
      report.issues.forEach(issue =>
        process.stdout.write(`${issue.code} ${issue.path}: ${issue.detail}\n`)
      )
    }
    process.exitCode = report.valid ? (report.verifiedSaturated ? 0 : 1) : 2
  } catch (error) {
    process.stderr.write(
      `evidence verifier invocation failed: ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exitCode = 2
  }
}

function parseInvocation(args) {
  let runDirectory = null,
    json = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--json") {
      if (json) return null
      json = true
    } else if (argument === "--run-dir") {
      if (runDirectory !== null) return null
      runDirectory = args[index + 1] ?? null
      index += 1
    } else if (argument.startsWith("--") || runDirectory !== null) return null
    else runDirectory = argument
  }
  return runDirectory === null ||
    !Path.isAbsolute(runDirectory) ||
    Path.resolve(runDirectory) !== runDirectory
    ? null
    : { runDirectory, json }
}
