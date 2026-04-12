import * as Fs from "node:fs"
import Assert from "node:assert"
import { AddressInfo } from "node:net"
import { Server } from "node:http"

import express, { Express } from "express"
import { defaults } from "lodash"

import { ApiPaths } from "@wire-e2e-tests/debugging-shared"

import { mountJsonRPC } from "./JsonRPC"
import type { HandlerRegistry } from "./JsonRPC"

import OPPRoutes from "./routes/opp/OPPRoutes"
import * as Path from "node:path"
import { Future } from "@3fv/prelude-ts"

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
    this.app.use(express.json({ limit: "10mb" }))

    // Health check
    this.app.get(ApiPaths.Ping, (_req, res) => {
      res.status(200).json({ status: "ok" })
    })

    // OPP handlers — mounted under /api/opp, auto-detects JSON-RPC 2.0 vs plain JSON
    const registry: HandlerRegistry = new Map()
    OPPRoutes.register(registry, config.oppStoragePath)
    mountJsonRPC(this.app, ApiPaths.OPP.Base, registry)

    // JSON error handler — prevents Express from returning HTML error pages
    this.app.use(
      (
        err: any,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
      ) => {
        const status = err.status || 500
        res.status(status).json({
          error: err.message || "Internal Server Error"
        })
      }
    )
  }

  async start(): Promise<AddressInfo> {
    return new Promise(resolve => {
      this.server = this.app.listen(this.config.port, this.config.host, () => {
        const addr = this.server!.address() as AddressInfo
        resolve(addr)
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve()
      this.server.close(err => {
        if (err) return reject(err)
        this.server = null
        resolve()
      })
    })
  }
}

export namespace DebuggingServer {
  export const DefaultPort = 9876
  export const DefaultHost = "127.0.0.1"
  export const DefaultOPPStoragePath = Path.resolve(
    process.env.HOME,
    ".config",
    "wire",
    "debugging",
    "opp",
    "data"
  )
}
