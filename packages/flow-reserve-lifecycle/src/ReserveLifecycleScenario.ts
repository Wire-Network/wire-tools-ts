import Assert from "node:assert"
import { SysioContracts } from "@wireio/sdk-core"
import { oppDebuggingPath } from "@wireio/debugging-shared"
import {
  ClusterBuildPhase,
  EthereumLocalReserveStatus,
  FlowScenario,
  Report,
  SwapUserIdentities,
  containsSwapRevert,
  matchesProtoEnum,
  pollUntil,
  slugValue,
  swapUserOutputKey,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/test-cluster-tool"
import { ReserveLifecycleScenarioConstants as Constants } from "./ReserveLifecycleScenarioConstants.js"
import { ReserveLifecycleScenarioOwnerSteps as OwnerSteps } from "./steps/ReserveLifecycleScenarioOwnerSteps.js"
import { ReserveLifecycleScenarioReserveSteps as ReserveSteps } from "./steps/ReserveLifecycleScenarioReserveSteps.js"

const {
  SysioContractAccount,
  SysioContractName,
  SysioReservReservestatus,
  SysioUwritChainkind
} = SysioContracts
const { Actor } = Report

/** The depot reserve row for a `(chain, token, reserve)` slug triple (a read). */
async function readReserveRow(
  ctx: ClusterBuildContext,
  chainCode: number,
  tokenCode: number,
  reserveCode: number
): Promise<SysioContracts.SysioReservReserveRowType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.reserv)
    .tables.reserves.query({ limit: 100 })
  return rows.find(
    row =>
      slugValue(row.chain_code) === chainCode &&
      slugValue(row.token_code) === tokenCode &&
      slugValue(row.reserve_code) === reserveCode
  )
}

/** The forbidden UWREQ — anything sourcing the private ETH reserve (a read). */
async function readPrivateSourcedUwreq(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioUwritUwRequestTType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.uwrit)
    .tables.uwreqs.query({ limit: 100 })
  return rows.find(
    request =>
      slugValue(request.src_chain_code) === Constants.EthereumChainCode &&
      slugValue(request.src_reserve_code) === Constants.PrivateReserveCode
  )
}

/**
 * Inverted poll — passes only when `predicate` stays FALSE for the whole
 * window. `pollUntil`'s deadline expiry IS the pass; the predicate turning
 * true (the forbidden condition appearing) fails, and any other error
 * propagates unchanged.
 *
 * @param label - What must NOT appear (for the failure message).
 * @param predicate - Async check; `true` means the forbidden condition appeared.
 * @param windowMs - The observation window (ms).
 * @param intervalMs - Delay between checks (ms).
 * @throws When the forbidden condition appears inside the window.
 */
async function assertNeverWithinWindow(
  label: string,
  predicate: () => Promise<boolean>,
  windowMs: number,
  intervalMs: number
): Promise<void> {
  await pollUntil(label, predicate, windowMs, intervalMs).then(
    () => {
      throw new Error(`Forbidden condition observed within ${windowMs}ms: ${label}`)
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes(Constants.PollTimeoutMessageFragment)) throw error
    }
  )
}

/**
 * Gated reserve create→match lifecycle + private-reserve exclusions.
 *
 * The depot (`sysio.reserv`) gates post-bootstrap reserve creation on the
 * creator's authex link and activation on a REAL WIRE match:
 *
 * - An outpost `create_reserve` ships `isPrivate` + the creator's pubkey
 *   (33-byte compressed secp256k1 on ETH, contract-verified to derive to
 *   `msg.sender`). The depot inserts a PENDING row when the creator is
 *   authex-linked; an unlinked creator gets a CANCELLED row + a
 *   RESERVE_CREATE_CANCELLED round-trip that refunds the outpost escrow.
 * - `matchreserve` requires the matcher to be THE WIRE account authex-linked
 *   to the creator's key, escrows `wire_amount` REAL WIRE (matcher →
 *   sysio.reserv custody), flips the row ACTIVE, records `owner = matcher`,
 *   and queues RESERVE_READY back to the outpost.
 * - Private reserves are excluded from everything except same-owner private
 *   pairs: a private↔public pairing draws a SWAP_REVERT (no UWREQ row is
 *   ever created) and WIRE-endpoint swaps touching one are rejected
 *   (`swapfromwire` asserts at push).
 *
 * ETH-side only — the SOL create path is exercised by
 * `flow-swap-private-reserves`.
 */
export class ReserveLifecycleScenario extends FlowScenario {
  readonly name = "flow-reserve-lifecycle"
  readonly description =
    "Gated reserve create→match lifecycle + private-reserve exclusions (ETH-side)"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    requiredUnderwriterCollateral: [
      {
        chainCode: Constants.EthereumChainCode,
        tokenCode: Constants.EthereumTokenCode,
        minimumBond: Constants.UnderwriterMinimumBond
      },
      {
        chainCode: Constants.SolanaChainCode,
        tokenCode: Constants.SolanaTokenCode,
        minimumBond: Constants.UnderwriterMinimumBond
      }
    ]
  }

  build(cluster: ClusterBuild): void {
    const relayStepOptions = { timeoutMs: Constants.RelayDeadlineMs + Constants.PollDeadlineBufferMs },
      readyStepOptions = { timeoutMs: Constants.ReadyDeadlineMs + Constants.PollDeadlineBufferMs },
      windowStepOptions = { timeoutMs: Constants.NoUwreqWindowMs + Constants.PollDeadlineBufferMs },
      ethereumWriteOptions = { timeoutMs: Constants.EthereumWriteStepTimeoutMs },
      wireWriteOptions = { timeoutMs: Constants.WireWriteStepTimeoutMs }

    // ── 0. Substrate health (the old suite's phase-0 checks) ──
    ClusterBuildPhase.create(cluster, "VerifySubstrate", "The chain produces blocks; the public counterpart is seeded").push(
      verifyStep(Actor.Sysio, "wire-chain-producing", "WIRE chain is producing blocks", async ctx => {
        const info = await ctx.wire.getInfo()
        Assert.ok(Number(info.head_block_num) > 0, "head_block_num must be > 0")
      }),
      verifyStep(
        Actor.Sysio,
        "public-counterpart-seeded",
        "bootstrap seeded the SOLANA/SOL/PRIMARY public counterpart",
        async ctx => {
          // The swap probe pairs the private reserve against this public
          // reserve — it must exist so the rejection is attributable to
          // privacy, not absence.
          const row = await readReserveRow(
            ctx,
            Constants.SolanaChainCode,
            Constants.SolanaTokenCode,
            Constants.PublicReserveCode
          )
          Assert.ok(row != null, "SOLANA/SOL/PRIMARY reserve row must exist")
        }
      )
    )

    // ── 1. The reserve creator's paired ETH + SOL identity (+ SOL airdrop) ──
    SwapUserIdentities.ensure(
      cluster,
      "ProvisionCreatorIdentity",
      "Provision the reserve creator's ETH + SOL identity",
      {}
    )

    // ── 2. The WIRE matcher accounts + the creator-key authex link ──
    ClusterBuildPhase.create(cluster, "ProvisionOwner", "Provision the matcher accounts and authex-link the matcher to the creator key").push(
      OwnerSteps.provisionUser(
        Actor.User,
        "provision-matcher",
        `provision + fund ${Constants.MatcherAccount} (the legitimate matcher)`,
        wireWriteOptions,
        Constants.MatcherAccount,
        Constants.MatcherFunding
      ),
      // The wrong matcher is funded identically so ONLY the missing authex
      // link explains its rejection.
      OwnerSteps.provisionUser(
        Actor.User,
        "provision-wrong-matcher",
        `provision + fund ${Constants.WrongMatcherAccount} (never authex-linked)`,
        wireWriteOptions,
        Constants.WrongMatcherAccount,
        Constants.WrongMatcherFunding
      ),
      OwnerSteps.createLink(
        Actor.User,
        "authex-link-matcher",
        `authex-link ${Constants.MatcherAccount} to the creator wallet's secp256k1 key`,
        wireWriteOptions,
        Constants.MatcherAccount
      )
    )

    // ── 3. CreatePrivateLinked — linked creator's create lands PENDING ──
    ClusterBuildPhase.create(cluster, "CreatePrivateLinked", "The linked creator's private create_reserve lands a PENDING depot row").push(
      ReserveSteps.createReserve(
        Actor.User,
        "create-private-reserve",
        `create_reserve(PRIVRES, isPrivate) escrowing ${Constants.PrivateEscrowWei} wei`,
        ethereumWriteOptions,
        {
          tokenCode: BigInt(Constants.EthereumTokenCode),
          reserveCode: BigInt(Constants.PrivateReserveCode),
          externalTokenAmount: Constants.PrivateEscrowWei,
          requestedWireAmount: Constants.RequestedWireAmount,
          connectorWeightBps: Constants.ConnectorWeightBps,
          name: Constants.PrivateReserveName,
          description: Constants.PrivateReserveDescription,
          isPrivate: true
        }
      ),
      verifyStep(
        Actor.Sysio,
        "depot-row-pending",
        "PRIVRES depot row lands PENDING carrying the privacy flag + creator pubkey",
        async ctx => {
          await pollUntil(
            "PRIVRES depot row status=PENDING",
            async () => {
              const row = await readReserveRow(
                ctx,
                Constants.EthereumChainCode,
                Constants.EthereumTokenCode,
                Constants.PrivateReserveCode
              )
              return (
                row != null &&
                matchesProtoEnum(
                  row.status,
                  SysioReservReservestatus,
                  SysioReservReservestatus.RESERVE_STATUS_PENDING
                )
              )
            },
            Constants.RelayDeadlineMs,
            Constants.PollIntervalMs
          )
          // The privacy flag + the normalized creator key both ride the
          // create attestation and land verbatim on the depot row.
          const row = await readReserveRow(
            ctx,
            Constants.EthereumChainCode,
            Constants.EthereumTokenCode,
            Constants.PrivateReserveCode
          )
          Assert.ok(
            row.is_private === true || Number(row.is_private) === 1,
            "PRIVRES depot row must carry is_private"
          )
          Assert.ok(
            typeof row.creator_pub_key === "string" && row.creator_pub_key.length > 0,
            "PRIVRES depot row must carry the creator pubkey"
          )
        },
        relayStepOptions
      )
    )

    // ── 4. CreatePrivateUnlinked — unlinked creator is cancelled back + refunded ──
    ClusterBuildPhase.create(cluster, "CreatePrivateUnlinked", "An unlinked creator's create is cancelled back and its escrow refunded").push(
      ReserveSteps.fundUnlinkedCreator(
        Actor.User,
        "fund-unlinked-creator",
        `seed the never-linked creator wallet with ${Constants.NoLinkWalletFundingWei} wei`,
        ethereumWriteOptions,
        Constants.NoLinkWalletFundingWei
      ),
      ReserveSteps.createReserveUnlinked(
        Actor.User,
        "create-unlinked-reserve",
        `create_reserve(NOLINKRS) escrowing ${Constants.NoLinkEscrowWei} wei from the unlinked creator`,
        ethereumWriteOptions,
        {
          tokenCode: BigInt(Constants.EthereumTokenCode),
          reserveCode: BigInt(Constants.NoLinkReserveCode),
          externalTokenAmount: Constants.NoLinkEscrowWei,
          requestedWireAmount: Constants.RequestedWireAmount,
          connectorWeightBps: Constants.ConnectorWeightBps,
          name: Constants.NoLinkReserveName,
          description: Constants.NoLinkReserveDescription,
          isPrivate: false
        }
      ),
      verifyStep(
        Actor.Sysio,
        "depot-row-cancelled",
        "the depot rejects by inserting a CANCELLED audit row",
        async ctx => {
          await pollUntil(
            "NOLINKRS depot row status=CANCELLED",
            async () => {
              const row = await readReserveRow(
                ctx,
                Constants.EthereumChainCode,
                Constants.EthereumTokenCode,
                Constants.NoLinkReserveCode
              )
              return (
                row != null &&
                matchesProtoEnum(
                  row.status,
                  SysioReservReservestatus,
                  SysioReservReservestatus.RESERVE_STATUS_CANCELLED
                )
              )
            },
            Constants.RelayDeadlineMs,
            Constants.PollIntervalMs
          )
        },
        relayStepOptions
      ),
      verifyStep(
        Actor.EthereumOutpost,
        "escrow-refunded",
        "the RESERVE_CREATE_CANCELLED round-trip refunds the creator's escrow (gas-only spend)",
        async ctx => {
          const preCreateBalance = ctx.outputs.assert(
            ReserveSteps.unlinkedCreatorPreCreateBalanceKey()
          )
          const refundFloor = preCreateBalance - Constants.RefundGasAllowanceWei
          await pollUntil(
            "NOLINKRS creator escrow refunded",
            async () =>
              (await ctx.ethereum.getBalance(
                ReserveSteps.unlinkedCreatorWallet(ctx).address
              )) > refundFloor,
            Constants.ReadyDeadlineMs,
            Constants.PollIntervalMs
          )
        },
        readyStepOptions
      ),
      verifyStep(
        Actor.EthereumOutpost,
        "outpost-record-cancelled",
        "the outpost-local NOLINKRS record flips CANCELLED in the same dispatch",
        async ctx => {
          await pollUntil(
            "outpost-local NOLINKRS record CANCELLED",
            async () =>
              (await ReserveSteps.readOutpostReserveStatus(
                ctx,
                BigInt(Constants.EthereumTokenCode),
                BigInt(Constants.NoLinkReserveCode)
              )) === EthereumLocalReserveStatus.CANCELLED,
            Constants.ReadyDeadlineMs,
            Constants.PollIntervalMs
          )
        },
        readyStepOptions
      )
    )

    // ── 5. MatcherMustBeLinked — the match gate rejects unlinked, accepts linked ──
    ClusterBuildPhase.create(cluster, "MatcherMustBeLinked", "matchreserve gates on the matcher's authex link; the linked matcher activates with exact WIRE escrow").push(
      verifyStep(
        Actor.Sysio,
        "unlinked-matcher-rejected",
        "matchreserve from a non-linked account is rejected",
        async ctx => {
          // wrongmatchr passes every pre-check (row PENDING, exact
          // wire_amount) so the failure is attributable to the missing
          // authex link alone.
          await Assert.rejects(
            ctx.wire
              .getSysioContract(SysioContractName.reserv)
              .actions.matchreserve.invoke(
                {
                  chain_code: { value: Constants.EthereumChainCode },
                  token_code: { value: Constants.EthereumTokenCode },
                  reserve_code: { value: Constants.PrivateReserveCode },
                  matcher: Constants.WrongMatcherAccount,
                  wire_amount: Number(Constants.RequestedWireAmount)
                },
                {
                  authorization: [
                    { actor: Constants.WrongMatcherAccount, permission: "active" }
                  ],
                  skipWait: true
                }
              ),
            Constants.MatcherNotLinkedPattern
          )
        },
        wireWriteOptions
      ),
      ReserveSteps.matchReserve(
        Actor.User,
        "match-reserve",
        `${Constants.MatcherAccount} escrows ${Constants.RequestedWireAmount} raw WIRE via matchreserve`,
        wireWriteOptions,
        Constants.EthereumChainCode,
        Constants.EthereumTokenCode,
        Constants.PrivateReserveCode,
        Constants.MatcherAccount,
        Constants.RequestedWireAmount
      ),
      verifyStep(
        Actor.Sysio,
        "depot-row-active",
        "the match flips PRIVRES ACTIVE recording owner + wire book",
        async ctx => {
          await pollUntil(
            "PRIVRES depot row status=ACTIVE",
            async () => {
              const row = await readReserveRow(
                ctx,
                Constants.EthereumChainCode,
                Constants.EthereumTokenCode,
                Constants.PrivateReserveCode
              )
              return (
                row != null &&
                matchesProtoEnum(
                  row.status,
                  SysioReservReservestatus,
                  SysioReservReservestatus.RESERVE_STATUS_ACTIVE
                )
              )
            },
            Constants.ReadyDeadlineMs,
            Constants.PollIntervalMs
          )
          const row = await readReserveRow(
            ctx,
            Constants.EthereumChainCode,
            Constants.EthereumTokenCode,
            Constants.PrivateReserveCode
          )
          Assert.strictEqual(row.owner, Constants.MatcherAccount, "owner must be the matcher")
          Assert.strictEqual(
            BigInt(row.reserve_wire_amount),
            Constants.RequestedWireAmount,
            "reserve_wire_amount must equal the requested amount"
          )
        },
        readyStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "wire-custody-exact",
        "the match IS a WIRE deposit — custody up, matcher down, exactly",
        async ctx => {
          const snapshot = ctx.outputs.assert(ReserveSteps.wireCustodySnapshotKey())
          const custodyAfter = await ctx.wire.getWireBalance(
            SysioContractAccount[SysioContractName.reserv]
          )
          const matcherAfter = await ctx.wire.getWireBalance(Constants.MatcherAccount)
          Assert.strictEqual(
            custodyAfter,
            snapshot.custody + Constants.RequestedWireAmount,
            "sysio.reserv custody must increase by exactly the match amount"
          )
          Assert.strictEqual(
            matcherAfter,
            snapshot.matcher - Constants.RequestedWireAmount,
            "the matcher must decrease by exactly the match amount"
          )
        }
      ),
      verifyStep(
        Actor.EthereumOutpost,
        "outpost-record-active",
        "RESERVE_READY flips the outpost-local record ACTIVE",
        async ctx => {
          await pollUntil(
            "outpost-local PRIVRES record ACTIVE",
            async () =>
              (await ReserveSteps.readOutpostReserveStatus(
                ctx,
                BigInt(Constants.EthereumTokenCode),
                BigInt(Constants.PrivateReserveCode)
              )) === EthereumLocalReserveStatus.ACTIVE,
            Constants.ReadyDeadlineMs,
            Constants.PollIntervalMs
          )
        },
        readyStepOptions
      )
    )

    // ── 6. PrivateRejectPublic — the privacy gate rejects cross-owner pairings ──
    ClusterBuildPhase.create(cluster, "PrivateRejectPublic", "A private reserve cannot pair with a public counterpart, in either direction").push(
      ReserveSteps.requestSwapProbe(
        Actor.User,
        "swap-private-to-public",
        "requestSwap sourcing PRIVRES against the public SOLANA/SOL/PRIMARY reserve",
        ethereumWriteOptions,
        {
          sourceTokenCode: BigInt(Constants.EthereumTokenCode),
          sourceReserveCode: BigInt(Constants.PrivateReserveCode),
          sourceAmountWei: Constants.SwapProbeSourceEthereumWei,
          targetChainCode: BigInt(Constants.SolanaChainCode),
          targetTokenCode: BigInt(Constants.SolanaTokenCode),
          targetReserveCode: BigInt(Constants.PublicReserveCode),
          targetAmount: Constants.SwapProbeTargetAmount,
          targetToleranceBps: Constants.SwapProbeToleranceBps
        }
      ),
      verifyStep(
        Actor.Sysio,
        "no-private-uwreq",
        "no UWREQ sourcing the private reserve is ever created",
        async ctx => {
          // The privacy gate precedes the variance check on the depot, so
          // the sentinel target never reaches the quote comparison — the
          // swap is rejected and NO uwreq row appears inside the window.
          await assertNeverWithinWindow(
            "forbidden PRIVRES-sourced UWREQ",
            async () => (await readPrivateSourcedUwreq(ctx)) != null,
            Constants.NoUwreqWindowMs,
            Constants.PollIntervalMs
          )
        },
        windowStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "swap-revert-circulated",
        "a SWAP_REVERT attestation circulates back to the Ethereum outpost",
        async ctx => {
          await pollUntil(
            "SWAP_REVERT envelope on DEPOT→ETHEREUM",
            async () => containsSwapRevert(oppDebuggingPath(ctx.config.clusterPath)),
            Constants.ReadyDeadlineMs,
            Constants.PollIntervalMs
          )
        },
        readyStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "swapfromwire-rejected",
        "swapfromwire targeting a private reserve is rejected at submit",
        async ctx => {
          // WIRE-endpoint exclusion is symmetric: an outbound from-WIRE swap
          // aimed AT a private reserve asserts at push (the reserve is
          // ACTIVE, so the privacy check is the one that fires).
          const swapUser = ctx.outputs.assert(swapUserOutputKey())
          await Assert.rejects(
            ctx.wire
              .getSysioContract(SysioContractName.uwrit)
              .actions.swapfromwire.invoke(
                {
                  user: Constants.MatcherAccount,
                  wire_amount: Number(Constants.FromWireProbeWireAmount),
                  dst_chain_code: { value: Constants.EthereumChainCode },
                  dst_token_code: { value: Constants.EthereumTokenCode },
                  dst_reserve_code: { value: Constants.PrivateReserveCode },
                  target_amount: Number(Constants.FromWireProbeTargetAmount),
                  target_tolerance_bps: Constants.FromWireProbeToleranceBps,
                  recipient_kind: SysioUwritChainkind.CHAIN_KIND_EVM,
                  recipient_addr: Buffer.from(swapUser.ethereumAddressBytes).toString("hex")
                },
                {
                  authorization: [
                    { actor: Constants.MatcherAccount, permission: "active" }
                  ],
                  skipWait: true
                }
              ),
            Constants.PrivateFromWireExcludedPattern
          )
        },
        wireWriteOptions
      )
    )
  }
}
