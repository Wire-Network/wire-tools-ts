import type { Service } from "./Service.js"

/**
 * Constructor with static metadata. TypeScript can't enforce statics via
 * `implements`, so `ServiceManager.register` validates presence + shape at
 * runtime. {@link asServiceType} preserves the static signature for class
 * expressions.
 */
export interface ServiceType<T extends Service = Service> {
  readonly id: string
  readonly dependsOn: readonly string[]
  new (): T
}

/** Preserve ctor statics during class-expression declaration. */
export function asServiceType<T extends ServiceType>(ctor: T): T {
  return ctor
}
