import * as Fs from "node:fs"
import Assert from "node:assert"
import { AddressInfo } from "node:net"
import { Server } from "node:http"

import express, { Express } from "express"

import {
  ApiPaths,
  DebuggingDefaults,
  oppDebuggingPath
} from "@wireio/debugging-shared"

import { JsonRPC } from "./JsonRPC.js"

import { OPPRoutes } from "./routes/opp/OPPRoutes.js"
import { ClusterRoutes } from "./routes/cluster/ClusterRoutes.js"
import { ProcessRoutes } from "./routes/processes/ProcessRoutes.js"
import { LogRoutes } from "./routes/logs/LogRoutes.js"
import { ClusterAccess } from "./services/ClusterAccess.js"
import { StreamServer } from "./streams/StreamServer.js"
import { Future } from "@3fv/prelude-ts"
import { Deferred } from "@wireio/shared"

/**
 * Caller-facing options for {@link DebuggingServer.create}.
 *
 * `clusterPath` is the single source of truth — every path the server
 * touches (OPP envelope storage, log files, pid files, cluster config)
 * is derived from it. There is no separate `oppStoragePath` option to
 * keep paths from drifting out of sync with the harness layout.
 */
export interface DebuggingServerOptions {
  /** Server port. Default: {@link DebuggingServer.DefaultPort}. */
  port?: number
  /** Server bind address. Default: {@link DebuggingServer.DefaultHost}. */
  host?: string
  /**
   * Cluster directory. **Required.** OPP envelope storage resolves to
   * `<clusterPath>/data/opp-debugging`; cluster config / state / logs
   * are read from this root.
   */
  clusterPath: string
}

/** Fully-resolved runtime config for {@link DebuggingServer}. */
export interface DebuggingServerConfig {
  /** Bound port. */
  port: number
  /** Bound host. */
  host: string
  /** Cluster directory; the only path the server reads / writes under. */
  clusterPath: string
  /** Derived: `<clusterPath>/data/opp-debugging`. */
  oppStoragePath: string
}

export class DebuggingServer {
  readonly app: Express
  private server: Server | null = null
  private readonly clusterAccess: ClusterAccess
  private readonly streamServer: StreamServer

  /**
   * Validate paths and return a ready-to-use server. The cluster path
   * must exist; the OPP debugging directory is created if missing.
   */
  static async create(
    options: DebuggingServerOptions
  ): Promise<DebuggingServer> {
    Assert.ok(
      options.clusterPath,
      "DebuggingServerOptions.clusterPath is required"
    )
    Assert.ok(
      Fs.existsSync(options.clusterPath),
      `clusterPath does not exist: ${options.clusterPath}`
    )

    const config: DebuggingServerConfig = {
      port: options.port ?? DebuggingServer.DefaultPort,
      host: options.host ?? DebuggingServer.DefaultHost,
      clusterPath: options.clusterPath,
      oppStoragePath: oppDebuggingPath(options.clusterPath)
    }

    await Fs.promises.mkdir(config.oppStoragePath, { recursive: true })
    Assert.ok(
      await Future.of(Fs.promises.lstat(config.oppStoragePath))
        .map(stats => stats.isDirectory())
        .toPromise(),
      `oppStoragePath should be a directory: ${config.oppStoragePath}`
    )

    return new DebuggingServer(config)
  }

  private constructor(readonly config: DebuggingServerConfig) {
    this.app = express()
    this.app.use(express.json({ limit: DebuggingDefaults.BodyLimit }))

    // Health check
    this.app.get(ApiPaths.Ping, this.handlePing.bind(this))

    // OPP handlers — protobuf-encoded bodies
    const oppRegistry = OPPRoutes.register(new Map(), config.oppStoragePath)
    JsonRPC.mount(this.app, ApiPaths.OPP.Endpoint, oppRegistry)

    // Cluster-aware features
    this.clusterAccess = new ClusterAccess(config.clusterPath)
    this.clusterAccess.start()

    const clusterRegistry = ClusterRoutes.register(new Map(), this.clusterAccess)
    JsonRPC.mount(this.app, ApiPaths.Cluster.Endpoint, clusterRegistry)

    const processRegistry = ProcessRoutes.register(
      new Map(),
      this.clusterAccess
    )
    JsonRPC.mount(this.app, ApiPaths.Processes.Endpoint, processRegistry)

    const logRegistry = LogRoutes.register(new Map(), config.clusterPath)
    JsonRPC.mount(this.app, ApiPaths.Logs.Endpoint, logRegistry)

    this.streamServer = new StreamServer(
      this.clusterAccess,
      config.clusterPath
    )

    // JSON error handler — prevents Express from returning HTML error pages
    this.app.use(this.handleError.bind(this))
  }

  async start(): Promise<AddressInfo> {
    const addr = await Deferred.useCallback<AddressInfo>(d => {
      const server = (this.server = this.app.listen(
        this.config.port,
        this.config.host,
        err => {
          if (err) return d.reject(err)

          d.resolve(server.address() as AddressInfo)
        }
      ))
    }).promise
    this.streamServer.attach(this.server!)
    return addr
  }

  /**
   * Stop the server and any cluster-watching state. Idempotent.
   */
  async stop(): Promise<void> {
    this.clusterAccess.stop()
    await this.streamServer.detach()
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
}
