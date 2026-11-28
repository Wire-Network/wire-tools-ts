# Restart the real relays with a queued external payout

Run through `scripts/run-flow.mjs flow-batch-relay-restart` with a fresh cluster and the canonical heartbeat monitor. The governance validation step is explicit: this journey tests fresh Ethereum custody and final payout, not autonomous underwriting (covered by the plugin underwriting flows).

Epochs are depot-paced: Ethereum advances only once it has traffic and its minimum has passed. Its epochs here come from the intake itself (an Ethereum → depot message the outpost emits with its reply to the depot's next envelope: the relays report the outpost's backlog to the depot, `sysio.msgch::reportqueue`, which makes Ethereum due), from the redemption's `DESYNDICATE_LIQ` (depot traffic, so the payout drives itself), and from keep-due traffic (`sysio.epoch::notetraffic`) the keep-due pump gives Ethereum while the flow waits for the post-settlement inbound epoch, which nothing queued on either side would bring.
