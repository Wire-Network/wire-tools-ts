const esbuild = require("esbuild")
const { chmodSync } = require("fs")
const { spawn } = require("child_process")

const shouldWatch =
  process.argv.includes("--watch") ||
  process.argv.includes("-w") ||
  process.env.WATCH === "1"

const shouldDev = process.argv.includes("--dev") || process.env.DEV === "1"

const outfile = "dist/bundle/wire-debugging-server.cjs"

let serverProcess = null

const chmodPlugin = {
  name: "chmod",
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length > 0) return
      const outfile = build.initialOptions.outfile
      try {
        chmodSync(outfile, 0o755)
      } catch (err) {
        console.error(`chmod failed for ${outfile}:`, err.message)
      }
    })
  }
}

const devServerPlugin = {
  name: "dev-server",
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length > 0) return

      if (serverProcess) {
        console.log("[dev] Restarting server…")
        serverProcess.kill("SIGTERM")
        serverProcess = null
      } else {
        console.log("[dev] Starting server…")
      }

      const serverArgs = process.argv
        .slice(process.argv.indexOf("--dev") + 1)
        .filter(arg => arg !== "--dev")

      serverProcess = spawn(
        "node",
        [build.initialOptions.outfile, "start", ...serverArgs],
        { stdio: "inherit" }
      )

      serverProcess.on("exit", (code, signal) => {
        if (signal !== "SIGTERM") {
          console.log(`[dev] Server exited (code=${code}, signal=${signal})`)
        }
        serverProcess = null
      })
    })
  }
}

async function main() {
  const plugins = [chmodPlugin]
  if (shouldDev) {
    plugins.push(devServerPlugin)
  }

  const ctx = await esbuild.context({
    entryPoints: ["src/cli.ts"],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile,
    sourcemap: true,
    minify: false,
    banner: {
      js: "var import_meta_url = require('url').pathToFileURL(__filename).href;"
    },
    define: {
      "import.meta.url": "import_meta_url"
    },
    external: [],
    logLevel: "info",
    plugins
  })

  if (shouldWatch || shouldDev) {
    await ctx.watch()

    process.on("SIGINT", async () => {
      if (serverProcess) serverProcess.kill("SIGTERM")
      await ctx.dispose()
      process.exit(0)
    })
  } else {
    await ctx.rebuild()
    await ctx.dispose()
  }
}

main()
