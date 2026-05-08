/**
 * Convert a freshly-decoded protobuf message into a JSON-serializable shape:
 * BigInts become decimal strings; Uint8Arrays become base64. Recursive walk
 * rather than a `JSON.stringify` replacer because `Buffer.prototype.toJSON`
 * fires BEFORE the replacer and converts a `Buffer` into
 * `{ type: "Buffer", data: number[] }` — which then never matches the
 * Uint8Array check. Walking the tree directly catches every Uint8Array
 * (including any `Buffer` subclass instances protobuf-ts may surface) and
 * is shared between the server (when emitting envelope events over WS)
 * and the local-disk client (when reading the same files directly).
 */
export function plainify<T>(value: T): T {
  return walk(value) as T
}

function walk(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64")
  if (Array.isArray(value)) return value.map(walk)
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        walk(v)
      ])
    )
  }
  return value
}
