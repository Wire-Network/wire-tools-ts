import { z } from "zod"

/**
 * The largest `uint32`, `2^32 - 1`: the ceiling of a protobuf `uint32` field
 * and of a nodeop option parsed as `uint32_t`. Changing it changes what every
 * {@link Uint32Schema} field accepts.
 */
export const MaximumUint32 = 0xffff_ffff

/**
 * A `uint32` carried as a JSON number: a whole number from 0 to
 * {@link MaximumUint32}. A persisted value bound for a `uint32` (a nodeop
 * option, a protobuf field) is checked against this, so a value past the range
 * is refused when the config resolves or loads, not when its consumer parses
 * it.
 */
export const Uint32Schema = z.number().int().nonnegative().max(MaximumUint32)
