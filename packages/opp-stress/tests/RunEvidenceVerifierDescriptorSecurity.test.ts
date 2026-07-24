import Fs = require("node:fs")
import * as Os from "node:os"
import * as Path from "node:path"

import {
  RunEvidencePath,
  RunEvidenceVerificationIssueCode,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import { createVerifierFixture } from "./runEvidenceVerifierTestSupport.js"

describe("run evidence verifier descriptor-rooted security", () => {
  it("rejects an external artifact-directory symlink installed after topology", () => {
    // Given: topology is complete before the immutable artifact directory moves outside.
    const fixture = createVerifierFixture(),
      artifactDirectory = Path.join(
        fixture.runDirectory,
        RunEvidencePath.Artifacts
      ),
      externalDirectory = Fs.mkdtempSync(
        Path.join(Os.tmpdir(), "verifier-external-artifacts-")
      ),
      configSnapshot = Path.join(
        fixture.runDirectory,
        RunEvidencePath.ClusterConfigSnapshot
      ),
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
          originalRealpath(`/proc/self/fd/${file}`) !== configSnapshot
        )
          return bytes
        replaced = true
        Fs.renameSync(artifactDirectory, externalDirectory)
        Fs.symlinkSync(externalDirectory, artifactDirectory, "dir")
        return bytes
      })
    try {
      Fs.rmdirSync(externalDirectory)

      // When: the targeted descriptor read installs the external symlink.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: unchanged external bytes cannot be authorized through the new pathname.
      expect(report.valid).toBe(false)
      expect(
        report.issues.some(issue =>
          [
            RunEvidenceVerificationIssueCode.FileChanged,
            RunEvidenceVerificationIssueCode.RootChanged,
            RunEvidenceVerificationIssueCode.SymlinkEntry,
            RunEvidenceVerificationIssueCode.ReadFailed
          ].includes(issue.code)
        )
      ).toBe(true)
      expect(report.issues.map(issue => issue.code)).not.toContain(
        RunEvidenceVerificationIssueCode.ArtifactHashMismatch
      )
    } finally {
      readSpy.mockRestore()
      Fs.rmSync(artifactDirectory, { recursive: true, force: true })
      Fs.rmSync(externalDirectory, { recursive: true, force: true })
      fixture.cleanup()
    }
  })

  it("rejects an ancestor symlink installed after manifest read", () => {
    // Given: a canonical parent is replaced by a symlink back to the same held tree.
    const source = createVerifierFixture(),
      parent = Fs.mkdtempSync(Path.join(Os.tmpdir(), "verifier-parent-")),
      movedParent = `${parent}-moved`,
      runDirectory = Path.join(parent, "run"),
      manifest = Path.join(runDirectory, RunEvidencePath.Manifest),
      originalRead = Fs.readFileSync,
      originalRealpath = Fs.realpathSync.native
    Fs.renameSync(source.runDirectory, runDirectory)
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
        Fs.renameSync(parent, movedParent)
        Fs.symlinkSync(movedParent, parent, "dir")
        return bytes
      })
    try {
      // When: the ancestor changes after manifest bytes are read.
      const report = verifyRunEvidence(runDirectory)

      // Then: retaining the same root inode cannot hide the noncanonical ancestor.
      expect(report.valid).toBe(false)
      expect(
        report.issues.some(issue =>
          [
            RunEvidenceVerificationIssueCode.AncestorSymlink,
            RunEvidenceVerificationIssueCode.NonCanonicalRoot,
            RunEvidenceVerificationIssueCode.RootChanged
          ].includes(issue.code)
        )
      ).toBe(true)
    } finally {
      readSpy.mockRestore()
      Fs.rmSync(parent, { recursive: true, force: true })
      Fs.rmSync(movedParent, { recursive: true, force: true })
    }
  })

  it("closes held descriptors across repeated valid and early-invalid verification", () => {
    // Given: one valid run and one manifest-invalid run exercise both return paths.
    const valid = createVerifierFixture(),
      invalid = createVerifierFixture(),
      before = Fs.readdirSync("/proc/self/fd").length
    Fs.writeFileSync(
      Path.join(invalid.runDirectory, RunEvidencePath.Manifest),
      "{}\n"
    )
    try {
      // When: verification repeatedly opens root and nested directory descriptors.
      Array.from({ length: 50 }).forEach(() => {
        verifyRunEvidence(valid.runDirectory)
        verifyRunEvidence(invalid.runDirectory)
      })

      // Then: guaranteed finally cleanup returns the process to its original FD count.
      expect(Fs.readdirSync("/proc/self/fd").length).toBe(before)
    } finally {
      valid.cleanup()
      invalid.cleanup()
    }
  })
})
