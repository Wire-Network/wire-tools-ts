# LCO launch smoke

A fresh cluster imports backed ETH and SOL principal during epoch zero. This short scenario then runs production-format purchase and staking-yield records through `convertImportSeed`, funds the exact WIRE obligations, links each original wallet to a distinct destination and checks both principal and exact WIRE claim deltas. No soak, arithmetic matrix or failure matrix is duplicated. Principal uses the existing mock import/backing steps; this is not a production indexer snapshot audit. Run using the canonical flow runner and heartbeat monitor.
