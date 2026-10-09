import { loader } from "@monaco-editor/react"
import * as monaco from "monaco-editor/editor/editor.api.js"
import { createRoot } from "react-dom/client"

import { getLogger } from "@wireio/shared"

import { App } from "./App.js"
import { BridgeClient } from "./ipc/index.js"
import { RendererLogging } from "./logging/index.js"
import { QueryPortClient } from "./query/index.js"
import { createWorkbenchStore } from "./store/index.js"

/** The page element React mounts into. */
const RootElementId = "root"

const bridge = BridgeClient.bridge()
RendererLogging.install(bridge)
const log = getLogger(__filename)

// Monaco runs from the local bundle (no CDN): @monaco-editor/react uses THIS instance.
loader.config({ monaco })

const queryPort = new QueryPortClient(BridgeClient.createQueryPortConnector()),
  store = createWorkbenchStore({
    bridge,
    queryPort,
    createRequestId: () => crypto.randomUUID(),
    clock: () => new Date()
  })

createRoot(document.getElementById(RootElementId)).render(<App store={store} bridge={bridge} queryPort={queryPort} />)
log.info("renderer started")
