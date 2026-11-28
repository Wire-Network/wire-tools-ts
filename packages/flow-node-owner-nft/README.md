# Node-owner NFT flow

An NFT claim creates a fresh Wire account through `nodeownreg`. Existing names
reject with `ACCOUNT_EXISTS` (7). The direct rejection fixtures verify the audit,
membership and Ethereum links. The BAR commit phase verifies delivery through OPP. Epochs are depot-paced and the
flow queues nothing to Ethereum, so the claim itself drives Ethereum: the outpost emits
it with its reply to the depot's next envelope, and the relays' report of the outpost's
backlog to the depot (`sysio.msgch::reportqueue`) makes Ethereum due for that envelope.
The commit-path wait adds no traffic.
