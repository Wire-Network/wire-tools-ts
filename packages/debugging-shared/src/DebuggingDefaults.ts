/**
 * Canonical defaults shared by the debugging server and its clients.
 *
 * Server namespace defaults (`DebuggingServer.DefaultPort`, etc.) and client
 * defaults (`DebuggingServerClient.DefaultURL`) both read from here — the
 * values MUST NOT be duplicated across the two packages. Changing a value
 * here changes both halves of the wire protocol in lockstep.
 */

export namespace DebuggingDefaults {
  /**
   * Localhost bind/target. Changing this moves the debugging service off
   * loopback — only do so when deliberately exposing it on a LAN.
   */
  export const Host = "127.0.0.1"

  /**
   * TCP port the server listens on and the client connects to. Changing
   * this requires restarting every client; there is no discovery.
   */
  export const Port = 9876

  /**
   * URL scheme for the HTTP transport. TLS is not currently wired up —
   * flipping to "https" requires provisioning a cert and routing through it.
   */
  export const Scheme = "http"

  /**
   * JSON-RPC 2.0 protocol version string. Clients and servers reject
   * requests whose `jsonrpc` field does not match exactly. Bumping this
   * breaks backwards compatibility with older peers.
   */
  export const JsonrpcVersion = "2.0"

  /**
   * Express JSON body parser limit. Envelopes containing large protobuf
   * blobs brush against this — raise it if legitimate payloads start
   * getting rejected with 413.
   */
  export const BodyLimit = "10mb"

  /**
   * Subpath segments appended to `$HOME` to resolve the default OPP
   * storage root. Exported so the TUI and other tools can locate data
   * written by a server whose `--opp-storage-path` wasn't overridden.
   */
  export namespace StorageSubpath {
    export const ConfigDir = ".config"
    export const OppData = "wire/debugging/opp/data"
  }

  /** Fully resolved `<scheme>://<host>:<port>` for the default deployment. */
  export const URL = `${Scheme}://${Host}:${Port}`
}
