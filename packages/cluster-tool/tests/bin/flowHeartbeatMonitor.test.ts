import { execFileSync } from "node:child_process"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { pathToFileURL } from "node:url"

const MonitorScript = Path.resolve(
  __dirname,
  "../../../../scripts/flow-heartbeat-monitor.mjs"
)

/** Read the real monitor probe in a separate ESM process without starting its CLI. */
function probe(logFile: string, expectFreeze = false) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    const { probeAggregateLog } = await import(process.argv[1]);
    console.log(JSON.stringify(await probeAggregateLog(process.argv[2], process.argv[3] === "true")));
  `,
        pathToFileURL(MonitorScript).href,
        logFile,
        String(expectFreeze)
      ],
      { encoding: "utf8" }
    )
  )
}

describe("flow heartbeat expected refusals", () => {
  let directory: string, logFile: string
  beforeEach(() => {
    directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "heartbeat-probe-"))
    logFile = Path.join(directory, "cluster.log")
  })
  afterEach(() => Fs.rmSync(directory, { recursive: true, force: true }))

  it.each([
    "execution reverted: MockYieldEmitter: externalEpochRef not monotonic",
    "error underwriter: custom program error: 0x1795",
    "error underwriter: execution reverted: OPP_NotActiveOperator"
  ])("counts and quotes expected refusal as NOISE: %s", line => {
    Fs.writeFileSync(logFile, `${line}\n${line}\n`)
    const result = probe(logFile)
    expect(result.fatalCount).toBe(0)
    expect(result.fatalTail).toEqual([])
    expect(result.noiseCount).toBe(2)
    expect(result.noiseTail.length).toBeGreaterThan(0)
    expect(line).toContain(result.noiseTail)
  })

  it.each([
    "error outpost_solana_client: simulation failed: custom program error: 0x17c7",
    "Program liqsol failed: custom program error: 0x17c7",
    "error outpost_ethereum_client: execution reverted: EnforcedPause()",
    "EnforcedPause"
  ])("requires explicit freeze expectation for %s", line => {
    Fs.writeFileSync(logFile, `${line}\n${line}\n`)
    expect(probe(logFile)).toMatchObject({
      fatalCount: 2,
      fatalTail: [line, line],
      noiseCount: 0
    })
    const expected = probe(logFile, true)
    expect(expected).toMatchObject({
      fatalCount: 0,
      fatalTail: [],
      noiseCount: 2
    })
    expect(expected.noiseTail).not.toBe("")
    expect(line).toContain(expected.noiseTail)
  })

  it.each([
    "error outpost_solana_client: custom program error: 0x17c70",
    "Program liqsol failed: custom program error: 0x17c7F",
    "execution reverted: UnexpectedEnforcedPauseFailure()",
    "execution reverted: EnforcedPauseFailure()",
    "execution reverted: EnforcedPause_suffix()"
  ])("never exempts a near-match even with --expect-freeze: %s", line => {
    Fs.writeFileSync(logFile, line)
    expect(probe(logFile, true)).toMatchObject({
      fatalCount: 1,
      fatalTail: [line],
      noiseCount: 0
    })
  })

  it.each([
    "custom program error: 0x17c7; execution reverted: UnexpectedFailure()",
    "execution reverted: UnexpectedFailure(); EnforcedPause()",
    "error outpost_solana_client: custom program error: 0x17c7; panicked",
    "execution reverted: EnforcedPause(); custom program error: 0x17c70",
    "Program other failed: unknown; Program liqsol failed: custom program error: 0x17c7",
    "table read threw envelopes -- Parse Error (4); EnforcedPause()"
  ])("retains an unrelated failure on the same line: %s", line => {
    Fs.writeFileSync(logFile, line)
    expect(probe(logFile, true)).toMatchObject({
      fatalCount: 1,
      fatalTail: [line],
      noiseCount: 1
    })
  })

  it("retains unrelated FATAL signatures and their last two diagnostic lines", () => {
    const lines = [
      "error batch_operator: table read threw envelopes -- Parse Error (4)",
      "error outpost_solana_client: custom program error: 0x17c8",
      "error outpost_ethereum_client: execution reverted: UnexpectedFailure()"
    ]
    Fs.writeFileSync(logFile, lines.join("\n"))
    expect(probe(logFile)).toMatchObject({
      fatalCount: lines.length,
      fatalTail: lines.slice(-2),
      noiseCount: 0
    })
  })

  it("excludes echo wrappers while preserving action counts", () => {
    Fs.writeFileSync(
      logFile,
      [
        "TRX_TRACE execution reverted: EnforcedPause()",
        "log_trx_results custom program error: 0x17c7",
        "signaled NACK custom program error: 0x17c7",
        "sysio.synd::crank sysio.synd::crank"
      ].join("\n")
    )
    expect(probe(logFile)).toMatchObject({
      fatalCount: 0,
      noiseCount: 0,
      actionReceipts: ["sysio.synd::crank:2"]
    })
  })
})

const EpochStart = "2026-10-01T00:00:00.000"
const EpochStartMs = Date.UTC(2026, 9, 1)

interface HeartbeatFixture {
  epoch: number
  total: number
  elapsedMs: number
  currentStart?: string
  nextStart?: string
}

interface GrowthOptions {
  durationSeconds?: number
  configuredSeconds?: number
  expectEpochFreeze?: boolean
}

/** Execute the actual growth gate and retain its first chain-time deadline across beats. */
function growthResults(beats: HeartbeatFixture[], options: GrowthOptions = {}) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const { oppGrowthBailReason, firstEpochGrowthDeadlineMs } = await import(process.argv[1]);
      const options = JSON.parse(process.argv[3]);
      const duration = options.durationSeconds ?? 60;
      const configured = options.configuredSeconds ?? duration;
      let previousTotal = 0, deadline = null;
      const results = JSON.parse(process.argv[2]).map(beat => {
        deadline ??= firstEpochGrowthDeadlineMs({
          current_epoch_index: beat.epoch,
          current_epoch_start: beat.currentStart === undefined ? process.argv[4] : beat.currentStart,
          next_epoch_start: beat.nextStart
        }, duration, configured);
        const reason = oppGrowthBailReason(beat.epoch, beat.total - previousTotal, beat.total,
          Number(process.argv[5]) + beat.elapsedMs, deadline, options.expectEpochFreeze);
        previousTotal = beat.total;
        return { reason, deadline };
      });
      console.log(JSON.stringify(results));
    `,
        pathToFileURL(MonitorScript).href,
        JSON.stringify(beats),
        JSON.stringify(options),
        EpochStart,
        String(EpochStartMs)
      ],
      { encoding: "utf8" }
    )
  )
}

describe("first post-bootstrap artifact growth", () => {
  it("allows the boundary cycle just after epoch 1 starts, including zero artifacts", () => {
    const results = growthResults([
      { epoch: null, total: 0, elapsedMs: -1000 },
      { epoch: 0, total: 0, elapsedMs: 0 },
      { epoch: 1, total: 0, elapsedMs: 1000 },
      { epoch: 1, total: 0, elapsedMs: 59999 }
    ])
    expect(results.map(result => result.reason)).toEqual([
      null,
      null,
      null,
      null
    ])
    expect(results[2].deadline).toBe(EpochStartMs + 60000)
  })

  it.each([60000, 60001, 90000])(
    "bails on the first zero delta at/past the deadline: %sms",
    elapsedMs => {
      expect(
        growthResults([{ epoch: 1, total: 0, elapsedMs }])[0].reason
      ).toContain("zero growth")
    }
  )

  it("uses chain time, not first observation time, and never resets the deadline", () => {
    const results = growthResults([
      { epoch: 1, total: 2, elapsedMs: 30000 },
      {
        epoch: 2,
        total: 2,
        elapsedMs: 61000,
        currentStart: "2026-10-01T00:01:00.000"
      }
    ])
    expect(results[0].reason).toBeNull()
    expect(results[1].deadline).toBe(EpochStartMs + 60000)
    expect(results[1].reason).toContain("zero growth")
    expect(
      growthResults([{ epoch: 2, total: 0, elapsedMs: 61000 }])[0].reason
    ).toContain("zero growth")
  })

  it("honors the configured duration and an explicit duration override", () => {
    expect(
      growthResults([{ epoch: 1, total: 0, elapsedMs: 90000 }], {
        durationSeconds: 120
      })[0].reason
    ).toBeNull()
    expect(
      growthResults([{ epoch: 1, total: 0, elapsedMs: 30000 }], {
        configuredSeconds: 60,
        durationSeconds: 30
      })[0].reason
    ).toContain("zero growth")
  })

  it("recovers the start from next_epoch_start and applies the override to that start", () => {
    const result = growthResults(
      [
        {
          epoch: 1,
          total: 0,
          elapsedMs: 30000,
          currentStart: null,
          nextStart: "2026-10-01T00:01:00.000Z"
        }
      ],
      { configuredSeconds: 60, durationSeconds: 30 }
    )[0]
    expect(result.deadline).toBe(EpochStartMs + 30000)
    expect(result.reason).toContain("zero growth")
  })

  it("fails closed when epoch 1 has no usable timestamp", () => {
    expect(
      growthResults([
        {
          epoch: 1,
          total: 0,
          elapsedMs: 1000,
          currentStart: "invalid"
        }
      ])[0].reason
    ).toContain("zero growth")
  })

  it("allows growing artifacts and preserves the explicit epoch-freeze exception", () => {
    expect(
      growthResults([
        { epoch: 1, total: 2, elapsedMs: 60000 },
        { epoch: 2, total: 4, elapsedMs: 120000 }
      ]).map(result => result.reason)
    ).toEqual([null, null])
    expect(
      growthResults([{ epoch: 1, total: 0, elapsedMs: 90000 }], {
        expectEpochFreeze: true
      })[0].reason
    ).toBeNull()
  })

  it("documents the opt-in flag and epoch-boundary marker in CLI help", () => {
    const help = execFileSync(process.execPath, [MonitorScript, "--help"], {
      encoding: "utf8"
    })
    expect(help).toContain("--expect-freeze")
    expect(help).toContain("Default FATAL")
    expect(help).toContain("growth=first-epoch-boundary")
  })
})
