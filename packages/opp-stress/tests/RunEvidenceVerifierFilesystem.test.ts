import { execFileSync } from "node:child_process"
import Fs = require("node:fs")
import * as Os from "node:os"
import * as Path from "node:path"
import { createServer } from "node:net"

import {
  RunEvidencePath,
  RunEvidenceVerificationIssueCode,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import { createVerifierFixture } from "./runEvidenceVerifierTestSupport.js"

describe("run evidence verifier filesystem boundary", () => {
  it.each([
    [
      "missing",
      (runDirectory: string) =>
        Fs.rmSync(Path.join(runDirectory, RunEvidencePath.Terminal))
    ],
    [
      "extra",
      (runDirectory: string) =>
        Fs.writeFileSync(Path.join(runDirectory, "extra.json"), "{}")
    ],
    [
      "nested",
      (runDirectory: string) =>
        Fs.mkdirSync(
          Path.join(runDirectory, RunEvidencePath.Iterations, "nested")
        )
    ]
  ])("rejects %s topology entries", (_label, mutate) => {
    // Given: canonical evidence changed after publisher completion.
    const fixture = createVerifierFixture()
    try {
      mutate(fixture.runDirectory)

      // When: the complete tree is safely enumerated.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: undeclared, missing, and nested entries invalidate evidence.
      expect(report.valid).toBe(false)
      expect(report.issues.length).toBeGreaterThan(0)
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects a symlinked evidence file", () => {
    // Given: terminal.json is replaced by a symlink to bytes outside the run.
    const fixture = createVerifierFixture(),
      external = Path.join(Os.tmpdir(), `terminal-target-${process.pid}.json`),
      terminal = Path.join(fixture.runDirectory, RunEvidencePath.Terminal)
    try {
      Fs.copyFileSync(terminal, external)
      Fs.rmSync(terminal)
      Fs.symlinkSync(external, terminal)

      // When: no-follow descriptor validation inspects the terminal ref.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: the symlink is an evidence issue rather than trusted content.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.SymlinkEntry
      )
    } finally {
      fixture.cleanup()
      Fs.rmSync(external, { force: true })
    }
  })

  it("rejects root and ancestor symlink paths", () => {
    // Given: two explicit paths reach the run through symbolic links.
    const fixture = createVerifierFixture(),
      aliasRoot = Fs.mkdtempSync(Path.join(Os.tmpdir(), "verifier-alias-")),
      rootAlias = Path.join(aliasRoot, "root-link"),
      parentAlias = Path.join(aliasRoot, "parent-link")
    try {
      Fs.symlinkSync(fixture.runDirectory, rootAlias)
      Fs.symlinkSync(Path.dirname(fixture.runDirectory), parentAlias)

      // When: each noncanonical path is pinned.
      const rootReport = verifyRunEvidence(rootAlias),
        ancestorReport = verifyRunEvidence(
          Path.join(parentAlias, Path.basename(fixture.runDirectory))
        )

      // Then: both root and ancestor traversal are rejected.
      expect(rootReport.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.RootSymlink
      )
      expect(ancestorReport.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.AncestorSymlink
      )
    } finally {
      fixture.cleanup()
      Fs.rmSync(aliasRoot, { recursive: true, force: true })
    }
  })

  it("rejects FIFO and device invocation surfaces", () => {
    // Given: a declared record is a FIFO and a run invocation is a device.
    const fixture = createVerifierFixture(),
      setup = Path.join(fixture.runDirectory, RunEvidencePath.Setup)
    try {
      Fs.rmSync(setup)
      execFileSync("mkfifo", [setup])

      // When: evidence and invocation topology are inspected without opening the FIFO.
      const fifoReport = verifyRunEvidence(fixture.runDirectory),
        deviceReport = verifyRunEvidence("/dev/null")

      // Then: neither nonregular surface is read as evidence.
      expect(fifoReport.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.NonRegularEntry
      )
      expect(deviceReport.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.RootNotDirectory
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects a socket at a declared file path", async () => {
    // Given: setup.json is replaced by a bound Unix-domain socket.
    const fixture = createVerifierFixture(),
      setup = Path.join(fixture.runDirectory, RunEvidencePath.Setup),
      server = createServer()
    try {
      Fs.rmSync(setup)
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(setup, resolve)
      })

      // When: declared topology is inspected without connecting to the socket.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: socket evidence is rejected as nonregular.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.NonRegularEntry
      )
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      fixture.cleanup()
    }
  })

  it("detects deterministic file replacement after descriptor read", () => {
    // Given: a descriptor-read spy replaces manifest.json after its bytes return.
    const fixture = createVerifierFixture(),
      manifest = Path.join(fixture.runDirectory, RunEvidencePath.Manifest),
      moved = Path.join(fixture.runDirectory, "manifest.replaced"),
      originalRead = Fs.readFileSync,
      originalRealpath = Fs.realpathSync.native
    let replaced = false
    const readSpy = jest
      .spyOn(Fs, "readFileSync")
      .mockImplementation((file: Fs.PathOrFileDescriptor) => {
        const bytes = originalRead(file)
        if (
          typeof file !== "number" ||
          replaced ||
          originalRealpath(`/proc/self/fd/${file}`) !== manifest
        )
          return bytes
        replaced = true
        Fs.renameSync(manifest, moved)
        Fs.writeFileSync(manifest, bytes)
        return bytes
      })
    try {
      const report = verifyRunEvidence(fixture.runDirectory)

      // When/Then: current-path identity cannot validate stale descriptor bytes.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.FileChanged
      )
    } finally {
      readSpy.mockRestore()
      fixture.cleanup()
    }
  })

  it("detects deterministic run-root replacement", () => {
    // Given: a descriptor-read spy swaps the root after manifest bytes return.
    const fixture = createVerifierFixture(),
      original = fixture.runDirectory,
      moved = `${original}-moved`,
      manifest = Path.join(original, RunEvidencePath.Manifest),
      originalRead = Fs.readFileSync,
      originalRealpath = Fs.realpathSync.native
    let replaced = false
    const readSpy = jest
      .spyOn(Fs, "readFileSync")
      .mockImplementation((file: Fs.PathOrFileDescriptor) => {
        const bytes = originalRead(file)
        if (
          typeof file !== "number" ||
          replaced ||
          originalRealpath(`/proc/self/fd/${file}`) !== manifest
        )
          return bytes
        replaced = true
        Fs.renameSync(original, moved)
        Fs.mkdirSync(original)
        return bytes
      })
    try {
      const report = verifyRunEvidence(original)

      // When/Then: the pinned root identity change invalidates the report.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.RootChanged
      )
    } finally {
      readSpy.mockRestore()
      Fs.rmSync(original, { recursive: true, force: true })
      Fs.rmSync(moved, { recursive: true, force: true })
    }
  })
})
