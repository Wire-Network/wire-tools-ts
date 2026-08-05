import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"

import { resolveReadinessDeploymentProfile } from "@wireio/cluster-tool/readiness"

import { createReadinessDeploymentProfileFixture } from "./readinessProfileFixture.js"

describe("resolveReadinessDeploymentProfile", () => {
  let rootPath: string

  beforeEach(() => {
    rootPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), "wire-readiness-profile-test-")
    )
  })

  afterEach(() => {
    Fs.rmSync(rootPath, { recursive: true, force: true })
  })

  it("loads and validates an immutable deployment profile", () => {
    const profile = createReadinessDeploymentProfileFixture(),
      profileFile = Path.join(rootPath, "outpost-deployment-profile.json")
    Fs.writeFileSync(profileFile, JSON.stringify(profile))

    expect(resolveReadinessDeploymentProfile(profileFile)).toEqual(profile)
  })

  it("preserves the file and parse error when validation fails", () => {
    const profileFile = Path.join(rootPath, "outpost-deployment-profile.json")
    Fs.writeFileSync(profileFile, "{}")

    expect(() => resolveReadinessDeploymentProfile(profileFile)).toThrow(
      "Unable to load outpost deployment profile"
    )
  })
})
