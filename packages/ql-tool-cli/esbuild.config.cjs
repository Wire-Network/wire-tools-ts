/**
 * Bundles the wql CLI (+ the lazily loaded TUI chunk) into dist/bundle/ as ESM:
 *   dist/bundle/wql.mjs            entry (executable)
 *   dist/bundle/chunks/*.mjs       split chunks (the TUI is one; loaded on `wql tui`)
 *
 * Ink pulls yoga through top-level await, so the CLI ships as an ESM bundle; the
 * workspace packages it bundles are CommonJS and are interop-wrapped by esbuild.
 * `commonJsResolvePlugin` keeps ONE copy of the hybrid @wireio packages;
 * `filenamePlugin` gives every workspace module its own `__filename` (per-file
 * logger categories survive bundling).
 */
const Fs = require("node:fs")
const Path = require("node:path")
const esbuild = require("esbuild")

const { createCommonJsResolvePlugin } = require("./scripts/esbuild/commonJsResolvePlugin.cjs")
const { createFilenamePlugin } = require("./scripts/esbuild/filenamePlugin.cjs")
const { Target } = require("./scripts/esbuild/loaders.cjs")

/** Bundle output directory. */
const OutputPath = "dist/bundle"
/** The executable entry output. */
const EntryOutputName = "wql.mjs"

/** Marks ONLY the entry output executable (chunks are imported, never run). */
const chmodPlugin = {
  name: "chmod",
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length > 0) return
      Object.keys(result.metafile.outputs)
        .filter(output => Path.basename(output) === EntryOutputName)
        .forEach(output => Fs.chmodSync(output, 0o755))
    })
  }
}

esbuild
  .build({
    entryPoints: { wql: "src/cli/main.ts" },
    bundle: true,
    platform: "node",
    target: Target,
    format: "esm",
    splitting: true,
    outdir: OutputPath,
    outExtension: { ".js": ".mjs" },
    chunkNames: "chunks/[name]-[hash]",
    metafile: true,
    sourcemap: true,
    minify: false,
    jsx: "automatic",
    packages: "bundle",
    // Emitted into EVERY output file (chunks included); idempotent per module scope.
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module'",
        "const require = __createRequire(import.meta.url)"
      ].join("\n")
    },
    logLevel: "info",
    plugins: [createCommonJsResolvePlugin(), createFilenamePlugin(), chmodPlugin]
  })
  .catch(error => {
    // esbuild has printed its build diagnostics; anything else (a plugin throw, a bad option) is printed here.
    console.error(`esbuild failed: ${error?.stack ?? error}`)
    process.exit(1)
  })
