import { TextDecoder, TextEncoder } from "node:util"

// jsdom omits the WHATWG encoding globals that @wireio/shared's crypto dependencies
// (@noble/curves) read at import time; node:util provides the same implementations.
// A setup file of its own, run first: every later setup file's imports see them.
Object.assign(globalThis, {
  TextEncoder: globalThis.TextEncoder ?? TextEncoder,
  TextDecoder: globalThis.TextDecoder ?? TextDecoder
})
