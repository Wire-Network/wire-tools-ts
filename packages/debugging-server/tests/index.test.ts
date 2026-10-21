/**
 * The package barrel is a library entry: importing it must not install a
 * process-global stack-trace hook. `source-map-support/register` belongs in the
 * `cli.ts` executable entry only — installed from the barrel, its `auto` mode
 * mistakes a jsdom test environment for a browser and fetches source maps with a
 * synchronous XHR to `http://localhost/`, which blocks the jest worker on a host
 * that never refuses a connect to a closed localhost port.
 */
describe("@wireio/debugging-server barrel", () => {
  it("does not replace Error.prepareStackTrace when imported", () => {
    const before = Error.prepareStackTrace

    jest.isolateModules(() => {
      require("@wireio/debugging-server")
    })

    expect(Error.prepareStackTrace).toBe(before)
  })
})
