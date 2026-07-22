import Fs from "node:fs"
import Path from "node:path"

const PackageManifestFile = Path.resolve(__dirname, "../../package.json")

describe("AtomicFile package exports", () => {
  it("blocks only the two internal split modules", () => {
    expect(
      JSON.parse(Fs.readFileSync(PackageManifestFile, "utf8"))
    ).toMatchObject({
      exports: {
        ".": {
          types: "./lib/esm/index.d.ts",
          import: "./lib/esm/index.js",
          require: "./lib/cjs/index.js"
        },
        "./utils/atomicFileOperations": null,
        "./utils/atomicFilePublisher": null,
        "./*": {
          types: "./lib/esm/*.d.ts",
          import: "./lib/esm/*.js",
          require: "./lib/cjs/*.js"
        }
      }
    })
  })
})
