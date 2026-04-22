import * as Fs from "node:fs"
import Assert from "node:assert"
import { AddressInfo } from "node:net"
import { Server } from "node:http"

import express, { Express } from "express"
import { defaults } from "lodash"

import { ApiPaths, DebuggingDefaults } from "@wire-e2e-tests/debugging-shared"

import { JsonRPC } from "./JsonRPC.js"

import { OPPRoutes } from "./routes/opp/OPPRoutes.js"
import * as Path from "node:path"
import { Future } from "@3fv/prelude-ts"
import { Deferred } from "@wireio/shared"

export interface DebuggingServerOptions {
  /** Server port. Default: DebuggingServer.DefaultPort */
  port?: number
  /** Server bind address. Default: DebuggingServer.DefaultHost */
  host?: string
  /** Storage directory for OPP debugging data */
  oppStoragePath?: string
}

export interface DebuggingServerConfig extends Required<DebuggingServerOptions> {}

export async function createDebuggingServerDefaultOptions(): Promise<
  Partial<DebuggingServerOptions>
> {
  return {
    port: DebuggingServer.DefaultPort,
    host: DebuggingServer.DefaultHost,
    oppStoragePath: DebuggingServer.DefaultOPPStoragePath
  }
}

export class DebuggingServer {
  readonly app: Express
  private server: Server | null = null

  static async create(
    options: DebuggingServerOptions = {}
  ): Promise<DebuggingServer> {
    const config = defaults(
      { ...options },
      await createDebuggingServerDefaultOptions()
    ) as DebuggingServerConfig

    Assert.ok(config.oppStoragePath, "opp-storage-path is required")
    await Fs.promises.mkdir(config.oppStoragePath, { recursive: true })
    Assert.ok(
      await Future.of(Fs.promises.lstat(config.oppStoragePath))
        .map(stats => stats.isDirectory())
        .toPromise(),
      `opp-storage-path should exist: ${config.oppStoragePath}`
    )
    return new DebuggingServer(config)
  }

  private constructor(readonly config: DebuggingServerConfig) {
    this.app = express()
    this.app.use(express.json({ limit: DebuggingDefaults.BodyLimit }))

    // Health check
    this.app.get(ApiPaths.Ping, this.handlePing.bind(this))

    // OPP handlers — mounted under /api/opp, auto-detects JSON-RPC 2.0 vs plain JSON
    const registry = OPPRoutes.register(new Map(), config.oppStoragePath)

    JsonRPC.mount(this.app, ApiPaths.OPP.Endpoint, registry)

    // JSON error handler — prevents Express from returning HTML error pages
    this.app.use(this.handleError.bind(this))
  }

  async start(): Promise<AddressInfo> {
    return Deferred.useCallback<AddressInfo>(d => {
      const server = (this.server = this.app.listen(
        this.config.port,
        this.config.host,
        err => {
          if (err) return d.reject(err)

          d.resolve(server.address() as AddressInfo)
        }
      ))
    }).promise
  }

  /**
   * Stops the server and resolves when the server is stopped.
   */
  async stop(): Promise<void> {
    return Deferred.useCallback<void>(d => {
      if (!this.server) return d.resolve()
      this.server.close(err => {
        if (err) return d.reject(err)
        this.server = null
        d.resolve()
      })
    }).promise
  }

  protected handlePing(_req: express.Request, res: express.Response) {
    res.status(200).json({ status: "ok" })
  }

  protected handleError(
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) {
    const status = err.status || 500
    res.status(status).json({
      error: err.message ?? "Unknown error",
      stack: err?.stack ?? "Stack not available"
    })
  }
}

export namespace DebuggingServer {
  /** Network defaults re-surfaced from {@link DebuggingDefaults} for factory ergonomics. */
  export const DefaultPort = DebuggingDefaults.Port
  export const DefaultHost = DebuggingDefaults.Host

  /**
   * Default root for persisted OPP envelope data. Resolved from the user's
   * `$HOME` plus the shared storage subpath — overriding via
   * `oppStoragePath` bypasses this entirely.
   */
  export const DefaultOPPStoragePath = Path.resolve(
    process.env.HOME,
    DebuggingDefaults.StorageSubpath.ConfigDir,
    DebuggingDefaults.StorageSubpath.OppData
  )
}
