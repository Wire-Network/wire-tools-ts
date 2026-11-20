// A real flow reserves its complete binding before any daemon starts. Keep the
// owner alive until the test closes stdin, including when its worker dies.
const { BindConfigProvider } = require("../../../lib/cjs/config/BindConfigProvider.js"),
  { withFileLock } = require("../../../lib/cjs/utils/fsUtils.js"),
  { Deferred, getLogger } = require("@wireio/shared"),
  log = getLogger(__filename),
  released = Deferred.useCallback(deferred => {
    process.stdin.on("end", () => deferred.resolve())
  })

process.stdin.resume()
const ready = process.argv.includes("--hold-lock")
  ? withFileLock(BindConfigProvider.portLockPath(), async () => {
      process.send(true)
      await released.promise
    })
  : BindConfigProvider.resolve({}, {}).then(async config => {
      process.send(config.kiod.port)
      await released.promise
    })
ready
  .then(() => process.exit(0))
  .catch(error => {
    log.error("Host port reservation failed", error)
    process.exit(1)
  })
