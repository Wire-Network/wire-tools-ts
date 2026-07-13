import {
  InboundTipReader,
  type OutpostConsensusRow
} from "@wireio/test-flow-batch-operator-slashing/InboundTipReader.js"

/** The ETHEREUM outpost chain code used across the fixtures. */
const ETHEREUM_CHAIN_CODE = 41
/** A second chain code proving row selection ignores other outposts. */
const SOLANA_CHAIN_CODE = 42
/** The contested epoch the reads are scoped to. */
const EPOCH = 7

/** 32-byte message tip pinned by the fixtures (0x11 repeated). */
const MESSAGE_TIP_HEX = "0x" + "11".repeat(32)
/** 32-byte envelope digest pinned by the fixtures (0x22 repeated). */
const ENVELOPE_DIGEST_HEX = "0x" + "22".repeat(32)

/** A populated `outpcons` row for the requested outpost. */
function matchingRow(): OutpostConsensusRow {
  return {
    chain_code: ETHEREUM_CHAIN_CODE,
    message_tip: MESSAGE_TIP_HEX,
    envelope_digest: ENVELOPE_DIGEST_HEX
  }
}

/** A row for the other outpost that a correct reader must skip. */
function otherRow(): OutpostConsensusRow {
  return {
    chain_code: SOLANA_CHAIN_CODE,
    message_tip: "0x" + "33".repeat(32),
    envelope_digest: "0x" + "44".repeat(32)
  }
}

/** A query stub returning `rows`, counting its invocations. */
function queryOf(rows: OutpostConsensusRow[]): {
  query: () => Promise<OutpostConsensusRow[]>
  calls: () => number
} {
  let calls = 0
  return {
    query: async () => {
      calls++
      return rows
    },
    calls: () => calls
  }
}

describe("InboundTipReader", () => {
  test("parses both tips off the requested outpost's row", async () => {
    const { query, calls } = queryOf([otherRow(), matchingRow()])
    const tips = await new InboundTipReader().read(
      ETHEREUM_CHAIN_CODE,
      EPOCH,
      query
    )

    expect(Buffer.from(tips.messageTip).toString("hex")).toBe(
      MESSAGE_TIP_HEX.slice(2)
    )
    expect(Buffer.from(tips.envelopeDigest).toString("hex")).toBe(
      ENVELOPE_DIGEST_HEX.slice(2)
    )
    expect(calls()).toBe(1)
  })

  test("matches a row whose chain_code arrives as a string", async () => {
    const row = { ...matchingRow(), chain_code: String(ETHEREUM_CHAIN_CODE) }
    const tips = await new InboundTipReader().read(
      ETHEREUM_CHAIN_CODE,
      EPOCH,
      queryOf([row]).query
    )

    expect(Buffer.from(tips.messageTip).toString("hex")).toBe(
      MESSAGE_TIP_HEX.slice(2)
    )
  })

  test("returns empty tips when the outpost has no row (stream genesis)", async () => {
    const tips = await new InboundTipReader().read(
      ETHEREUM_CHAIN_CODE,
      EPOCH,
      queryOf([otherRow()]).query
    )

    expect(tips.messageTip.length).toBe(0)
    expect(tips.envelopeDigest.length).toBe(0)
  })

  test("returns empty tips for a genesis row (fields missing or all-zero)", async () => {
    const genesisRow: OutpostConsensusRow = {
      chain_code: ETHEREUM_CHAIN_CODE,
      message_tip: "0x" + "00".repeat(32)
      // envelope_digest absent: the depot leaves it unset until the first accepted envelope.
    }
    const tips = await new InboundTipReader().read(
      ETHEREUM_CHAIN_CODE,
      EPOCH,
      queryOf([genesisRow]).query
    )

    expect(tips.messageTip.length).toBe(0)
    expect(tips.envelopeDigest.length).toBe(0)
  })

  test("collapses concurrent reads for one (chainCode, epochIndex) onto a single query", async () => {
    const reader = new InboundTipReader()
    let calls = 0
    let release: (rows: OutpostConsensusRow[]) => void
    const gate = new Promise<OutpostConsensusRow[]>(
      resolve => (release = resolve)
    )
    const query = () => {
      calls++
      return gate
    }

    // All reads start before the query resolves — the single-flight window that matters.
    const reads = Promise.all([
      reader.read(ETHEREUM_CHAIN_CODE, EPOCH, query),
      reader.read(ETHEREUM_CHAIN_CODE, EPOCH, query),
      reader.read(ETHEREUM_CHAIN_CODE, EPOCH, query)
    ])
    release!([matchingRow()])
    const [first, second, third] = await reads

    expect(calls).toBe(1)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  test("scopes the cache by epoch: a later epoch re-reads", async () => {
    const reader = new InboundTipReader()
    const { query, calls } = queryOf([matchingRow()])

    await reader.read(ETHEREUM_CHAIN_CODE, EPOCH, query)
    await reader.read(ETHEREUM_CHAIN_CODE, EPOCH, query)
    expect(calls()).toBe(1)

    await reader.read(ETHEREUM_CHAIN_CODE, EPOCH + 1, query)
    expect(calls()).toBe(2)
  })

  test("does not cache a rejected query: the next read retries and succeeds", async () => {
    const reader = new InboundTipReader()
    let calls = 0
    const query = async () => {
      calls++
      if (calls === 1) {
        throw new Error("transient RPC failure")
      }
      return [matchingRow()]
    }

    await expect(
      reader.read(ETHEREUM_CHAIN_CODE, EPOCH, query)
    ).rejects.toThrow("transient RPC failure")
    const tips = await reader.read(ETHEREUM_CHAIN_CODE, EPOCH, query)

    expect(calls).toBe(2)
    expect(Buffer.from(tips.messageTip).toString("hex")).toBe(
      MESSAGE_TIP_HEX.slice(2)
    )
  })
})
