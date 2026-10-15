/**
 * `__filename` in renderer modules is substituted by webpack (`node.__filename:
 * true`) with the module's path relative to the package — every file's
 * `getLogger(__filename)` gets its own category. The renderer has no Node types.
 */
declare var __filename: string
