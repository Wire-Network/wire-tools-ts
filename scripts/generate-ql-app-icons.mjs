#!/usr/bin/env node
/**
 * Generate the WIRE QL desktop app icons from the Wire mark:
 *   packages/ql-tool-app/resources/assets/brand/wire-mark.svg (path data, `fill="currentColor"`)
 *   + the brand color from packages/ql-shared/src/brand/QLBrand.json (the SOURCE file, never a build output)
 *   → packages/ql-tool-app/resources/assets/brand/icon-{16,32,48,64,128,256,512,1024}.png (transparent background)
 *   + packages/ql-tool-app/resources/assets/brand/ICONS_SOURCE.json { svgSha256, primaryHex, resvgVersion, sizes, pngSha256 }
 *
 * Rendering uses @resvg/resvg-js (prebuilt napi, no system rsvg). `--check` is
 * OS-independent: it does NOT re-render (rasterization may differ across OS/CPU);
 * it recomputes the INPUTS (svg sha256, brand hex, resvg version, sizes) against
 * ICONS_SOURCE.json and verifies every committed PNG against its recorded sha256.
 *
 * Usage:
 *   ./scripts/generate-ql-app-icons.mjs [options]
 *
 * Options:
 *   --app-path <dir>     the @wireio/ql-tool-app package (env: WIRE_QL_APP_PATH; default: packages/ql-tool-app)
 *   --brand-file <file>  QLBrand.json (env: WIRE_QL_BRAND_FILE; default: packages/ql-shared/src/brand/QLBrand.json)
 *   --check              verify instead of writing (see exit codes)
 *
 * Exit codes:
 *   0  generated, or --check passed
 *   1  --check: inputs changed ("regenerate icons"), a PNG is missing, or a PNG fails its recorded sha256
 *   2  usage error (unknown option, stray argument, missing input, @resvg/resvg-js not installed)
 *   3  rendering failed (the renderer's stack is printed)
 *
 * Examples:
 *   ./scripts/generate-ql-app-icons.mjs
 *   ./scripts/generate-ql-app-icons.mjs --check
 */

import { createRequire } from "node:module"
import { chalk, echo, fs, path } from "zx"

import {
  ExitCode as CommonExitCode,
  RepoRoot,
  isEntryScript,
  parseArguments,
  resolvePathOption,
  sha256,
  sha256File,
  toolFailure,
  usageError
} from "./common/cli-common.mjs"
import { diffFields, diffHashes, printDrift, readRecord, writeRecord } from "./common/drift-record.mjs"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Process exit codes (documented in the header). */
const ExitCode = Object.freeze({ ...CommonExitCode, drift: CommonExitCode.failure })

/** Flag kinds this script accepts (anything else is a usage error). */
const Flags = Object.freeze({ booleans: ["check"], strings: ["app-path", "brand-file"] })

/** Rendered square sizes (px). */
const IconSizes = Object.freeze([16, 32, 48, 64, 128, 256, 512, 1024])

/** The renderer package (its version is a recorded input). */
const RendererPackage = "@resvg/resvg-js"
/** The brand assets directory, relative to the app package. */
const BrandSubpath = path.join("resources", "assets", "brand")
/** The source mark. */
const MarkFilename = "wire-mark.svg"
/** The drift record. */
const RecordFilename = "ICONS_SOURCE.json"
/** The color placeholder in the mark (the SVG keeps `currentColor`). */
const CurrentColor = "currentColor"
/** The record fields that are inputs of the PNGs. */
const InputFields = Object.freeze(["svgSha256", "primaryHex", "resvgVersion", "sizes"])
/** Transparent render background. */
const TransparentBackground = "rgba(0,0,0,0)"
/** A valid `#rrggbb` brand color. */
const HexColorPattern = /^#[0-9a-f]{6}$/i
/** Node's error code for an unresolvable module. */
const ModuleNotFoundCode = "MODULE_NOT_FOUND"

/** Default app package. */
const DefaultAppPath = path.join(RepoRoot, "packages", "ql-tool-app")
/** Default brand source file. */
const DefaultBrandFile = path.join(RepoRoot, "packages", "ql-shared", "src", "brand", "QLBrand.json")

const require = createRequire(import.meta.filename)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The PNG file name of one size.
 *
 * @param {number} size px.
 * @return {string} `icon-<size>.png`.
 */
function iconFilename(size) {
  return `icon-${size}.png`
}

/**
 * Load a renderer module, turning "not installed" into a usage error.
 *
 * @param {string} specifier the module specifier.
 * @return {any} the module.
 */
function requireRenderer(specifier) {
  try {
    return require(specifier)
  } catch (error) {
    if (error.code === ModuleNotFoundCode) usageError(`${RendererPackage} is not installed — run pnpm install`)
    throw error
  }
}

/**
 * The inputs the PNGs are a function of.
 *
 * @param {string} markFile the SVG.
 * @param {string} brandFile QLBrand.json.
 * @return {{ svgSha256: string, primaryHex: string, resvgVersion: string, sizes: number[] }} the inputs.
 */
function readInputs(markFile, brandFile) {
  const { primaryHex } = fs.readJsonSync(brandFile)
  if (!HexColorPattern.test(String(primaryHex))) usageError(`${brandFile} has no valid primaryHex`)
  return {
    svgSha256: sha256File(markFile),
    primaryHex,
    resvgVersion: requireRenderer(`${RendererPackage}/package.json`).version,
    sizes: [...IconSizes]
  }
}

/**
 * Render every size and write the PNGs + the record.
 *
 * @param {string} brandDir output directory.
 * @param {string} markFile the SVG.
 * @param {object} inputs from {@link readInputs}.
 */
function generate(brandDir, markFile, inputs) {
  const { Resvg } = requireRenderer(RendererPackage),
    svg = fs.readFileSync(markFile, "utf8").replaceAll(CurrentColor, inputs.primaryHex)
  try {
    const pngSha256 = Object.fromEntries(
      inputs.sizes.map(size => {
        const png = new Resvg(svg, { fitTo: { mode: "width", value: size }, background: TransparentBackground })
          .render()
          .asPng()
        fs.writeFileSync(path.join(brandDir, iconFilename(size)), png)
        return [iconFilename(size), sha256(png)]
      })
    )
    writeRecord(path.join(brandDir, RecordFilename), { ...inputs, pngSha256 })
  } catch (error) {
    toolFailure("rendering failed", error)
  }
  echo(chalk.green(`icons: wrote ${inputs.sizes.length} PNGs + ${RecordFilename} in ${brandDir}`))
}

/**
 * Verify inputs against the record and the committed PNGs against their hashes.
 *
 * @param {string} brandDir the brand directory.
 * @param {object} inputs from {@link readInputs}.
 * @return {number} exit code.
 */
function check(brandDir, inputs) {
  const recordFile = path.join(brandDir, RecordFilename),
    recorded = readRecord(recordFile)
  if (recorded == null) {
    printDrift(`ICONS-DRIFT: ${recordFile} is missing — regenerate icons`)
    return ExitCode.drift
  }
  const inputDifferences = diffFields(recorded, inputs, InputFields)
  if (inputDifferences.length > 0) {
    printDrift("ICONS-DRIFT: inputs changed — regenerate icons with ./scripts/generate-ql-app-icons.mjs", inputDifferences)
    return ExitCode.drift
  }
  const committed = Object.fromEntries(
      inputs.sizes
        .map(iconFilename)
        .filter(name => fs.existsSync(path.join(brandDir, name)))
        .map(name => [name, sha256File(path.join(brandDir, name))])
    ),
    integrity = diffHashes(recorded.pngSha256, committed)
  if (integrity.length > 0) {
    printDrift(`ICONS-DRIFT: committed PNGs do not match ${recordFile}`, integrity)
    return ExitCode.drift
  }
  echo(chalk.green("icons: committed PNGs match their recorded inputs"))
  return ExitCode.success
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Parse the arguments, then generate or check.
 *
 * @return {number} exit code.
 */
function main() {
  const flags = parseArguments(Flags),
    appPath = resolvePathOption(flags, "app-path", "WIRE_QL_APP_PATH", DefaultAppPath),
    brandFile = resolvePathOption(flags, "brand-file", "WIRE_QL_BRAND_FILE", DefaultBrandFile),
    brandDir = path.join(appPath, BrandSubpath),
    markFile = path.join(brandDir, MarkFilename)
  if (!fs.existsSync(markFile)) usageError(`mark not found at ${markFile}`)
  if (!fs.existsSync(brandFile)) usageError(`brand file not found at ${brandFile}`)
  const inputs = readInputs(markFile, brandFile)
  if (flags.check) return check(brandDir, inputs)
  generate(brandDir, markFile, inputs)
  return ExitCode.success
}

if (isEntryScript(import.meta.filename)) {
  process.exitCode = main()
}
