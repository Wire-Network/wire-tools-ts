import {
  RunEvidencePersistenceError,
  RunEvidencePersistenceErrorCode
} from "./RunEvidencePersistenceError.js"

type JsonPrimitive = boolean | null | number | string
type CanonicalJson = JsonPrimitive | CanonicalArray | CanonicalObject
interface CanonicalArray extends ReadonlyArray<CanonicalJson> {}
interface CanonicalObject {
  readonly [key: string]: CanonicalJson
}

/** Serialize deterministic compact JSON with lexical keys and one trailing newline. */
export function canonicalEvidenceJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(normalizeJson(value, new WeakSet()))}\n`)
}

function normalizeJson(
  value: unknown,
  ancestors: WeakSet<object>
): CanonicalJson {
  if (value === null) return null
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value
  if (typeof value === "bigint") return value.toString(10)
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value
    throw unsupported(
      "numbers must be safe integers; use bigint for large values"
    )
  }
  if (Array.isArray(value)) return normalizeArray(value, ancestors)
  if (typeof value === "object") return normalizeObject(value, ancestors)
  throw unsupported(`unsupported JSON value type: ${typeof value}`)
}

function normalizeArray(
  value: readonly unknown[],
  ancestors: WeakSet<object>
): readonly CanonicalJson[] {
  enter(value, ancestors)
  try {
    rejectSymbolKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value),
      expectedNames = new Set([
        "length",
        ...Array.from({ length: value.length }, (_unused, index) =>
          String(index)
        )
      ])
    if (
      Object.getOwnPropertyNames(value).some(name => !expectedNames.has(name))
    )
      throw unsupported("named array properties are unsupported")
    return Array.from({ length: value.length }, (_unused, index) => {
      const descriptor = descriptors[String(index)]
      if (descriptor === undefined)
        throw unsupported("sparse arrays are unsupported")
      return normalizeJson(dataDescriptorValue(descriptor), ancestors)
    })
  } finally {
    ancestors.delete(value)
  }
}

function normalizeObject(
  value: object,
  ancestors: WeakSet<object>
): CanonicalObject {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw unsupported("only plain JSON objects are supported")
  enter(value, ancestors)
  try {
    rejectSymbolKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return Object.fromEntries(
      Object.getOwnPropertyNames(value)
        .sort()
        .map(key => [
          key,
          normalizeJson(dataDescriptorValue(descriptors[key]), ancestors)
        ])
    )
  } finally {
    ancestors.delete(value)
  }
}

function dataDescriptorValue(
  descriptor: PropertyDescriptor | undefined
): unknown {
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !("value" in descriptor)
  )
    throw unsupported("accessor properties are unsupported")
  if (!descriptor.enumerable)
    throw unsupported("non-enumerable properties are unsupported")
  return descriptor.value
}

function rejectSymbolKeys(value: object): void {
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw unsupported("symbol-keyed properties are unsupported")
}

function enter(value: object, ancestors: WeakSet<object>): void {
  if (ancestors.has(value))
    throw unsupported("cyclic JSON values are unsupported")
  ancestors.add(value)
}

function unsupported(message: string): RunEvidencePersistenceError {
  return new RunEvidencePersistenceError(
    RunEvidencePersistenceErrorCode.UnsupportedJson,
    message
  )
}
