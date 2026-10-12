import Assert from "node:assert/strict"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { runStage } from "../check.mjs"

const options = { stdio: "ignore", timeoutMs: 10_000 }

test("accepts a successful child", async () => {
  await runStage(process.execPath, ["-e", "process.exit(0)"], options)
})

test("propagates a failing test process", async () => {
  await Assert.rejects(
    runStage(process.execPath, ["-e", "process.exit(7)"], options),
    /failed \(7\)/
  )
})

test("reports a missing executable", async () => {
  await Assert.rejects(
    runStage("/wire-missing-check-command", [], options),
    /could not start/
  )
})

test("deadline terminates a child whose event loop cannot service timers", async () => {
  await Assert.rejects(
    runStage(process.execPath, ["-e", "while (true) {}"], {
      ...options,
      timeoutMs: 200,
      killGraceMs: 100
    }),
    /deadline exceeded/
  )
})

test("escalates when a child ignores TERM", async () => {
  await Assert.rejects(
    runStage(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      {
        ...options,
        timeoutMs: 500,
        killGraceMs: 100
      }
    ),
    /deadline exceeded/
  )
})

test("interrupts terminate the active stage and fail the gate", async () => {
  const interrupt = setTimeout(() => process.emit("SIGTERM"), 100)
  try {
    await Assert.rejects(
      runStage(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        ...options,
        killGraceMs: 100
      }),
      /interrupted/
    )
  } finally {
    clearTimeout(interrupt)
  }
})

test(
  "deadline kills a TERM-resistant descendant after its parent exits",
  {
    skip: process.platform === "win32"
  },
  async () => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "wire-check-tree-"))
    const pidFile = Path.join(directory, "child.pid")
    const descendant =
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    const program = `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    setInterval(() => {}, 1000);
  `
    let pid
    try {
      await Assert.rejects(
        runStage(process.execPath, ["-e", program], {
          ...options,
          timeoutMs: 1000,
          killGraceMs: 100
        }),
        /deadline exceeded/
      )
      pid = Number(Fs.readFileSync(pidFile, "utf8"))
      await delay(250)
      // Linux may retain a killed orphan as a zombie until its reaper runs.
      let alive = true
      try {
        process.kill(pid, 0)
        if (process.platform === "linux") {
          const state = Fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(
            ") "
          )[1][0]
          alive = state !== "Z"
        }
      } catch (error) {
        if (error.code !== "ESRCH" && error.code !== "ENOENT") throw error
        alive = false
      }
      Assert.equal(
        alive,
        false,
        "the timed-out gate must not leave a test worker running"
      )
    } finally {
      if (pid != null) {
        try {
          process.kill(pid, "SIGKILL")
        } catch (error) {
          if (error.code !== "ESRCH") throw error
        }
      }
      Fs.rmSync(directory, { recursive: true, force: true })
    }
  }
)
