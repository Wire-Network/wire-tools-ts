import Assert from "node:assert"

/**
 * A typed handle into the {@link OutputStore}. The phantom `__type` ties the
 * string key to the value type `T`; mint them with {@link outputKey} on
 * companion namespaces.
 */
export interface OutputKey<T> {
  readonly name: string
  readonly description: string
  readonly __type?: (value: T) => T
}

/** Construct a typed output key (the only way to mint one). */
export function outputKey<T>(name: string, description: string): OutputKey<T> {
  return { name, description }
}

/**
 * Typed cross-step store — replaces a `Map<string, unknown>` + `as T` casts at
 * every call site. `get` returns `T | null` (null over undefined); `assert`
 * throws when the key is absent.
 */
export class OutputStore {
  private readonly values = new Map<string, unknown>()

  /** Store `value` under `key` (fluent). */
  set<T>(key: OutputKey<T>, value: T): this {
    this.values.set(key.name, value)
    return this
  }

  /** The stored value, or null when absent. */
  get<T>(key: OutputKey<T>): T | null {
    return this.values.has(key.name) ? (this.values.get(key.name) as T) : null
  }

  /** The stored value; throws when absent. */
  assert<T>(key: OutputKey<T>): T {
    Assert.ok(
      this.values.has(key.name),
      `Missing asserted output: ${key.name} (${key.description})`
    )
    return this.values.get(key.name) as T
  }

  /** Whether a value is stored under `key`. */
  has<T>(key: OutputKey<T>): boolean {
    return this.values.has(key.name)
  }
}
