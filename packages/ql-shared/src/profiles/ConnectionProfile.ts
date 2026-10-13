import { z } from "zod"

import { SchemaCodec } from "@wireio/cluster-tool-shared"

import { ConnectionProfileDefaults } from "./ConnectionProfileDefaults.js"

/** URL schemes an API node endpoint may use. */
const EndpointProtocolPattern = /^https?$/

/** A saved connection to an API node — an endpoint plus client tuning; nothing secret. */
export const ConnectionProfileSchema = z.strictObject({
  /** Unique profile name. */
  name: z.string().min(1),
  /** Base URL of the API node's http-server-address, e.g. `http://<host>:<port>` */
  endpoint: z.url({ protocol: EndpointProtocolPattern }),
  /** Client fetch ceiling (ms). */
  transportTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(ConnectionProfileDefaults.TransportTimeoutMs),
  /** Request `timeout_ms` (server deadline); absent → server default. */
  queryTimeoutMs: z.number().int().positive().optional(),
  /** Auto-retry attempts after the first. */
  retries: z.number().int().min(0).default(ConnectionProfileDefaults.Retries),
  /** Persisted ONLY when the user customizes; absent → ConnectionProfileDefaults.owners() at read time. */
  owners: z.array(z.string()).optional()
})

/** A connection profile. */
export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>

/** Validating codec for {@link ConnectionProfileSchema}. */
export const ConnectionProfileCodec = SchemaCodec.create<ConnectionProfile>(ConnectionProfileSchema)

/** Caller input for a profile — the defaulted members may be omitted. */
export type ConnectionProfileInput = z.input<typeof ConnectionProfileSchema>

/** Profile helpers. */
export namespace ConnectionProfile {
  /**
   * Validate + default a profile.
   *
   * @param input - The profile fields (defaults fill `transportTimeoutMs` / `retries`).
   * @returns The validated profile.
   */
  export function create(input: ConnectionProfileInput): ConnectionProfile {
    return ConnectionProfileSchema.parse(input)
  }

  /**
   * Effective owners: the custom list, or the read-time default seed.
   *
   * @param profile - The profile.
   * @returns The owner accounts to browse.
   */
  export function resolveOwners(profile: ConnectionProfile): string[] {
    return profile.owners ?? ConnectionProfileDefaults.owners()
  }
}

/** The persisted `profiles.json` document schema. */
export const ConnectionProfilesDocumentSchema = z.strictObject({
  /** Name of the default profile; explicit null persists in JSON. */
  defaultProfile: z.string().nullable(),
  /** Every saved profile. */
  profiles: z.array(ConnectionProfileSchema)
})

/** The persisted `profiles.json` document (browser-safe model; the file store is in `@wireio/ql-shared/node`). */
export type ConnectionProfilesDocument = z.infer<
  typeof ConnectionProfilesDocumentSchema
>

/** Codec for {@link ConnectionProfilesDocumentSchema}. */
export const ConnectionProfilesDocumentCodec =
  SchemaCodec.create<ConnectionProfilesDocument>(
    ConnectionProfilesDocumentSchema
  )

/** Document helpers. */
export namespace ConnectionProfilesDocument {
  /**
   * The empty document (no profiles, no default).
   *
   * @returns A new empty document.
   */
  export function empty(): ConnectionProfilesDocument {
    return { defaultProfile: null, profiles: [] }
  }
}
