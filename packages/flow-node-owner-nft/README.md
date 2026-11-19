# Node-owner NFT flow

An NFT claim creates a fresh Wire account through `nodeownreg`. Existing names
reject with `ACCOUNT_EXISTS` (7). The direct rejection fixtures verify the audit,
membership and Ethereum links. The BAR commit phase verifies delivery through OPP.
