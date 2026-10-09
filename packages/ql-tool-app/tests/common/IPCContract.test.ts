import { IPCChannel, IPCContract, IPCEventChannel } from "@wireio/ql-tool-app/common"

describe("IPCContract", () => {
  it("every IPCChannel member is in exactly one of the invoke / send partitions", () => {
    Object.values(IPCChannel).forEach(channel => {
      const memberships = [IPCContract.isInvokeChannel(channel), IPCContract.isSendChannel(channel)].filter(Boolean)
      expect({ channel, memberships: memberships.length }).toEqual({ channel, memberships: 1 })
    })
    expect(IPCContract.InvokeChannels.length + IPCContract.SendChannels.length).toBe(Object.values(IPCChannel).length)
  })

  it("the partitions hold no duplicates", () => {
    expect(new Set(IPCContract.InvokeChannels).size).toBe(IPCContract.InvokeChannels.length)
    expect(new Set(IPCContract.SendChannels).size).toBe(IPCContract.SendChannels.length)
  })

  it("recognizes every event channel", () => {
    Object.values(IPCEventChannel).forEach(channel => expect(IPCContract.isEventChannel(channel)).toBe(true))
  })

  it("a channel in neither contract is rejected by every predicate", () => {
    const foreign = "notAChannel"
    expect(IPCContract.isInvokeChannel(foreign)).toBe(false)
    expect(IPCContract.isSendChannel(foreign)).toBe(false)
    expect(IPCContract.isEventChannel(foreign)).toBe(false)
  })

  it("an event channel is not a renderer → main channel", () => {
    expect(IPCContract.isInvokeChannel(IPCEventChannel.menuAction)).toBe(false)
    expect(IPCContract.isSendChannel(IPCEventChannel.queryPort)).toBe(false)
  })
})
