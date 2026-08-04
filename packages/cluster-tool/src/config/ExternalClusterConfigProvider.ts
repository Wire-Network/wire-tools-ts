import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import {
  ExternalClusterConfigSchemaCodec,
  type ExternalClusterConfig
} from "@wireio/cluster-tool-shared"

/**
 * The behavior half of {@link ExternalClusterConfig} — loads + validates an
 * `external-cluster-config.json` via {@link ExternalClusterConfigSchemaCodec}
 * and resolves its `*File`/`*Files` references to absolute paths (relative to
 * the config file's directory when not already absolute), so a consumer reads
 * every referenced artifact in place. Plain `ExternalClusterConfig` values flow
 * through the harness; this provider owns the IO.
 */
export namespace ExternalClusterConfigProvider {
  /**
   * Read + validate + rehydrate an `ExternalClusterConfig` from `file`,
   * resolving its structural references against the file's directory.
   *
   * @param file - Path to the `external-cluster-config.json`.
   * @returns The validated config with absolute `*File`/`*Files` references.
   * @throws If the file is missing or fails schema validation.
   */
  export function load(file: string): ExternalClusterConfig {
    const configFile = Path.resolve(file)
    Assert.ok(
      Fs.existsSync(configFile),
      `ExternalClusterConfigProvider.load: ${configFile} not found`
    )
    return resolveReferences(
      deserialize(Fs.readFileSync(configFile, "utf-8")),
      Path.dirname(configFile)
    )
  }

  /**
   * Validate + decode a raw `ExternalClusterConfig` payload (no reference
   * resolution — {@link load} is the file-aware path).
   *
   * @param input - Raw JSON text or bytes.
   * @returns The validated config.
   * @throws If `input` fails schema validation.
   */
  export function deserialize(
    input: string | Uint8Array
  ): ExternalClusterConfig {
    return ExternalClusterConfigSchemaCodec.deserialize(input)
  }

  /**
   * Resolve every `*File`/`*Files` reference in `config` against `baseDir` — an
   * absolute reference passes through, a relative one is joined to `baseDir`.
   *
   * @param config - The decoded config.
   * @param baseDir - The directory references resolve against.
   * @returns The config with absolute references.
   */
  export function resolveReferences(
    config: ExternalClusterConfig,
    baseDir: string
  ): ExternalClusterConfig {
    const resolveRef = (ref: string): string =>
      Path.isAbsolute(ref) ? ref : Path.resolve(baseDir, ref)
    return {
      ...config,
      wire: {
        ...config.wire,
        genesisFile:
          config.wire.genesisFile != null
            ? resolveRef(config.wire.genesisFile)
            : config.wire.genesisFile
      },
      ethereum: {
        ...config.ethereum,
        addressFile: resolveRef(config.ethereum.addressFile),
        abiFiles: config.ethereum.abiFiles.map(resolveRef)
      },
      solana:
        config.solana != null
          ? { idlFile: resolveRef(config.solana.idlFile) }
          : config.solana
    }
  }
}
