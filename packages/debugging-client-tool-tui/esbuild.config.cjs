const esbuild = require("esbuild")
const { chmodSync } = require("fs")
const { spawn } = require("child_process")

const shouldWatch =
  process.argv.includes("--watch") ||
  process.argv.includes("-w") ||
  process.env.WATCH === "1"

const shouldDev = process.argv.includes("--dev") || process.env.DEV === "1"

const outfile = "dist/bundle/wire-debugging-client-tool-tui.mjs"

let tuiProcess = null

/**
 * Mark the bundled output executable so node can launch it via shebang.
 */
const chmodPlugin = {
  name: "chmod",
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length > 0) return
      try {
        chmodSync(build.initialOptions.outfile, 0o755)
      } catch (err) {
        console.error(
          `chmod failed for ${build.initialOptions.outfile}:`,
          err.message
        )
      }
    })
  }
}

/**
 * Dev mode — restart the TUI process on every successful rebuild so edits
 * take effect without a manual relaunch. SIGTERM the previous process,
 * spawn a fresh one with stdio inherited so the terminal UI stays live.
 */
const devTuiPlugin = {
  name: "dev-tui",
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length > 0) return

      if (tuiProcess) {
        console.log("[dev] Restarting TUI…")
        tuiProcess.kill("SIGTERM")
        tuiProcess = null
      } else {
        console.log("[dev] Starting TUI…")
      }

      const tuiArgs = process.argv
        .slice(process.argv.indexOf("--dev") + 1)
        .filter(arg => arg !== "--dev")

      tuiProcess = spawn(
        "node",
        [build.initialOptions.outfile, ...tuiArgs],
        { stdio: "inherit" }
      )

      tuiProcess.on("exit", (code, signal) => {
        if (signal !== "SIGTERM") {
          console.log(`[dev] TUI exited (code=${code}, signal=${signal})`)
        }
        tuiProcess = null
      })
    })
  }
}

async function main() {
  const plugins = [chmodPlugin]
  if (shouldDev) {
    plugins.push(devTuiPlugin)
  }

  const ctx = await esbuild.context({
    entryPoints: ["src/tui.ts"],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    outfile,
    sourcemap: true,
    minify: false,
    jsx: "automatic",
    loader: {
      ".ts": "ts",
      ".tsx": "tsx"
    },
    banner: {
      js: "#!/usr/bin/env node"
    },
    // Keep all node_modules external — ink and yoga-layout use top-level
    // await and dynamic imports that require native ESM resolution at
    // runtime rather than being pre-bundled into a single file.
    packages: "external",
    logLevel: "info",
    plugins
  })

  if (shouldWatch || shouldDev) {
    await ctx.watch()

    process.on("SIGINT", async () => {
      if (tuiProcess) tuiProcess.kill("SIGTERM")
      await ctx.dispose()
      process.exit(0)
    })
  } else {
    await ctx.rebuild()
    await ctx.dispose()
  }
}

main()
