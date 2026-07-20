import { Either } from "@3fv/prelude-ts"
import { z } from "zod"

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
    const parsed = Either.try(() => JSON.parse(text) as unknown)
      .mapLeft(
        error => new Error(`SchemaCodec: invalid JSON — ${toMessage(error)}`)
      )
      .match({
        Left: error => {
          throw error
        },
        Right: value => value
      })
    return toEither(schema.safeParse(parsed))
      .mapLeft(formatIssues)
      .match({
        Left: error => {
          throw error
        },
        Right: value => value
      })
  }

  /** Render a `ZodError`'s issues as one `path: message` line per issue. */
  function formatIssues(error: z.ZodError): Error {
    const detail = error.issues
      .map(
        issue =>
          `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`
      )
      .join("; ")
    return new Error(`SchemaCodec: validation failed — ${detail}`)
  }

  /** Extract a message from an unknown thrown value. */
  function toMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
