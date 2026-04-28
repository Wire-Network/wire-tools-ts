import {
  ComponentProviders,
  FeatureComponentToken
} from "../../providers/ComponentProviders.js"
import type { RouteRegistry } from "../../router/RouteRegistry.js"
import type { ServiceManager } from "../../services/ServiceManager.js"
import { OPPTrackingService } from "./OPPTrackingService.js"
import { EpochTrackerPanel } from "./panels/EpochTrackerPanel.js"
import { EpochDetailRoute } from "./routes/EpochDetailRoute.js"
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

  /**
   * Register both the cyclable tracker route and the detail-only route. The
   * detail route opts out of the Shift+Tab cycle (`cyclable: false`) so it
   * doesn't pollute the main rotation — users reach it exclusively by
   * pressing Enter on a tracker row.
   */
  export function registerRoutes(routes: typeof RouteRegistry): void {
    routes.register({
      path: RoutePath,
      name,
      featureId: id,
      component: OPPRoute,
      cyclable: true
    })
    routes.register({
      path: EpochDetailRoute.RoutePath,
      name: EpochDetailRoute.Name,
      featureId: id,
      component: EpochDetailRoute,
      cyclable: false
    })
  }
}

export default OPPFeatureProvider
