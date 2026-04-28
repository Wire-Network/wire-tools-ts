import {
  ComponentProviders,
  FeatureComponentToken
} from "../../providers/ComponentProviders.js"
import type { RouteRegistry } from "../../router/RouteRegistry.js"
import type { ServiceManager } from "../../services/ServiceManager.js"
import { LogTailingService } from "./LogTailingService.js"
import { ProcessMonitorService } from "./ProcessMonitorService.js"
import { LogViewerPanel } from "./panels/LogViewerPanel.js"
import { ProcessMonitorPanel } from "./panels/ProcessMonitorPanel.js"
import { ProcessMonitorRoute } from "./routes/ProcessMonitorRoute.js"
import { NodeCountWidget } from "./widgets/NodeCountWidget.js"

/**
 * Always-on feature: liveness-tracked process list (including Anvil and
 * solana-test-validator) + virtual log viewer. Registered automatically — does
 * not opt in via `--features`.
 */
export namespace ProcessMonitorFeatureProvider {
  export const id = "process-monitor" as const
  export const name = "Process Monitor" as const
  export const isRequiredProvider = true
  /** Primary route path for the Process Monitor feature. Also the TUI's home route. */
  export const RoutePath = "/process-monitor" as const

  /** Install both panels + the node-count widget. */
  export function registerComponents(providers: ComponentProviders): void {
    providers.register(FeatureComponentToken.Panel, ProcessMonitorPanel)
    providers.register(FeatureComponentToken.Panel, LogViewerPanel)
    providers.register(FeatureComponentToken.StatusBar, NodeCountWidget)
  }

  /** Register liveness and log-tailing services. Order matters — LogTailing
   * declares a dep on ProcessMonitor, so ProcessMonitor must register first. */
  export function registerServices(manager: ServiceManager): void {
    manager.register(ProcessMonitorService)
    manager.register(LogTailingService)
  }

  /** Register the primary route rendering this feature full-screen. */
  export function registerRoutes(routes: typeof RouteRegistry): void {
    routes.register({
      path: RoutePath,
      name,
      featureId: id,
      component: ProcessMonitorRoute,
      cyclable: true
    })
  }
}

export default ProcessMonitorFeatureProvider
