import type { Either } from "@3fv/prelude-ts"

import { SchemaCodec } from "@wireio/cluster-tool-shared"

import { ConnectionProfileCodec, type ConnectionProfile } from "./ConnectionProfile.js"
import { ConnectionProfileDefaults } from "./ConnectionProfileDefaults.js"

/**
 * The editable text form of a {@link ConnectionProfile} — the fields every
 * profile editor (the GUI connection manager, the TUI Profiles route) shows,
 * held as raw text until validated.
 */
export interface ConnectionProfileForm {
  /** Profile name. */
  name: string
  /** Endpoint URL. */
  endpoint: string
  /** Transport timeout (ms). */
  transportTimeoutMs: string
  /** Server deadline (ms, blank = server default). */
  queryTimeoutMs: string
  /** Auto-retries. */
  retries: string
  /** Comma-separated owners (blank = default system contracts). */
  owners: string
}

/** Form ↔ profile conversion (pure). */
export namespace ConnectionProfileForm {
  /** Owner list separator in the form. */
  export const OwnerSeparator = ","

  /**
   * An empty form (defaults shown).
   *
   * @returns The form.
   */
  export function empty(): ConnectionProfileForm {
    return {
      name: "",
      endpoint: "",
      transportTimeoutMs: String(ConnectionProfileDefaults.TransportTimeoutMs),
      queryTimeoutMs: "",
      retries: String(ConnectionProfileDefaults.Retries),
      owners: ""
    }
  }

  /**
   * The form of a saved profile.
   *
   * @param profile - The profile.
   * @returns The form.
   */
  export function of(profile: ConnectionProfile): ConnectionProfileForm {
    return {
      name: profile.name,
      endpoint: profile.endpoint,
      transportTimeoutMs: String(profile.transportTimeoutMs),
      queryTimeoutMs: profile.queryTimeoutMs == null ? "" : String(profile.queryTimeoutMs),
      retries: String(profile.retries),
      owners: (profile.owners ?? []).join(OwnerSeparator)
    }
  }

  /**
   * Validate the form into a profile (zod: name, http(s) URL, positive integers).
   *
   * @param form - The form.
   * @returns Right(profile), or Left(validation message).
   */
  export function toProfile(form: ConnectionProfileForm): Either<string, ConnectionProfile> {
    const owners = form.owners
        .split(OwnerSeparator)
        .map(owner => owner.trim())
        .filter(owner => owner.length > 0),
      input = {
        name: form.name.trim(),
        endpoint: form.endpoint.trim(),
        transportTimeoutMs: Number(form.transportTimeoutMs),
        ...(form.queryTimeoutMs.trim().length > 0 && { queryTimeoutMs: Number(form.queryTimeoutMs) }),
        retries: Number(form.retries),
        ...(owners.length > 0 && { owners })
      }
    return ConnectionProfileCodec.validate(input).mapLeft(SchemaCodec.formatIssues)
  }
}
