import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"
import { MaximumPort, MinimumPort } from "./BindConfig.js"

/** Document metadata of the bind-registry registration schema. */
export namespace BindRegistrationDocument {
  /** JSON Schema title of the document. */
  export const Title = "Bind registry registration"

  /** JSON Schema description of the document. */
  export const Description =
    "One process's registration in the wire-tools-ts cross-process bind registry: " +
    "<registry>/<pid>.bind-config.json, written atomically under the registry lock. " +
    "Protocol: docs/bind-registry/README.md."
}

/**
 * One process's registration in the cross-process bind registry — the content of
 * `<registry>/<pid>.bind-config.json`. The protocol (lock, file naming, atomic write,
 * owner liveness, reserved band) is documented in `docs/bind-registry/README.md`; this
 * schema is the single source of the file's JSON shape, rendered to
 * `docs/bind-registry/bind-registration.schema.json`.
 *
 * Every writer — `BindConfigProvider` in `cluster-tool` and non-Node clients such as
 * wire-sysio's Python test-port lease — writes this one shape, so a reader needs no
 * knowledge of the writer's own configuration format.
 */
export const BindRegistrationSchema = z
  .object({
    /**
     * Basename of the owner process's executable as a reader observes it: the first
     * NUL-separated token of `/proc/<pid>/cmdline`, reduced to its basename (`node`,
     * `python3`). A reader that finds the file's pid alive but running a different,
     * non-empty executable treats the pid as recycled and deletes the file. Empty when the writer
     * cannot read its own `/proc` entry; readers then skip the comparison and rely on
     * pid liveness alone.
     */
    executable: z
      .string()
      .describe(
        "Basename of the owner's argv[0] as /proc/<pid>/cmdline reports it; empty when unknown. " +
          "A reader deletes a live pid's file only when this and the pid's current basename are " +
          "both non-empty and differ (the pid was recycled)."
      ),
    /**
     * Every port the owner has claimed and not yet released, each listed once. Each one
     * is excluded by every registry reader until the owner exits.
     */
    ports: z
      .array(z.number().int().min(MinimumPort).max(MaximumPort))
      .refine(ports => new Set(ports).size === ports.length, {
        message: "ports must be unique"
      })
      // The refinement has no JSON Schema form; this states it for the generated document.
      .meta({
        uniqueItems: true,
        description:
          "Every port the owner holds and has not released, each once. Every registry reader " +
          "excludes them until the owner exits."
      })
  })
  .meta({ title: BindRegistrationDocument.Title, description: BindRegistrationDocument.Description })

/** One process's bind-registry registration — the shape of {@link BindRegistrationSchema}. */
export type BindRegistration = z.infer<typeof BindRegistrationSchema>

/** Validated codec for a bind-registry registration file. */
export const BindRegistrationSchemaCodec =
  SchemaCodec.create<BindRegistration>(BindRegistrationSchema)
