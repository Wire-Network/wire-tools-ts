# Node-owner NFT flow

An NFT claim creates a fresh Wire account through `nodeownreg`. Existing names
reject with `ACCOUNT_EXISTS` (7). The direct rejection fixtures verify the audit,
membership and Ethereum links. The BAR commit phase verifies delivery through OPP. Epochs are depot-paced and the
flow queues nothing to Ethereum, so the commit-path wait keeps Ethereum due with
keep-due traffic (`sysio.epoch::notetraffic`, the keep-due pump): the outpost emits
the claim only with its reply to the depot's next envelope, until the outposts report
their backlog to the depot themselves.
