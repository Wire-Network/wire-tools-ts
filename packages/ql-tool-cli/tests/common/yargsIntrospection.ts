/** Option tables yargs keeps (untyped in @types/yargs). */
export interface ParserOptionTables {
  /** Declared `default:` values by key. */
  default: Record<string, unknown>
}

/** The option introspection every yargs instance exposes. */
export interface ParserOptionsIntrospection {
  /** The option tables. */
  getOptions(): ParserOptionTables
}

/**
 * Keys that declare a yargs `default:`.
 *
 * @param parser - A yargs instance.
 * @returns The keys.
 */
export function declaredDefaults(parser: object): string[] {
  return Object.keys((parser as ParserOptionsIntrospection).getOptions().default)
}
