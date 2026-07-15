import { type PanelComponentType } from "../components/PanelComponent.js"
import { type StatusBarComponentType } from "../components/StatusBarComponent.js"

/** Constructor token accepted by `register`/`get` — works on abstract bases too. */
export enum FeatureComponentToken {
  Panel = "Panel",
  StatusBar = "StatusBar"
}
//
// export type FeatureComponentProps<T extends FeatureComponentToken> =
//   T extends FeatureComponentToken.Panel
//     ? PanelComponentProps
//     : T extends FeatureComponentToken.StatusBar
//       ? StatusBarComponentProps
//       : never

export type FeatureComponentType<
  T extends FeatureComponentToken = FeatureComponentToken
> = T extends FeatureComponentToken.Panel
  ? PanelComponentType
  : T extends FeatureComponentToken.StatusBar
    ? StatusBarComponentType
    : never

/**
 * Global registry of UI component contributions. Debuggers (core + feature)
 * register Panel and StatusWidget instances; the shell queries them by base
 * class token to build the layout.
 *
 * Usage:
 *   ComponentProviders.register(Panel, new ProcessMonitorPanel())
 *   const panels = ComponentProviders.get(Panel)
 *   const widgets = ComponentProviders.get(StatusWidget)
 */
class ComponentProvidersRegistry {
  private readonly byToken = new Map<
    FeatureComponentToken,
    Array<FeatureComponentType>
  >()

  protected getComponents<T extends FeatureComponentToken>(
    token: T
  ): FeatureComponentType<T>[] {
    const components =
      (this.byToken.get(token) as FeatureComponentType<T>[]) ?? []
    this.byToken.set(token, components)
    return components
  }

  /** Append an instance under its base-class token. */
  register<T extends FeatureComponentToken>(
    token: T,
    component: FeatureComponentType<T>
  ): this {
    this.getComponents<T>(token).push(component)

    return this
  }

  /**
   * Return every instance registered under a token, sorted by descending
   * `priority` (missing priorities default to 0).
   */
  get<T extends FeatureComponentToken>(token: T): FeatureComponentType<T>[] {
    return this.getComponents<T>(token)
  }

  /** Drop every registration for a token — used in tests and hot-reload. */
  clear<T extends FeatureComponentToken>(token: T): this {
    this.byToken.delete(token)
    return this
  }
}

/** Process-wide registry singleton. */
export const ComponentProviders = new ComponentProvidersRegistry()
export type ComponentProviders = typeof ComponentProviders
