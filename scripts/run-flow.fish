#!/usr/bin/env fish
#
# Run an e2e flow test against a WIRE cluster.
#
# Usage:
#   ./scripts/run-flow.fish [--force] <sysio-build-path> <ethereum-path> <cluster-path> <a|b|c|d>
#
# Examples:
#   ./scripts/run-flow.fish /data/shared/code/wire/wire-sysio/build/claude \
#       /data/shared/code/wire/wire-ethereum \
#       /data/opt/wire/chains/flow-d-test d
#
#   ./scripts/run-flow.fish --force ~/wire-sysio/build/claude \
#       ~/wire-ethereum ~/chains/flow-a-test a

argparse --name=run-flow 'f/force' -- $argv
or begin
    echo "Usage: run-flow.fish [--force] <sysio-build-path> <ethereum-path> <cluster-path> <flow-letter>" >&2
    exit 1
end

if test (count $argv) -ne 4
    echo "Error: expected 4 positional arguments, got "(count $argv) >&2
    echo "Usage: run-flow.fish [--force] <sysio-build-path> <ethereum-path> <cluster-path> <a|b|c|d>" >&2
    exit 1
end

set sysio_build_path $argv[1]
set ethereum_path $argv[2]
set cluster_path $argv[3]
set flow_letter $argv[4]

# Validate flow letter
if not contains $flow_letter a b c d
    echo "Error: flow letter must be one of: a b c d (got '$flow_letter')" >&2
    exit 1
end

# Validate sysio build path exists and has nodeop
if not test -d "$sysio_build_path"
    echo "Error: sysio build path does not exist: $sysio_build_path" >&2
    exit 1
end
if not test -x "$sysio_build_path/bin/nodeop"
    echo "Error: nodeop not found at $sysio_build_path/bin/nodeop" >&2
    exit 1
end

# Validate ethereum path exists and has hardhat config
if not test -d "$ethereum_path"
    echo "Error: ethereum path does not exist: $ethereum_path" >&2
    exit 1
end
if not test -f "$ethereum_path/hardhat.config.ts"
    echo "Error: not a wire-ethereum repo (no hardhat.config.ts): $ethereum_path" >&2
    exit 1
end

# Cluster path: if exists, require --force
if test -d "$cluster_path"
    if not set -q _flag_force
        echo "Error: cluster path already exists: $cluster_path" >&2
        echo "       Use --force to overwrite." >&2
        exit 1
    end
    echo "Removing existing cluster at $cluster_path"
    rm -rf "$cluster_path"
end

# Resolve script directory to find the e2e-tests root
set script_dir (status dirname)
set repo_root (realpath "$script_dir/..")

# Run the flow
set flow_pkg "flow-$flow_letter"
echo "Running $flow_pkg..."
echo "  sysio-build: $sysio_build_path"
echo "  ethereum:    $ethereum_path"
echo "  cluster:     $cluster_path"

cd "$repo_root/packages/$flow_pkg"
or begin
    echo "Error: flow package not found at $repo_root/packages/$flow_pkg" >&2
    exit 1
end

set -x WIRE_BUILD_PATH "$sysio_build_path"
set -x WIRE_ETH_PATH "$ethereum_path"
set -x WIRE_CLUSTER_PATH "$cluster_path"

npx jest --runInBand --forceExit --verbose
