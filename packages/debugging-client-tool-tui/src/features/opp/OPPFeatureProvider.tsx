import {
  ComponentProviders,
  FeatureComponentToken
} from "../../providers/ComponentProviders.js"
import type { RouteRegistry } from "../../router/RouteRegistry.js"
import type { ServiceManager } from "../../services/ServiceManager.js"
import { OPPTrackingService } from "./OPPTrackingService.js"
import { EpochTrackerPanel } from "./panels/EpochTrackerPanel.js"
import { OPPRoute } from "./routes/OPPRoute.js"
import { EpochStatusBarWidget } from "./widgets/EpochStatusBarWidget.js"

/** OPP envelope debugging feature — epoch tracker panel + current-epoch widget. */
export namespace OPPFeatureProvider {
  export const id = "opp" as const
  export const name = "OPP" as const
  export const isRequiredProvider = false
  /** Primary route path for the OPP feature. */
  export const RoutePath = "/opp" as const

  /** Install the panel + status widget. */
  export function registerComponents(providers: ComponentProviders): void {
    providers.register(FeatureComponentToken.Panel, EpochTrackerPanel)
    providers.register(FeatureComponentToken.StatusBar, EpochStatusBarWidget)
  }

  /** Register the tracking service. */
  export function registerServices(manager: ServiceManager): void {
    manager.register(OPPTrackingService)
  }

  /** Register the primary route rendering this feature full-screen. */
  export function registerRoutes(routes: typeof RouteRegistry): void {
    routes.register({
      path: RoutePath,
      name,
      featureId: id,
      component: OPPRoute,
      cyclable: true
    })
  }
}

export default OPPFeatureProvider
