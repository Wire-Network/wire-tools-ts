# Restart a real relay with a queued external payout

Run through `scripts/run-flow.mjs flow-batch-relay-restart` with a fresh cluster and the canonical heartbeat monitor. The governance validation step is explicit: this journey tests fresh Ethereum custody and final payout, not autonomous underwriting (covered by the plugin underwriting flows).

Epochs are depot-paced: Ethereum advances only once it has traffic and its minimum has passed. Its epochs here come from the redemption's `DESYNDICATE_LIQ` (depot traffic, so the payout drives itself) and from keep-due traffic (`sysio.epoch::notetraffic`) the keep-due pump gives Ethereum while the flow waits for the intake (an Ethereum → depot message the outpost emits only with its reply to the depot's next envelope, until the outposts report their backlog to the depot) and for the post-settlement inbound epoch.
