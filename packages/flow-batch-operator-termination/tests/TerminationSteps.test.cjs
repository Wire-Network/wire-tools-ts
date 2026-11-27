const Assert = require("node:assert/strict")
const { test, describe, afterEach, mock } = require("node:test")

const {
  AttestationType,
  BatchOperatorGroups,
  Envelope,
  OperatorType
} = require("@wireio/opp-typescript-models")
const { SlugName, SysioContracts } = require("@wireio/sdk-core")
const { OutpostChainCodename } = require("@wireio/cluster-tool-shared")
const { Constants: HarnessConstants, ProtocolTiming, Steps, WireCollateralTool } = require("@wireio/cluster-tool")

const { TerminationSteps } = require("../lib/steps/TerminationSteps.js")
const {
  TerminationScenarioConstants: Constants
} = require("../lib/TerminationScenarioConstants.js")

const {
    SysioOpregActiontype: ActionType,
    SysioOpregChainServiceStatus: ServiceStatus,
    SysioOpregOperatorstatus: OperatorStatus
  } = SysioContracts,
  signal = new AbortController().signal,
  Doomed = Constants.DoomedOperatorLabel

afterEach(() => mock.restoreAll())

/** A build context resolving every label to `account`. */
function context(extra = {}, account = Doomed) {
  return { keyStore: { assertOperator: () => ({ account }) }, ...extra }
}

/** An `operators` row. */
function operator(status, fields = {}) {
  return {
    account: Doomed,
    status,
    is_bootstrapped: false,
    terminated_at: 0,
    status_reason: "",
    recent_actions: [],
    ...fields
  }
}

/** A `servchains` row of the doomed operator. */
function membership(chain, status, fields = {}) {
  return {
    account: Doomed,
    chain_code: chain,
    status,
    joined_at_ms: "100",
    updated_at_ms: "100",
    status_reason: "",
    ...fields
  }
}

/** A `recent_actions` entry: a `WITHDRAW_REMIT` (or `type`) on the packed `chainCode`. */
function action(chainCode, success = 1, type = "ACTION_TYPE_WITHDRAW_REMIT") {
  return { action: { action_type: type, chain_code: String(chainCode) }, success }
}

/** An `epochstate` row of `chain` at `index` with `groupCount` groups. */
function epochState(chain, index, groupCount) {
  return {
    chain_code: String(SlugName.from(chain)),
    current_epoch_index: index,
    batch_op_groups: Array.from({ length: groupCount }, (_, slot) => [`batchop.${slot}`])
  }
}

/** An outbound envelope row of `chain` publishing `windows` (each a list of groups of accounts). */
function outbound(chain, windows, epochIndex = 9) {
  const attestations = windows.map(groups => ({
    type: AttestationType.BATCH_OPERATOR_GROUPS,
    data: BatchOperatorGroups.toBinary(
      BatchOperatorGroups.create({
        groups: groups.map(members => ({ operators: members.map(account => ({ address: Buffer.from(account) })) }))
      })
    )
  }))
  return {
    id: 1,
    chain_code: String(SlugName.from(chain)),
    epoch_index: epochIndex,
    raw_envelope: Buffer.from(Envelope.toBinary(Envelope.create({ messages: [{ payload: { attestations } }] }))).toString("hex")
  }
}

describe("reads", () => {
  test("the doomed operator's account is resolved from the key store by its label", () => {
    const assertOperator = mock.fn(() => ({ account: "newop.acct" }))
    Assert.equal(TerminationSteps.doomedOperatorAccount({ keyStore: { assertOperator } }), "newop.acct")
    Assert.deepEqual(assertOperator.mock.calls[0].arguments, [Doomed])
  })

  test("an operator missing from the key store fails", () => {
    Assert.throws(
      () =>
        TerminationSteps.doomedOperatorAccount({
          keyStore: {
            assertOperator: label => {
              throw new Error(`no operator ${label}`)
            }
          }
        }),
      /no operator newop/
    )
  })

  test("a membership read asks for the doomed operator's account on the named chain", async () => {
    const row = membership(Constants.MissedChain, "SERVING"),
      read = mock.method(Steps.contracts.sysio.opreg, "readMembership", async () => row)
    Assert.equal(await TerminationSteps.readDoomedMembership(context(), Constants.MissedChain), row)
    Assert.deepEqual(read.mock.calls[0].arguments.slice(1), [Doomed, Constants.MissedChain])
  })

  test("a membership the operator never joined reads as absent", async () => {
    mock.method(Steps.contracts.sysio.opreg, "readMembership", async () => undefined)
    Assert.equal(await TerminationSteps.readDoomedMembership(context(), Constants.UnservedChain), undefined)
  })

  test("the operator row is read by label, and its absence fails", async () => {
    const row = operator("OPERATOR_STATUS_ACTIVE")
    mock.method(WireCollateralTool, "readOperatorRow", async (_ctx, label) => (label === Doomed ? row : undefined))
    Assert.equal(await TerminationSteps.readDoomedOperator(context()), row)
    mock.restoreAll()
    mock.method(WireCollateralTool, "readOperatorRow", async () => undefined)
    await Assert.rejects(TerminationSteps.readDoomedOperator(context()), /newop missing from sysio.opreg::operators/)
  })
})

describe("WITHDRAW_REMIT audit", () => {
  test("only successful WITHDRAW_REMIT entries count, by their chain code", () => {
    const codes = TerminationSteps.withdrawRemitChainCodes(
      operator("OPERATOR_STATUS_TERMINATED", {
        recent_actions: [
          action(HarnessConstants.WireChainCode),
          action(SlugName.from(OutpostChainCodename.SOLANA), 0),
          action(SlugName.from(OutpostChainCodename.ETHEREUM), 1, ActionType.ACTION_TYPE_WITHDRAW_REMIT),
          action(SlugName.from(OutpostChainCodename.SOLANA), true, "ACTION_TYPE_DEPOSIT")
        ]
      })
    )
    Assert.deepEqual([...codes].sort(), [HarnessConstants.WireChainCode, SlugName.from(OutpostChainCodename.ETHEREUM)].sort())
  })

  test("an operator without a row or actions has no remits", () => {
    Assert.equal(TerminationSteps.withdrawRemitChainCodes(undefined).size, 0)
    Assert.equal(TerminationSteps.withdrawRemitChainCodes(operator("OPERATOR_STATUS_ACTIVE")).size, 0)
  })

  test("a remit on a chain code that is not a packed code fails", () => {
    Assert.throws(() =>
      TerminationSteps.withdrawRemitChainCodes(
        operator("OPERATOR_STATUS_TERMINATED", { recent_actions: [action("WIRE")] })
      )
    )
  })
})

describe("registration", () => {
  test("a non-bootstrapped UNKNOWN row passes, by name or by value", () => {
    TerminationSteps.assertRegisteredUnbootstrapped(operator("OPERATOR_STATUS_UNKNOWN"))
    TerminationSteps.assertRegisteredUnbootstrapped(operator(OperatorStatus.OPERATOR_STATUS_UNKNOWN))
  })

  test("a missing, bootstrapped or already-active row fails", () => {
    Assert.throws(() => TerminationSteps.assertRegisteredUnbootstrapped(undefined), /missing from sysio.opreg::operators/)
    Assert.throws(
      () => TerminationSteps.assertRegisteredUnbootstrapped(operator("OPERATOR_STATUS_UNKNOWN", { is_bootstrapped: true })),
      /registered bootstrapped/
    )
    Assert.throws(
      () => TerminationSteps.assertRegisteredUnbootstrapped(operator("OPERATOR_STATUS_ACTIVE")),
      /status not UNKNOWN \(got OPERATOR_STATUS_ACTIVE\)/
    )
  })

  test("serving the missed chain alone passes", () => {
    TerminationSteps.assertServesMissedChainOnly(membership(Constants.MissedChain, ServiceStatus.SERVING), undefined)
  })

  test("not serving the missed chain, or a membership of the other chain, fails", () => {
    Assert.throws(
      () => TerminationSteps.assertServesMissedChainOnly(undefined, undefined),
      /does not SERVE ETHEREUM \(got undefined\)/
    )
    Assert.throws(
      () => TerminationSteps.assertServesMissedChainOnly(membership(Constants.MissedChain, "LEFT"), undefined),
      /does not SERVE ETHEREUM \(got LEFT\)/
    )
    Assert.throws(
      () =>
        TerminationSteps.assertServesMissedChainOnly(
          membership(Constants.MissedChain, "SERVING"),
          membership(Constants.UnservedChain, "SERVING")
        ),
      /has a SOLANA membership it never joined/
    )
  })
})

describe("eviction", () => {
  const evicted = membership(Constants.MissedChain, "EVICTED", { status_reason: "missed 2 epochs", updated_at_ms: "200" })

  test("isEvicted holds only for an EVICTED row", () => {
    Assert.ok(TerminationSteps.isEvicted(evicted))
    Assert.ok(TerminationSteps.isEvicted({ ...evicted, status: ServiceStatus.EVICTED }))
    Assert.ok(!TerminationSteps.isEvicted(membership(Constants.MissedChain, "SERVING")))
    Assert.ok(!TerminationSteps.isEvicted(undefined))
  })

  test("an EVICTED row with its reason, stamped after the join, passes", () => {
    TerminationSteps.assertEvictionRecorded(evicted, undefined)
  })

  test("a row still serving, without a reason, stamped before the join, or another chain joined fails", () => {
    Assert.throws(
      () => TerminationSteps.assertEvictionRecorded(membership(Constants.MissedChain, "SERVING"), undefined),
      /ETHEREUM membership is not EVICTED \(got SERVING\)/
    )
    Assert.throws(
      () => TerminationSteps.assertEvictionRecorded({ ...evicted, status_reason: "" }, undefined),
      /status_reason is not populated/
    )
    Assert.throws(
      () => TerminationSteps.assertEvictionRecorded({ ...evicted, updated_at_ms: "50" }, undefined),
      /stamped before the join/
    )
    Assert.throws(
      () => TerminationSteps.assertEvictionRecorded(evicted, membership(Constants.UnservedChain, "SERVING")),
      /has a SOLANA membership it never joined/
    )
  })

  test("an evicted operator still ACTIVE, unterminated and unremitted passes", () => {
    TerminationSteps.assertEvictedOperatorStaysActive(operator("OPERATOR_STATUS_ACTIVE"), new Set())
  })

  test("an evicted operator no longer ACTIVE, terminated or remitted fails", () => {
    Assert.throws(
      () => TerminationSteps.assertEvictedOperatorStaysActive(operator("OPERATOR_STATUS_TERMINATED"), new Set()),
      /status is OPERATOR_STATUS_TERMINATED, not OPERATOR_STATUS_ACTIVE/
    )
    Assert.throws(
      () =>
        TerminationSteps.assertEvictedOperatorStaysActive(operator("OPERATOR_STATUS_ACTIVE", { terminated_at: 5 }), new Set()),
      /must not terminate the operator/
    )
    Assert.throws(
      () =>
        TerminationSteps.assertEvictedOperatorStaysActive(
          operator("OPERATOR_STATUS_ACTIVE"),
          new Set([HarnessConstants.WireChainCode])
        ),
      /must not remit newop's collateral/
    )
  })
})

describe("termination", () => {
  const terminated = operator("OPERATOR_STATUS_TERMINATED", {
    terminated_at: 7,
    status_reason: Constants.GovernanceTerminationReason
  })

  test("a TERMINATED row stamped with the governance reason passes", () => {
    TerminationSteps.assertTerminationRecorded(terminated)
  })

  test("a row not TERMINATED, unstamped, or with another reason fails", () => {
    Assert.throws(
      () => TerminationSteps.assertTerminationRecorded({ ...terminated, status: "OPERATOR_STATUS_ACTIVE" }),
      /not OPERATOR_STATUS_TERMINATED/
    )
    Assert.throws(
      () => TerminationSteps.assertTerminationRecorded({ ...terminated, terminated_at: 0 }),
      /terminated_at not populated/
    )
    Assert.throws(
      () => TerminationSteps.assertTerminationRecorded({ ...terminated, status_reason: "missed" }),
      /does not carry the governance termination reason/
    )
  })

  test("the termination step names the operator by label and resolves its account at run time", async () => {
    const step = TerminationSteps.planTermination(
        "Sysio",
        "terminate",
        "probe",
        {},
        Doomed,
        Constants.GovernanceTerminationReason
      ),
      push = mock.method(Steps.contracts.sysio.opreg, "runTerminate", async () => undefined)
    Assert.deepEqual(step.input, {
      kind: "TerminationSteps.TerminationInput",
      label: Doomed,
      reason: Constants.GovernanceTerminationReason
    })
    Assert.equal(step.runner, TerminationSteps.runTermination)
    await TerminationSteps.runTermination(context({}, "newop.acct"), step.input, signal)
    Assert.deepEqual(push.mock.calls[0].arguments[1], {
      kind: "OpregContractSteps.TerminateInput",
      data: { account: "newop.acct", reason: Constants.GovernanceTerminationReason }
    })
  })

  test("terminating an operator missing from the key store pushes nothing", async () => {
    const push = mock.method(Steps.contracts.sysio.opreg, "runTerminate", async () => undefined)
    await Assert.rejects(
      TerminationSteps.runTermination(
        {
          keyStore: {
            assertOperator: label => {
              throw new Error(`no operator ${label}`)
            }
          }
        },
        { kind: "TerminationSteps.TerminationInput", label: Doomed, reason: "r" },
        signal
      ),
      /no operator newop/
    )
    Assert.equal(push.mock.callCount(), 0)
  })
})

describe("post-eviction rotation", () => {
  const cursors = { [OutpostChainCodename.ETHEREUM]: 3, [OutpostChainCodename.SOLANA]: 40 }

  test("each chain's target is a full window of its OWN group count past its own start", () => {
    const targets = TerminationSteps.rotationTargets(
      {
        [OutpostChainCodename.ETHEREUM]: epochState(OutpostChainCodename.ETHEREUM, 10, 3),
        [OutpostChainCodename.SOLANA]: epochState(OutpostChainCodename.SOLANA, 20, 5)
      },
      cursors
    )
    Assert.deepEqual(targets, {
      [OutpostChainCodename.ETHEREUM]: { groupCount: 3, targetEpoch: 13 },
      [OutpostChainCodename.SOLANA]: { groupCount: 5, targetEpoch: 45 }
    })
  })

  test("a chain without an epochstate row fails with an assertion, not a TypeError", () => {
    Assert.throws(
      () =>
        TerminationSteps.rotationTargets(
          { [OutpostChainCodename.ETHEREUM]: epochState(OutpostChainCodename.ETHEREUM, 10, 3) },
          cursors
        ),
      /epochstate has no SOLANA row/
    )
  })

  test("a chain whose window holds a single group fails", () => {
    Assert.throws(
      () =>
        TerminationSteps.rotationTargets(
          {
            [OutpostChainCodename.ETHEREUM]: epochState(OutpostChainCodename.ETHEREUM, 10, 3),
            [OutpostChainCodename.SOLANA]: epochState(OutpostChainCodename.SOLANA, 20, 1)
          },
          cursors
        ),
      /the SOLANA window has 1 group\(s\)/
    )
  })

  test("the deadline is the slowest chain's full rotation plus the final envelope's epoch", () => {
    const config = {
        outpostEpochDurationSec: { [OutpostChainCodename.ETHEREUM]: 60, [OutpostChainCodename.SOLANA]: 150 }
      },
      deadline = TerminationSteps.rotationDeadlineMs(config, {
        [OutpostChainCodename.ETHEREUM]: 5,
        [OutpostChainCodename.SOLANA]: 2
      })
    Assert.equal(deadline, ProtocolTiming.effectiveEpochsMs(60, 5 + Constants.RotationFinalEnvelopeEpochs))
    Assert.equal(
      TerminationSteps.rotationDeadlineMs(config, { [OutpostChainCodename.ETHEREUM]: 2, [OutpostChainCodename.SOLANA]: 2 }),
      ProtocolTiming.effectiveEpochsMs(150, 2 + Constants.RotationFinalEnvelopeEpochs)
    )
  })

  test("the standing operators are every batch operator but the evicted one", () => {
    const standing = TerminationSteps.standingOperators(
      [
        { account: "batchop.a", type: OperatorType.BATCH },
        { account: Doomed, type: OperatorType.BATCH },
        { account: "producer", type: OperatorType.PRODUCER }
      ],
      Doomed
    )
    Assert.deepEqual([...standing], ["batchop.a"])
  })

  test("a chain's published windows are decoded from its own outbound envelope", () => {
    const windows = TerminationSteps.publishedWindows(
      [
        outbound(OutpostChainCodename.ETHEREUM, [[["a"], ["b"]]]),
        outbound(OutpostChainCodename.SOLANA, [[["c"], ["d"], ["e"]], [["f"], ["g"], ["h"]]])
      ],
      OutpostChainCodename.SOLANA
    )
    Assert.deepEqual(windows, [[["c"], ["d"], ["e"]], [["f"], ["g"], ["h"]]])
  })

  test("a chain without an outbound envelope, or one publishing no window, fails", () => {
    Assert.throws(
      () => TerminationSteps.publishedWindows([outbound(OutpostChainCodename.ETHEREUM, [[["a"]]])], OutpostChainCodename.SOLANA),
      /missing outbound envelope for chain SOLANA/
    )
    Assert.throws(
      () => TerminationSteps.publishedWindows([outbound(OutpostChainCodename.SOLANA, [])], OutpostChainCodename.SOLANA),
      /no published SOLANA group window at epoch 9/
    )
  })

  describe("published groups", () => {
    const standing = new Set(["a", "b", "c", "d", "e", "f"]),
      window = [["a", "b"], ["c", "d"], ["e", "f"]]

    test("a full window of standing operators without the evicted one passes", () => {
      TerminationSteps.assertPublishedGroups(OutpostChainCodename.ETHEREUM, window, 3, 2, Doomed, standing)
    })

    test("each chain is held to its own window: a chain with fewer groups is not judged by another's count", () => {
      const twoGroups = window.slice(0, 2)
      TerminationSteps.assertPublishedGroups(OutpostChainCodename.SOLANA, twoGroups, 2, 2, Doomed, standing)
      Assert.throws(
        () => TerminationSteps.assertPublishedGroups(OutpostChainCodename.SOLANA, twoGroups, 3, 2, Doomed, standing),
        /the published SOLANA window lost a group/
      )
    })

    test("an unfilled seat, the evicted operator, a repeat or a stranger fails", () => {
      Assert.throws(
        () => TerminationSteps.assertPublishedGroups(OutpostChainCodename.ETHEREUM, [["a"], ["c", "d"], ["e", "f"]], 3, 2, Doomed, standing),
        /did not fill every ETHEREUM seat/
      )
      Assert.throws(
        () =>
          TerminationSteps.assertPublishedGroups(OutpostChainCodename.ETHEREUM, [["a", Doomed], ["c", "d"], ["e", "f"]], 3, 2, Doomed, standing),
        /the evicted operator re-entered a published ETHEREUM group/
      )
      Assert.throws(
        () => TerminationSteps.assertPublishedGroups(OutpostChainCodename.ETHEREUM, [["a", "b"], ["a", "d"], ["e", "f"]], 3, 2, Doomed, standing),
        /the published ETHEREUM groups repeat an operator/
      )
      Assert.throws(
        () => TerminationSteps.assertPublishedGroups(OutpostChainCodename.ETHEREUM, [["a", "b"], ["c", "x"], ["e", "f"]], 3, 2, Doomed, standing),
        /a ETHEREUM replacement is not a standing operator/
      )
    })
  })
})
