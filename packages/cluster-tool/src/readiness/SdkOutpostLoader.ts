import Module from "node:module"

type SdkOutpost = typeof import("@wireio/sdk-outpost")

let sdkOutpost: SdkOutpost | undefined

/** Load the optional SDK only when an SDK-backed readiness check is requested. */
export function loadSdkOutpost(): SdkOutpost {
  return (sdkOutpost ??= Module.createRequire(__filename)(
    "@wireio/sdk-outpost"
  ) as SdkOutpost)
}
