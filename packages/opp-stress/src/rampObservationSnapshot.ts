/** Fresh data-property snapshot used by the ramp observation parser. */
export type RampObservationRecord = Readonly<Record<string, unknown>>

/**
 * Snapshot an exact plain data object without evaluating accessors.
 *
 * @param input Untrusted callback value.
 * @param expectedKeys Exact string keys required by one observation variant.
 * @returns Fresh data snapshot, or null when shape or descriptors are invalid.
 */
export function snapshotRampObservationData(
  input: unknown,
  expectedKeys: readonly string[]
): RampObservationRecord | null {
  try {
    return snapshotRampObservationDataUnsafe(input, expectedKeys)
  } catch {
    return null
  }
}

/**
 * Snapshot one of several exact root-key variants with a single reflection pass.
 *
 * @param input Untrusted callback value.
 * @param expectedKeyVariants Allowed exact root-key collections.
 * @returns Fresh recursive data snapshot, or null for unsafe or unmatched input.
 */
export function snapshotRampObservationVariantData(
  input: unknown,
  expectedKeyVariants: readonly (readonly string[])[]
): RampObservationRecord | null {
  try {
    return snapshotRampObservationVariantDataUnsafe(input, expectedKeyVariants)
  } catch {
    return null
  }
}

function snapshotRampObservationDataUnsafe(
  input: unknown,
  expectedKeys: readonly string[]
): RampObservationRecord | null {
  return snapshotRampObservationVariantDataUnsafe(input, [expectedKeys])
}

function snapshotRampObservationVariantDataUnsafe(
  input: unknown,
  expectedKeyVariants: readonly (readonly string[])[]
): RampObservationRecord | null {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return null
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return null
  const ownKeys = Reflect.ownKeys(input)
  if (!expectedKeyVariants.some(keys => hasExactKeys(ownKeys, keys)))
    return null
  const snapshot: Record<string, unknown> = {},
    ancestors = new Set<object>([input])
  const hasExactDataDescriptors = ownKeys.every(key => {
    if (typeof key !== "string") return false
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      return false
    const value = snapshotRampObservationValue(descriptor.value, ancestors)
    if (value === InvalidSnapshot) return false
    snapshot[key] = value
    return true
  })
  return hasExactDataDescriptors ? Object.freeze(snapshot) : null
}

function hasExactKeys(
  ownKeys: readonly PropertyKey[],
  expectedKeys: readonly string[]
): boolean {
  return (
    ownKeys.length === expectedKeys.length &&
    ownKeys.every(
      key => typeof key === "string" && expectedKeys.includes(key)
    ) &&
    expectedKeys.every(key => ownKeys.includes(key))
  )
}

const InvalidSnapshot = Symbol("invalid ramp observation snapshot")

function snapshotRampObservationValue(
  input: unknown,
  ancestors: Set<object>
): unknown | typeof InvalidSnapshot {
  if (typeof input !== "object" || input === null) return input
  if (ancestors.has(input)) return InvalidSnapshot
  ancestors.add(input)
  const snapshot = Array.isArray(input)
    ? snapshotArray(input, ancestors)
    : snapshotObject(input, ancestors)
  ancestors.delete(input)
  return snapshot
}

function snapshotArray(
  input: readonly unknown[],
  ancestors: Set<object>
): readonly unknown[] | typeof InvalidSnapshot {
  const ownKeys = Reflect.ownKeys(input),
    lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length")
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    typeof lengthDescriptor.value !== "number" ||
    ownKeys.length !== lengthDescriptor.value + 1
  )
    return InvalidSnapshot
  const values: unknown[] = []
  return Array.from({ length: lengthDescriptor.value }).every((_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      return false
    const value = snapshotRampObservationValue(descriptor.value, ancestors)
    if (value === InvalidSnapshot) return false
    values.push(value)
    return true
  })
    ? Object.freeze(values)
    : InvalidSnapshot
}

function snapshotObject(
  input: object,
  ancestors: Set<object>
): RampObservationRecord | typeof InvalidSnapshot {
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null)
    return InvalidSnapshot
  const snapshot: Record<string, unknown> = {},
    valid = Reflect.ownKeys(input).every(key => {
      if (typeof key !== "string") return false
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      )
        return false
      const value = snapshotRampObservationValue(descriptor.value, ancestors)
      if (value === InvalidSnapshot) return false
      snapshot[key] = value
      return true
    })
  return valid ? Object.freeze(snapshot) : InvalidSnapshot
}
