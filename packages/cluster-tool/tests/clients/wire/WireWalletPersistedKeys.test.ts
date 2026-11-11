import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { KeyType, PrivateKey } from "@wireio/sdk-core"
import { WireWallet } from "@wireio/cluster-tool/clients/wire"
import type { WireKeyPair } from "@wireio/cluster-tool/types"

/** A random K1 pair — what `KeyGenerator.create(KeyType.K1, …)` mints. */
const randomKeyPair = (): WireKeyPair => {
  const privateKey = PrivateKey.generate(KeyType.K1)
  return {
    type: KeyType.K1,
    publicKey: privateKey.toPublic().toString(),
    privateKey: privateKey.toString()
  }
}
/** A pre-created batch operator's handle. */
const OperatorKeyName = "batchop.a"
/** A handle no test persists. */
const AbsentKeyName = "absent"
/** The permission bits a `stat` mode carries. */
const FileModeMask = 0o777

describe("WireWallet persisted WIRE keys", () => {
  let dataPath: string

  beforeEach(() => {
    dataPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "wire-key-"))
  })

  afterEach(() => {
    Fs.rmSync(dataPath, { recursive: true, force: true })
  })

  it("keyFile composes <dataPath>/wire-<name>-key.json from the prefix and suffix", () => {
    expect(WireWallet.keyFile(dataPath, OperatorKeyName)).toBe(
      Path.join(
        dataPath,
        `${WireWallet.KeyFilePrefix}${OperatorKeyName}${WireWallet.KeyFileSuffix}`
      )
    )
    expect(WireWallet.keyFile(dataPath, OperatorKeyName)).toBe(
      Path.join(dataPath, "wire-batchop.a-key.json")
    )
  })

  it("hasKey reports a handle only once it is persisted", () => {
    expect(WireWallet.hasKey(dataPath, OperatorKeyName)).toBe(false)
    WireWallet.saveKey(dataPath, OperatorKeyName, randomKeyPair())
    expect(WireWallet.hasKey(dataPath, OperatorKeyName)).toBe(true)
    expect(WireWallet.hasKey(dataPath, AbsentKeyName)).toBe(false)
  })

  it("saveKey persists the pair owner-only, creating the data dir, and returns it read back", () => {
    const nested = Path.join(dataPath, "cluster", "data"),
      pair = randomKeyPair(),
      saved = WireWallet.saveKey(nested, OperatorKeyName, pair),
      file = WireWallet.keyFile(nested, OperatorKeyName)
    expect(saved).toEqual(pair)
    expect(Fs.statSync(file).mode & FileModeMask).toBe(WireWallet.KeyFileMode)
    expect(JSON.parse(Fs.readFileSync(file, "utf8"))).toEqual(pair)
  })

  it("saveKey refuses to replace a key already persisted under the handle", () => {
    const first = WireWallet.saveKey(dataPath, OperatorKeyName, randomKeyPair())
    expect(() =>
      WireWallet.saveKey(dataPath, OperatorKeyName, randomKeyPair())
    ).toThrow(/already exists/)
    expect(WireWallet.loadKeyPair(dataPath, OperatorKeyName)).toEqual(first)
  })

  it("loadKeyPair refuses a handle that was never persisted, naming the file", () => {
    expect(() => WireWallet.loadKeyPair(dataPath, AbsentKeyName)).toThrow(
      new RegExp(`"${AbsentKeyName}" not found at .*wire-absent-key\\.json`)
    )
  })

  it("loadKeyPair refuses a file whose public half does not match its secret", () => {
    const pair = randomKeyPair(),
      other = randomKeyPair(),
      file = WireWallet.keyFile(dataPath, OperatorKeyName)
    WireWallet.saveKey(dataPath, OperatorKeyName, pair)
    Fs.writeFileSync(
      file,
      JSON.stringify({ ...pair, publicKey: other.publicKey })
    )
    expect(() => WireWallet.loadKeyPair(dataPath, OperatorKeyName)).toThrow(
      /public key does not match its secret/
    )
  })
})
