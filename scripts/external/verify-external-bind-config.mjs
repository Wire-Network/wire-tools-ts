#!/usr/bin/env node
/**
 * Verify a `create-external-config`'d external cluster by standing the WHOLE
 * depot up in Docker against CONTAINERIZED anvil + solana, and confirming the
 * depot advances HEAD BLOCKS (the external-outpost success criterion — NOT epoch
 * distribution).
 *
 * This is the POST-`create-external-config` interpretation: the config folder IS
 * the external cluster directory produced by `create-external-config`
 * (`cluster-config.json` + per-node `config.ini` + `genesis.json` +
 * `cluster-keys.json` + the cloned outpost artifacts). The script generates a
 * `docker-compose.yml` around that directory and brings up a dedicated network
 * with three services (all on the `external-outposts.Dockerfile` image):
 *
 *   - `anvil`  — an Ethereum node reachable at network alias `bind.anvil.address`
 *                (loads the cloned `data/anvil/anvil.json` state so the Ethereum
 *                outpost is present); ONLY the config folder is mounted.
 *   - `solana` — a fresh `solana-test-validator` reachable at network alias
 *                `bind.solana.address`; ONLY the config folder is mounted.
 *   - `depot`  — the WIRE node fleet + kiod, launched via `wire-cluster-tool run`
 *                (NOT raw `nodeop`): a producer/operator node's `--signature-provider`
 *                is assembled on the command line from `cluster-keys.json` by the
 *                CLI (`NodeopProcess.buildArgs`) — the per-node `config.ini`
 *                carries a signature-provider ONLY for bios, so a raw
 *                `nodeop --config-dir node_00` would start a NON-producing node.
 *                Mounts the monorepo (for the mounted `nodeop`/`kiod`/`clio`
 *                binaries + the CLI's node_modules) and the external cluster dir.
 *                Its network aliases cover every depot-hosted daemon
 *                (`bind.nodeop.address` / `bind.kiod.address` /
 *                `bind.debuggingServer.address` — all `depot` in the docker bind
 *                config), so the fleet dials itself over loopback-equivalent DNS
 *                and dials `anvil` / `solana` by their aliases.
 *
 * Why external-outpost mode: `ClusterManager.run` only SKIPS spawning a local
 * anvil/solana (and only skips the OPP epoch-advance gate, gating success on
 * head-block advance instead) when `cluster-config.json.externalOutposts != null`.
 * A `create-external-config` clone of a plain cluster leaves `externalOutposts`
 * null, so this script sets it — derived verbatim from the emitted
 * `external-cluster-config.json`'s `ethereum` + `solana` sections (which are
 * already `ExternalOutpostConfig`-shaped and reference the cloned artifacts). The
 * original `cluster-config.json` is backed up and restored on teardown.
 *
 * Usage:
 *   node scripts/external/verify-external-bind-config.mjs \
 *     --bind-config   <docker-bind.json> \
 *     --build-path    <wire-sysio-build-dir> \
 *     --cluster-path  <external-cluster-dir> \
 *     [--head-advance-blocks 2] [--startup-timeout-seconds 300] \
 *     [--image-tag wire-external-outposts:latest] [--keep-up]
 *
 * `--bind-config` and `--build-path` are the two REQUIRED inputs the task names;
 * `--cluster-path` is the external cluster directory (the config folder) — it
 * defaults to the directory CONTAINING `--bind-config` when that directory is
 * itself a created cluster, otherwise it must be supplied.
 */

import { fileURLToPath } from "node:url"
import Fs from "node:fs"
import Os from "node:os"
import { argv, chalk, echo, path, sleep, $ } from "zx"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Repo layout — the script lives at `<repo>/scripts/external/`. */
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
/** wire-tools-ts repo root. */
const repoRoot = path.resolve(scriptDir, "..", "..")
/** The wire-platform monorepo root (parent of wire-tools-ts) — mounted so the
 *  CLI's node_modules symlinks into sibling repos AND the build-path binaries
 *  resolve at their absolute paths inside the container. */
const monorepoRoot = path.resolve(repoRoot, "..")
/** The `wire-cluster-tool` CLI entry (a Node program). */
const cliEntry = path.join(repoRoot, "packages", "cluster-tool", "bin", "wire-cluster-tool")
/** The Dockerfile that builds the one image every service runs. */
const dockerfile = path.join(scriptDir, "external-outposts.Dockerfile")

/** Default image tag (overridable via `--image-tag`). */
const DefaultImageTag = "wire-external-outposts:latest"
/** Default minimum head-block advance that counts as success (matches the
 *  harness `HeadAdvanceMinBlocks`). */
const DefaultHeadAdvanceBlocks = 2
/** Default budget (seconds) for the depot to come up AND the gate to pass —
 *  sized for the image build + solana warmup + the ~270s a resumed cluster can
 *  need to restart OPP circulation before `current_epoch_index` advances. */
const DefaultStartupTimeoutSeconds = 600
/** Seconds between head-block polls. */
const PollIntervalSeconds = 5
/** Per-`clio`-exec timeout inside the container. */
const ClioProbeTimeout = "15s"
/** Filenames the external cluster directory must carry. */
const ClusterConfigFilename = "cluster-config.json"
const ClusterKeysFilename = "cluster-keys.json"
const GenesisFilename = "genesis.json"
const ExternalConfigFilename = "external-cluster-config.json"
/** Backup suffix for the config we transiently patch to external-outpost mode. */
const ConfigBackupSuffix = ".verify-external-bak"
/** Cloned anvil state, relative to the cluster dir (loaded so the ETH outpost is
 *  present on the containerized anvil). */
const AnvilStateSubpath = path.join("data", "anvil", "anvil.json")
/** Cloned solana ledger dir, relative to the cluster dir (resumed so the SOL
 *  outpost program is present on the containerized validator). */
const SolanaLedgerSubpath = path.join("data", "solana-ledger")

// ---------------------------------------------------------------------------
// Arg helpers (CLI flag → value; fail fast)
// ---------------------------------------------------------------------------

/**
 * Require a string flag; exit 1 when absent/empty.
 * @param {string} name flag name (without leading dashes).
 * @return {string} the value.
 */
function requireFlag(name) {
  const value = argv[name]
  if (value == null || String(value).length === 0) {
    fail(`--${name} is required`)
  }
  return String(value)
}

/**
 * Resolve a positive-number flag, falling back to a default.
 * @param {string} name flag name.
 * @param {number} fallback default when omitted.
 * @return {number} resolved value.
 */
function numberFlag(name, fallback) {
  const raw = argv[name]
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) fail(`--${name} must be a positive number (got: ${raw})`)
  return value
}

/** Print an error and exit 1. @param {string} message the error. */
function fail(message) {
  echo(chalk.red(`Error: ${message}`))
  process.exit(1)
}

/**
 * Assert a path exists (optionally as a directory).
 * @param {string} target the path.
 * @param {string} label human label for the message.
 * @param {boolean} asDirectory whether it must be a directory.
 */
function assertExists(target, label, asDirectory) {
  const ok = Fs.existsSync(target) && (!asDirectory || Fs.statSync(target).isDirectory())
  if (!ok) fail(`${label} not found: ${target}`)
}

/**
 * Read + parse a JSON file, failing fast on either error.
 * @param {string} file the path.
 * @param {string} label human label for the message.
 * @return {object} the parsed value.
 */
function readJson(file, label) {
  assertExists(file, label, false)
  try {
    return JSON.parse(Fs.readFileSync(file, "utf8"))
  } catch (error) {
    fail(`${label} is not valid JSON (${file}): ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Input resolution + validation
// ---------------------------------------------------------------------------

if (argv.help === true || argv.h === true) {
  echo(`
${chalk.bold("verify-external-bind-config.mjs")} — bring up a create-external-config'd
external cluster in Docker (anvil + solana + depot) on a private static-IP
network and confirm the depot advances the EPOCH (or HEAD blocks under
--exclude-outposts) against the containerized outposts.

${chalk.bold("Required:")}
  --cluster-path <dir>    the external cluster dir from create-external-config. Its
                          cluster-config.json ClusterConfig.bind (the BindConfig
                          create-external-config merged in) supplies the static
                          container IPs + ports — the SAME addresses the depot dials.
  --build-path   <dir>    wire-sysio build dir (must contain bin/{nodeop,kiod,clio})

${chalk.bold("Options:")}
  --exclude-outposts            skip loading the cloned outpost state; fresh chains +
                                a depot HEAD-BLOCK gate (default: outposts in, epoch gate)
  --head-advance-blocks    <n>  head-block threshold under --exclude-outposts (default ${DefaultHeadAdvanceBlocks})
  --startup-timeout-seconds <n> budget to come up + advance (default ${DefaultStartupTimeoutSeconds})
  --image-tag              <t>  image tag to build/use (default ${DefaultImageTag})
  --keep-up                     leave the stack running for inspection (no teardown)
`)
  process.exit(0)
}

const buildPath = path.resolve(requireFlag("build-path"))
const clusterPath = path.resolve(requireFlag("cluster-path"))
const headAdvanceBlocks = numberFlag("head-advance-blocks", DefaultHeadAdvanceBlocks)
const startupTimeoutSeconds = numberFlag("startup-timeout-seconds", DefaultStartupTimeoutSeconds)
const imageTag = argv["image-tag"] != null ? String(argv["image-tag"]) : DefaultImageTag
const keepUp = argv["keep-up"] === true
// Default: outposts IN — load the cloned outpost state so OPP circulates and the
// gate is EPOCH ADVANCE. `--exclude-outposts` opts out to fresh chains + a depot
// HEAD-BLOCK gate. Operators are ALWAYS included either way.
const excludeOutposts = argv["exclude-outposts"] === true

// Validate the external cluster directory + its required files.
assertExists(clusterPath, "--cluster-path", true)
const clusterConfigFile = path.join(clusterPath, ClusterConfigFilename)
const externalConfigFile = path.join(clusterPath, ExternalConfigFilename)
assertExists(clusterConfigFile, "cluster-config.json", false)
assertExists(path.join(clusterPath, ClusterKeysFilename), "cluster-keys.json", false)
assertExists(path.join(clusterPath, GenesisFilename), "genesis.json", false)
assertExists(
  externalConfigFile,
  "external-cluster-config.json (run `create-external-config` first)",
  false
)

// The container network is built from the MERGED BindConfig that
// create-external-config wrote into cluster-config.json (`ClusterConfig.bind`) —
// the SAME addresses/ports the depot itself dials. That is the single source of
// truth; the script never reads a separate bind file.
const bindConfig = readJson(clusterConfigFile, "cluster-config.json").bind
if (bindConfig == null) {
  fail(`cluster-config.json has no .bind (ClusterConfig.bind): ${clusterConfigFile}`)
}
for (const daemon of ["kiod", "anvil"]) {
  const entry = bindConfig[daemon]
  if (entry == null || typeof entry.address !== "string" || typeof entry.port !== "number") {
    fail(`ClusterConfig.bind.${daemon} must have { address: string, port: number }`)
  }
}
if (
  bindConfig.nodeop == null ||
  typeof bindConfig.nodeop.address !== "string" ||
  bindConfig.nodeop.ports == null ||
  !Array.isArray(bindConfig.nodeop.ports.producers) ||
  bindConfig.nodeop.ports.producers.length === 0
) {
  fail("ClusterConfig.bind.nodeop must have { address, ports: { producers: [{ http, p2p }], ... } }")
}
if (
  bindConfig.solana == null ||
  typeof bindConfig.solana.address !== "string" ||
  bindConfig.solana.ports == null ||
  typeof bindConfig.solana.ports.http !== "number"
) {
  fail("ClusterConfig.bind.solana must have { address, ports: { http, faucet, gossip, dynamicRange } }")
}

// Validate the build path carries the binaries the depot service runs.
assertExists(buildPath, "--build-path", true)
for (const binary of ["nodeop", "kiod", "clio"]) {
  const binaryPath = path.join(buildPath, "bin", binary)
  if (!Fs.existsSync(binaryPath)) {
    fail(`--build-path is missing bin/${binary} (looked at ${binaryPath}) — pass the wire-sysio build dir`)
  }
}
const containerClio = path.join(buildPath, "bin", "clio")

// The build-path must live under the monorepo root so a single mount covers the
// binaries AND the CLI; likewise the cluster dir must be self-contained.
if (!buildPath.startsWith(monorepoRoot + path.sep)) {
  fail(
    `--build-path (${buildPath}) is not under the monorepo root (${monorepoRoot}); this harness mounts the monorepo at its own path so the binaries + CLI resolve — move the build under the monorepo or extend the mounts`
  )
}

// ---------------------------------------------------------------------------
// Derived docker identifiers + endpoints
// ---------------------------------------------------------------------------

const clusterName = path.basename(clusterPath)
/** Compose project name — namespaces the network + containers for a clean down. */
const projectName = `wire-ext-verify-${clusterName}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-")
const networkName = "wire-external"
/** The producer's HTTP port + the STATIC IPs the fleet binds/dials — taken from
 *  ClusterConfig.bind so they match what the depot itself uses. */
const producerHttpPort = bindConfig.nodeop.ports.producers[0].http
const depotIp = bindConfig.nodeop.address
const anvilIp = bindConfig.anvil.address
const solanaIp = bindConfig.solana.address

/** Every static IP the compose network must contain (deduped); the depot, kiod,
 *  and debugging server share the depot IP. */
const serviceIps = [
  ...new Set(
    [depotIp, anvilIp, solanaIp, bindConfig.kiod.address, bindConfig.debuggingServer?.address].filter(Boolean)
  )
]
/** The depot IP's 3-octet prefix — the single /24 the compose network spans. */
const subnetPrefix = depotIp.split(".").slice(0, 3).join(".")
for (const ip of serviceIps) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    fail(
      `ClusterConfig.bind addresses must be static IPv4 for the docker network — got "${ip}". ` +
        `Re-run create-external-config with an IP-addressed --external-bind-config.`
    )
  }
  const octets = ip.split(".").map(Number)
  // The IPAM below allocates ONE /24 off the depot IP; a service outside it (or on
  // a reserved host octet) yields an opaque `docker compose up` failure instead of
  // this clean fail-fast — so reject both here, with the same remediation guidance.
  if (octets.slice(0, 3).join(".") !== subnetPrefix) {
    fail(
      `ClusterConfig.bind address "${ip}" is outside the depot's /24 (${subnetPrefix}.0/24) — ` +
        `the docker network is ONE /24 derived from the depot IP. Re-run create-external-config ` +
        `with every --external-bind-config address in that /24.`
    )
  }
  if (octets[3] === 0 || octets[3] === 1 || octets[3] === 255) {
    fail(
      `ClusterConfig.bind address "${ip}" uses a reserved host octet ` +
        `(.0 network / .1 docker gateway / .255 broadcast) — pick a host in ${subnetPrefix}.2–${subnetPrefix}.254.`
    )
  }
}
/** The /24 the compose network's IPAM allocates so every service IP is assignable. */
const networkSubnet = `${subnetPrefix}.0/24`

// ---------------------------------------------------------------------------
// External-outpost patch (transient) + compose generation
// ---------------------------------------------------------------------------

const configBackup = `${clusterConfigFile}${ConfigBackupSuffix}`

/**
 * Prepare the cluster config for the docker run (backing the original up first)
 * by setting `externalOutposts` — copied verbatim from the emitted
 * `external-cluster-config.json` (already `ExternalOutpostConfig`-shaped) — so
 * `wire-cluster-tool run` DIALS the containerized anvil/solana instead of
 * spawning its own, then parks. Operators are ALWAYS left in place: OPP can only
 * circulate — and the default epoch-advance gate can only pass — with the batch
 * operator + underwriter daemons running. (Under `--exclude-outposts` the chains
 * come up FRESH with no deployed outposts, so the operator plugins bounce at
 * startup and the gate falls back to depot HEAD BLOCKS; the operators still run.)
 */
function applyExternalOutpostPatch() {
  const externalConfig = readJson(externalConfigFile, "external-cluster-config.json")
  const clusterConfig = readJson(clusterConfigFile, "cluster-config.json")
  if (!Fs.existsSync(configBackup)) Fs.copyFileSync(clusterConfigFile, configBackup)
  clusterConfig.externalOutposts = { ethereum: externalConfig.ethereum, solana: externalConfig.solana }
  Fs.writeFileSync(clusterConfigFile, `${JSON.stringify(clusterConfig, null, 2)}\n`)
  echo(
    chalk.dim(
      `  patched externalOutposts (ethereum chainId=${externalConfig.ethereum?.chainId}, ` +
        `solana idl=${path.basename(externalConfig.solana?.idlFile ?? "?")}) — ` +
        (excludeOutposts
          ? "outposts EXCLUDED (fresh chains, head-block gate)"
          : "outposts INCLUDED (cloned state, epoch-advance gate)") +
        "; operators always on — original backed up"
    )
  )
}

/** Restore the pristine cluster config (undo {@link applyExternalOutpostPatch}). */
function restoreClusterConfig() {
  if (Fs.existsSync(configBackup)) {
    Fs.copyFileSync(configBackup, clusterConfigFile)
    Fs.rmSync(configBackup, { force: true })
  }
}

/**
 * Build the anvil service command. By DEFAULT loads the cloned
 * `data/anvil/anvil.json` so the deployed Ethereum outpost is present and OPP can
 * circulate (the epoch-advance gate). Loading requires the image's anvil version
 * to match the host that DUMPED the state (a mismatch crashes anvil on load) — the
 * Dockerfile pins Foundry to the host's version via the `FOUNDRY_VERSION` build
 * arg. Under `--exclude-outposts` the chain comes up FRESH (no ETH outpost) and
 * the run falls back to the depot head-block gate.
 * @return {string[]} the anvil argv.
 */
function anvilCommand() {
  const stateFile = path.join(clusterPath, AnvilStateSubpath)
  const loadState =
    !excludeOutposts && Fs.existsSync(stateFile) ? ["--load-state", stateFile] : []
  return [
    "anvil",
    "--host",
    anvilIp,
    "--port",
    String(bindConfig.anvil.port),
    "--chain-id",
    String(readJson(externalConfigFile, "external-cluster-config.json").ethereum?.chainId ?? 31337),
    "--block-time",
    "1",
    "--slots-in-an-epoch",
    "1",
    ...loadState
  ]
}

/**
 * Build the solana-test-validator service command. By DEFAULT resumes the cloned
 * ledger so the deployed Solana outpost program is present and OPP can circulate.
 * The config-folder mount is read-only, so the ledger is copied to a
 * container-writable `/tmp` path first (the config folder stays the only VOLUME)
 * and started WITHOUT `--reset`; this needs the image's Agave version to match the
 * one that wrote it (pinned via `SOLANA_VERSION`). Under `--exclude-outposts` a
 * fresh, reset ledger is used (no SOL outpost) and the run falls back to the
 * depot head-block gate.
 * @return {string[]} the argv (an `sh -c` wrapper when resuming the cloned ledger).
 */
function solanaCommand() {
  const { http, faucet, gossip, dynamicRange } = bindConfig.solana.ports
  const flags = [
    "--rpc-port",
    String(http),
    "--faucet-port",
    String(faucet),
    "--gossip-port",
    String(gossip),
    "--dynamic-port-range",
    `${dynamicRange.first}-${dynamicRange.last}`,
    "--bind-address",
    solanaIp
  ]
  const clonedLedger = path.join(clusterPath, SolanaLedgerSubpath)
  if (!excludeOutposts && Fs.existsSync(clonedLedger)) {
    // Resume the cloned ledger from a writable copy (the config mount is :ro): the
    // SOL outpost program lives in the ledger's accounts. Drop the stale
    // ledger.lock, AND drop the EXTRACTED snapshots/ dir — it hardlinks the
    // original ledger's absolute account paths, so a copied ledger dies with
    // "snapshot dir account paths mismatching"; removing it forces re-extraction
    // from the self-contained snapshot-*.tar.zst archive at the new path.
    return [
      "sh",
      "-c",
      `rm -rf /tmp/test-ledger && cp -a ${clonedLedger} /tmp/test-ledger && ` +
        `rm -f /tmp/test-ledger/ledger.lock && rm -rf /tmp/test-ledger/snapshots && ` +
        `exec solana-test-validator --ledger /tmp/test-ledger ${flags.join(" ")}`
    ]
  }
  return ["solana-test-validator", "--ledger", "/tmp/test-ledger", "--reset", ...flags]
}

/**
 * Detect the HOST anvil + solana-test-validator versions (the ones that created
 * the cluster and dumped its state) so the image is built to match — a mismatch
 * crashes anvil on --load-state and makes solana reject the cloned ledger.
 * @return {Promise<object>} the image build args (FOUNDRY_VERSION / SOLANA_VERSION).
 */
async function detectHostToolchainVersions() {
  const anvilOut = (await $({ nothrow: true })`anvil --version`).stdout,
    solanaOut = (await $({ nothrow: true })`solana-test-validator --version`).stdout,
    // Anchor to the tool-name line (`anvil Version: 1.5.1-stable`,
    // `solana-test-validator 4.0.3 (…)`) so a semver-shaped token elsewhere in the
    // output — build metadata, a bundled lib version — can't win the first match.
    foundry = anvilOut.match(/anvil[^\n]*?(\d+\.\d+\.\d+)/i)?.[1],
    solana = solanaOut.match(/(?:agave|solana)[^\n]*?(\d+\.\d+\.\d+)/i)?.[1]
  if (foundry == null) fail(`could not parse host anvil version from: ${anvilOut.trim()}`)
  if (solana == null) fail(`could not parse host solana-test-validator version from: ${solanaOut.trim()}`)
  echo(chalk.dim(`  host toolchain: anvil ${foundry}, solana ${solana} (image pinned to match)`))
  return { FOUNDRY_VERSION: foundry, SOLANA_VERSION: solana }
}

/**
 * Assemble the docker-compose model (written as JSON — valid YAML — so no YAML
 * dependency is needed).
 * @param {object} buildArgs image build args (FOUNDRY_VERSION / SOLANA_VERSION).
 * @return {object} the compose file model.
 */
function composeModel(buildArgs) {
  const image = { context: scriptDir, dockerfile: path.basename(dockerfile), args: buildArgs }
  const configMount = `${clusterPath}:${clusterPath}:ro`
  // Agave 4.0.3's snapshot loader (and nodeop's rocksdb) use io_uring, which
  // docker's DEFAULT seccomp profile blocks (EPERM "Operation not permitted").
  // Relax seccomp for this dev/test stack so the outposts + depot load state.
  const securityOpt = ["seccomp=unconfined"]
  return {
    name: projectName,
    // A private network with an explicit IPAM subnet so each service claims the
    // STATIC IP its ClusterConfig.bind entry names — the depot dials those exact
    // IPs, and solana binds a real IP (no gossip 0.0.0.0 panic).
    networks: {
      [networkName]: {
        name: `${projectName}_${networkName}`,
        ipam: { config: [{ subnet: networkSubnet }] }
      }
    },
    services: {
      anvil: {
        image: imageTag,
        build: image,
        command: anvilCommand(),
        networks: { [networkName]: { ipv4_address: anvilIp } },
        volumes: [configMount],
        security_opt: securityOpt
      },
      solana: {
        image: imageTag,
        build: image,
        command: solanaCommand(),
        networks: { [networkName]: { ipv4_address: solanaIp } },
        volumes: [configMount],
        security_opt: securityOpt
      },
      depot: {
        image: imageTag,
        build: image,
        command: ["node", cliEntry, "run", "--cluster-path", clusterPath],
        depends_on: ["anvil", "solana"],
        // Run as the host user so files the CLI writes into the mounted cluster
        // dir stay host-owned (not root) and remain cleanable/writable.
        user: `${process.getuid()}:${process.getgid()}`,
        // A writable HOME + a per-run bind registry, both under the container /tmp
        // (world-writable) so the non-root user can write them.
        environment: { HOME: "/tmp", WIRE_BIND_REGISTRY_PATH: "/tmp/wire-bind-registry" },
        // One container hosts every depot-side daemon (nodeop nodes, kiod, the
        // debugging server) — they share this static IP, each on its own port.
        networks: { [networkName]: { ipv4_address: depotIp } },
        // Mount the monorepo (CLI + node_modules + the build-path binaries) and
        // the external cluster dir, each at its own absolute path so every
        // absolute reference in the persisted config resolves unchanged.
        volumes: [`${monorepoRoot}:${monorepoRoot}:ro`, `${clusterPath}:${clusterPath}:rw`],
        // Publish the producer HTTP port for host-side inspection under --keep-up.
        ports: [`${producerHttpPort}:${producerHttpPort}`],
        security_opt: securityOpt
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Docker lifecycle
// ---------------------------------------------------------------------------

$.verbose = false

/**
 * Read the depot's head block via `clio` executed INSIDE the depot container
 * (dialing the nodeop alias, which resolves to the container itself).
 * @param {string} composeFile the generated compose file path.
 * @return {Promise<number|null>} head_block_num, or null when unreachable.
 */
async function readDepotHead(composeFile) {
  try {
    const result = await $({
      nothrow: true
    })`docker compose -f ${composeFile} -p ${projectName} exec -T depot ${containerClio} -u http://${depotIp}:${producerHttpPort} get info`.timeout(
      ClioProbeTimeout
    )
    if (result.exitCode !== 0) return null
    const info = JSON.parse(result.stdout)
    return typeof info.head_block_num === "number" ? info.head_block_num : null
  } catch {
    return null
  }
}

/**
 * Read the depot's `current_epoch_index` via `clio` inside the depot container.
 * v6 promoted `sysio.epoch::epochstate` to a KV table — the fields live under
 * `.value` (see cluster-state-active-probing.md).
 * @param {string} composeFile the generated compose file path.
 * @return {Promise<number|null>} current_epoch_index, or null when unreachable.
 */
async function readDepotEpoch(composeFile) {
  try {
    const result = await $({
      nothrow: true
    })`docker compose -f ${composeFile} -p ${projectName} exec -T depot ${containerClio} -u http://${depotIp}:${producerHttpPort} get table sysio.epoch epochstate -S sysio.epoch -l 1`.timeout(
      ClioProbeTimeout
    )
    if (result.exitCode !== 0) return null
    const row = JSON.parse(result.stdout).rows?.[0]
    const index = row?.value?.current_epoch_index ?? row?.current_epoch_index
    return typeof index === "number" ? index : null
  } catch {
    return null
  }
}

/**
 * Tear the stack down (unless --keep-up) and restore the pristine config.
 * @param {string} composeFile the generated compose file path.
 */
async function teardown(composeFile) {
  restoreClusterConfig()
  if (keepUp) {
    echo(chalk.yellow(`\n--keep-up: stack left running. Tear down with:`))
    echo(`  docker compose -f ${composeFile} -p ${projectName} down -v`)
    return
  }
  echo(chalk.dim("\nTearing down (docker compose down -v)..."))
  await $({ nothrow: true })`docker compose -f ${composeFile} -p ${projectName} down -v`
}

/**
 * Dump the depot container's recent logs + `ps` for diagnosis.
 * @param {string} composeFile the generated compose file path.
 */
async function dumpDiagnostics(composeFile) {
  echo(chalk.bold("\n--- docker compose ps ---"))
  await $({ nothrow: true, verbose: true })`docker compose -f ${composeFile} -p ${projectName} ps`
  echo(chalk.bold("\n--- depot logs (tail) ---"))
  await $({
    nothrow: true,
    verbose: true
  })`docker compose -f ${composeFile} -p ${projectName} logs --tail 60 depot`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// The success gate: EPOCH ADVANCE by default (outposts loaded → OPP circulates),
// or depot HEAD BLOCKS under --exclude-outposts.
const gate = excludeOutposts
  ? { name: "head", unit: "blocks", threshold: headAdvanceBlocks, read: readDepotHead }
  : { name: "epoch", unit: "epochs", threshold: 1, read: readDepotEpoch }

echo(chalk.bold.green(`\nVerifying external cluster in Docker: ${clusterName}`))
echo(`  cluster-path:  ${clusterPath}`)
echo(`  build-path:    ${buildPath}`)
echo(`  static IPs:    depot=${depotIp} anvil=${anvilIp} solana=${solanaIp} (subnet ${networkSubnet})`)
echo(`  success gate:  ${gate.name} advances >= ${gate.threshold} ${gate.unit} within ${startupTimeoutSeconds}s`)

// Docker preflight.
try {
  await $`docker version`.quiet()
} catch {
  fail("docker is not available (is the daemon running?)")
}

applyExternalOutpostPatch()

// Pin the image toolchains to the host versions so the cloned anvil state +
// solana ledger load cleanly.
const buildArgs = await detectHostToolchainVersions()

const workDir = Fs.mkdtempSync(path.join(Os.tmpdir(), "wire-ext-verify-"))
const composeFile = path.join(workDir, "docker-compose.yml")
Fs.writeFileSync(composeFile, `${JSON.stringify(composeModel(buildArgs), null, 2)}\n`)
echo(chalk.dim(`  compose file:  ${composeFile}`))

let passed = false
try {
  echo(chalk.bold("\nBuilding image + starting stack (docker compose up -d --build)..."))
  await $({ verbose: true })`docker compose -f ${composeFile} -p ${projectName} up -d --build`

  echo(chalk.bold(`\nWaiting for the depot to advance ${gate.name} (>= ${gate.threshold} ${gate.unit})...`))
  const deadline = Date.now() + startupTimeoutSeconds * 1000
  let first = null
  let latest = null
  while (Date.now() < deadline) {
    await sleep(PollIntervalSeconds * 1000)
    const value = await gate.read(composeFile)
    const elapsed = Math.round((Date.now() - (deadline - startupTimeoutSeconds * 1000)) / 1000)
    if (value == null) {
      echo(chalk.dim(`  t=${elapsed}s  depot ${gate.name} not answering yet...`))
      continue
    }
    if (first == null) first = value
    latest = value
    const advance = value - first
    echo(`  t=${elapsed}s  ${gate.name}=${value}  (+${advance} since first ${first})`)
    if (advance >= gate.threshold) {
      passed = true
      echo(
        chalk.bold.green(
          `\nPASS — depot ${gate.name} advanced ${advance} ${gate.unit} (${first} -> ${latest}) against containerized anvil+solana.`
        )
      )
      break
    }
  }

  if (!passed) {
    echo(
      chalk.bold.red(
        `\nFAIL — ${gate.name} did not advance >= ${gate.threshold} ${gate.unit} within ${startupTimeoutSeconds}s` +
          (first == null ? ` (depot never answered clio for ${gate.name})` : ` (first=${first}, latest=${latest})`)
      )
    )
    await dumpDiagnostics(composeFile)
  }
} finally {
  await teardown(composeFile)
}

process.exit(passed ? 0 : 1)
