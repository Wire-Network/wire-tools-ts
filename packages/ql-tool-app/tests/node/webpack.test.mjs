// Bundle smoke tests, run by `test:unit` right after `build:webpack`:
//  - every entry exists (main, preload, query-host, renderer + workers);
//  - plain Node can `require` the query-host bundle and get `startQueryHost`
//    without starting anything (no top-level parentPort use, no `electron`);
//  - `node.__filename: true` injected each module's own `src/...` path (the
//    logger category), never the bundle file name;
//  - the renderer page carries the production CSP <meta> from
//    src/common/QLContentSecurityPolicy.ts and no Node builtin is left as a
//    runtime require in the sandboxed preload.
import Assert from "node:assert/strict"
import Fs from "node:fs"
import { createRequire } from "node:module"
import Path from "node:path"
import { test } from "node:test"

const packagePath = Path.resolve(import.meta.dirname, "..", ".."),
  appPath = Path.join(packagePath, "dist", "app"),
  require = createRequire(import.meta.url),
  read = file => Fs.readFileSync(Path.join(appPath, file), "utf8")

test("every bundle entry exists", () => {
  ;["main.js", "preload.js", "query-host.js", "package.json", "assets/icon-512.png", "renderer/index.html",
    "renderer/renderer.js", "renderer/editor.worker.js", "renderer/json.worker.js"].forEach(file =>
    Assert.ok(Fs.existsSync(Path.join(appPath, file)), `${file} missing`)
  )
  Assert.equal(JSON.parse(read("package.json")).main, "main.js")
})

test("plain Node requires the query-host bundle without starting it", () => {
  const host = require(Path.join(appPath, "query-host.js"))
  Assert.equal(typeof host.startQueryHost, "function")
  Assert.equal(process.parentPort, undefined)
  Assert.doesNotMatch(read("query-host.js"), /require\("electron"\)/)
})

test("each bundle injects its modules' own src/ paths as __filename", () => {
  const expectations = [
    ["main.js", ["src/main/AppLifecycle.ts", "src/main/query/QueryHostLauncher.ts"]],
    ["preload.js", ["src/preload/preload.ts"]],
    ["query-host.js", ["src/query-host/QueryHost.ts", "src/query-host/main.ts"]],
    ["renderer/renderer.js", ["src/renderer/App.tsx", "src/renderer/query/QueryPortClient.ts"]]
  ]
  expectations.forEach(([bundle, modules]) => {
    const text = read(bundle)
    modules.forEach(module => Assert.ok(text.includes(`"${module}"`), `${bundle} lacks ${module}`))
    Assert.ok(!text.includes(`getLogger("${bundle}")`), `${bundle} logs under its bundle name`)
  })
})

test("the renderer page carries the production CSP meta", () => {
  const html = read("renderer/index.html"),
    meta = /<meta http-equiv="?Content-Security-Policy"? content="([^"]+)"/.exec(html)
  Assert.ok(meta != null, "CSP meta missing")
  Assert.match(meta[1], /script-src 'self'/)
  Assert.match(meta[1], /worker-src 'self' blob:/)
  Assert.doesNotMatch(meta[1], /unsafe-eval/)
  Assert.doesNotMatch(meta[1], /frame-ancestors/)
})

test("the sandboxed preload requires nothing but electron at runtime", () => {
  const requires = [...read("preload.js").matchAll(/(?<![.\w])require\("([^"]+)"\)/g)].map(match => match[1])
  Assert.deepEqual([...new Set(requires)], ["electron"])
})

test("the ONE webpack config exports the four bundles at one mode; only web targets get the crypto fallback", async () => {
  const { default: createConfigs } = await import(Path.join(packagePath, "etc", "webpack", "webpack.config.mjs")),
    { AppPaths, WebFallback, WebTarget } = await import(Path.join(packagePath, "etc", "webpack", "webpack.common.mjs")),
    configs = await createConfigs({}, { mode: "development" })
  Assert.deepEqual(configs.map(config => config.name), ["main", "preload", "query-host", "renderer"])
  configs.forEach(config => {
    Assert.equal(config.mode, "development")
    Assert.deepEqual(config.resolve.fallback, config.target === WebTarget ? WebFallback : undefined)
  })
  const [main, preload, queryHost] = configs
  Assert.equal(main.output.filename, AppPaths.MainFilename)
  Assert.equal(preload.output.filename, AppPaths.PreloadFilename)
  Assert.equal(queryHost.output.filename, AppPaths.HostModuleFilename)
  Assert.deepEqual(queryHost.output.library, { type: "commonjs2" })
  Assert.ok(queryHost.output.devtoolModuleFilenameTemplate, "query-host keeps the common output members")
  Assert.equal((await createConfigs({}, {}))[0].mode, "production")
})

test("webpack and electron-builder read ONE app identity", () => {
  const identity = require(Path.join(packagePath, "etc", "app-identity", "app-identity.cjs")),
    builder = require(Path.join(packagePath, "etc", "electron-builder", "electron-builder.config.cjs")),
    manifest = JSON.parse(read("package.json"))
  Assert.equal(builder.appId, identity.AppId)
  Assert.equal(builder.executableName, identity.ExecutableName)
  Assert.equal(builder.deb.packageName, identity.DebPackageName)
  Assert.equal(builder.linux.maintainer, identity.Author)
  Assert.equal(manifest.name, identity.ManifestName)
  Assert.equal(manifest.desktopName, identity.DesktopName)
  Assert.equal(manifest.homepage, identity.Homepage)
})
