import { Either } from "@3fv/prelude-ts"
import { z } from "zod"

import { NestedError } from "@wireio/shared"

/**
 * The uniform runtime codec over a zod schema: validated string serialization,
 * validated deserialization from JSON text or bytes, and a type guard — the ONE
 * shape every persisted type's codec exposes. `T` is the schema's DECODED
 * (in-memory) type; `serialize` runs the schema's ENCODE direction (so a zod
 * `codec` field — e.g. the {@link ChainTokenAmount} bigint bridge — projects to
 * its wire form) and `deserialize` runs DECODE (rehydrating that field).
 */
export interface SchemaCodec<T> {
  /** Encode + pretty-print `value` to a JSON string. */
  serialize(value: T): string
  /**
   * Parse + validate + decode JSON `data` (text or UTF-8 bytes) into a `T`.
   *
   * @throws Error carrying the structured zod issue paths when `data` is not a
   *   valid `T` (or is not valid JSON).
   */
  deserialize(data: string | Uint8Array): T
  /** zod-built type guard: does `value` structurally satisfy the schema. */
  check(value: unknown): value is T
}

/**
 * Factory + internals for {@link SchemaCodec} — `SchemaCodec.create(schema)`
 * returns the codec for a schema, matching the user-directed generic-factory
 * pattern (`SchemaCodec.create<User>(UserSchema)`). safeParse results flow
 * through `Either` (never a bare `if (result.success)`); the ONE bridge is the
 * private {@link toEither}.
 */
export namespace SchemaCodec {
  /** Indent width for every serialized document (harness JSON is pretty-printed). */
  export const SerializeIndent = 2

  /** Discriminated safe-parse result of a `z.ZodType<T>` (name-stable via `ReturnType`). */
  type SafeParseResult<T> = ReturnType<z.ZodType<T>["safeParse"]>

  /**
   * Create the {@link SchemaCodec} for `schema`.
   *
   * @param schema - The zod schema whose decoded type is `T`.
   * @returns The codec exposing `serialize` / `deserialize` / `check`.
   */
  export function create<T>(schema: z.ZodType<T>): SchemaCodec<T> {
    return {
      serialize(value: T): string {
        return JSON.stringify(z.encode(schema, value), null, SerializeIndent)
      },
      deserialize(data: string | Uint8Array): T {
        const text =
          typeof data === "string" ? data : new TextDecoder().decode(data)
        return decode(schema, text)
      },
      check(value: unknown): value is T {
        return schema.safeParse(value).success
      }
    }
  }

  /** The ONE safeParse → `Either` bridge — every consumer chains off this. */
  function toEither<T>(result: SafeParseResult<T>): Either<z.ZodError, T> {
    return result.success
      ? Either.right<z.ZodError, T>(result.data)
      : Either.left<z.ZodError, T>(result.error)
  }

  /** Parse `text` as JSON then validate + decode against `schema`, throwing on either failure. */
  function decode<T>(schema: z.ZodType<T>, text: string): T {
    // The Left is only ever thrown, so `.ifLeft(throw).getOrThrow()` — NOT
    // `.mapLeft(...).match({ Left: throw, Right: identity })`. `.ifLeft` throws
    // the NestedError on a Left; `.getOrThrow()` returns the Right value (a Left
    // never reaches it).
    const parsed = Either.try(() => JSON.parse(text) as unknown)
      .ifLeft(error => {
        throw new NestedError("SchemaCodec: invalid JSON", {
          cause: error,
          context: { text }
        })
      })
      .getOrThrow()
    return toEither(schema.safeParse(parsed))
      .ifLeft(error => {
        throw formatIssues(error, text)
      })
      .getOrThrow()
  }

  /**
   * Render a `ZodError` as a {@link NestedError} that PRESERVES the ZodError as its
   * cause (its issue tree + stack survive) — one `path: message` line per issue in
   * the message, the failing `text` in the context.
   */
  function formatIssues(error: z.ZodError, text: string): NestedError {
    const detail = error.issues
      .map(
        issue =>
          `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`
      )
      .join("; ")
    return new NestedError(`SchemaCodec: validation failed — ${detail}`, {
      cause: error,
      context: { text }
    })
  }
}
