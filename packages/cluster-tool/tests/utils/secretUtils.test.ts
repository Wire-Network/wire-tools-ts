import {
  maskSecretArgs,
  RedactedMarker
} from "@wireio/cluster-tool/utils/secretUtils"

/** A real `PrivateKey.toString()` shape — the exact thing that leaked. */
const PrivateKey = "PVT_K1_2rfZvwDVmNm1fxbboRuKL4WmRZibgM7wpNTfm1eHqojrLh7s8m"
const PublicKey = "PUB_K1_6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV"

describe("maskSecretArgs", () => {
  it("masks the value FOLLOWING --private-key, keeping the rest verbatim", () => {
    expect(
      maskSecretArgs([
        "/build/bin/clio",
        "wallet",
        "import",
        "-n",
        "default",
        "--private-key",
        PrivateKey
      ])
    ).toEqual([
      "/build/bin/clio",
      "wallet",
      "import",
      "-n",
      "default",
      "--private-key",
      RedactedMarker
    ])
  })

  it("masks the value following --password", () => {
    const masked = maskSecretArgs([
      "/build/bin/clio",
      "wallet",
      "unlock",
      "--password",
      "PW5KQwrpb..."
    ])
    expect(masked.at(-1)).toBe(RedactedMarker)
    expect(masked).toContain("--password")
  })

  it("masks an INLINE KEY: spec while preserving the public key before it", () => {
    const [, spec] = maskSecretArgs([
      "/build/bin/nodeop",
      `--signature-provider=${PublicKey}=KEY:${PrivateKey}`
    ])
    expect(spec).toBe(`--signature-provider=${PublicKey}=KEY:${RedactedMarker}`)
    expect(spec).not.toContain(PrivateKey)
  })

  it("leaves a command with no secret completely untouched", () => {
    const argv = ["/build/bin/clio", "-u", "http://127.0.0.1:8888", "get", "info"]
    expect(maskSecretArgs(argv)).toEqual(argv)
  })

  it("never mutates the input array", () => {
    const argv = ["/build/bin/clio", "--private-key", PrivateKey]
    const copy = [...argv]
    maskSecretArgs(argv)
    expect(argv).toEqual(copy)
  })

  it("does NOT treat a bare leading arg as a secret (index 0 is the executable)", () => {
    // A binary path that happens to sit after nothing must survive.
    expect(maskSecretArgs(["--private-key"])).toEqual(["--private-key"])
  })

  it("masks EVERY occurrence when a secret appears more than once", () => {
    const masked = maskSecretArgs([
      "/build/bin/nodeop",
      `--signature-provider=${PublicKey}=KEY:${PrivateKey}`,
      "--private-key",
      PrivateKey
    ])
    expect(masked.join(" ")).not.toContain(PrivateKey)
  })
})
