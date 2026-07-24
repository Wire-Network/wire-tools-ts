# external-outposts.Dockerfile
#
# A SINGLE image carrying BOTH `anvil` (Foundry) AND `solana-test-validator`
# (Agave), runnable as EITHER — the compose service's `command:` selects which.
# It also doubles as the runtime base for the mounted wire-sysio debug
# `nodeop` / `kiod` / `clio` binaries: ubuntu:24.04 ships glibc 2.39 + libstdc++6
# (GLIBCXX_3.4.33), and the debug binaries only require GLIBC_2.38 /
# GLIBCXX_3.4.32 (verified via `objdump -T nodeop`) plus the standard
# libgcc_s/libstdc++/libm/libc (verified via `ldd nodeop` — no exotic deps), so
# those services mount the build-path and run its binaries against this image's
# runtime libs. That is why there is ONE image for every service:
#   - anvil / solana        → run this image's OWN toolchain binaries; ONLY the
#                             config folder is mounted (no binary mounts).
#   - nodeop / kiod / clio  → run the binaries from the mounted build-path; this
#                             image supplies the glibc + libstdc++ runtime.
#
# Version pins — MUST match the HOST that created the cluster: a
# create-external-config clone carries the host's anvil dump + solana ledger, and
# loading either requires a byte-compatible runtime (a mismatch crashes anvil on
# --load-state and makes solana reject the ledger). The verify script detects the
# host versions and passes them as build args; these defaults match the current
# host (anvil 1.5.1-stable, Agave 4.0.3):
#   - Foundry / anvil            : FOUNDRY_VERSION build arg
#   - Agave solana-test-validator: SOLANA_VERSION build arg
#
# Build (context = scripts/external; nothing from the context is COPY'd — the
# image is self-contained toolchains only). `verify-external-bind-config.mjs`
# builds it via `docker compose build` before bringing the stack up.

FROM ubuntu:24.04

# Pin BOTH toolchains to the HOST that created the cluster (defaults match the
# current host; the verify script overrides via --build-arg from the detected
# host versions).
ARG FOUNDRY_VERSION=1.5.1
ARG SOLANA_VERSION=4.0.3

ENV DEBIAN_FRONTEND=noninteractive
# Foundry installs to /root/.foundry/bin; the anza installer to
# /root/.local/share/solana/install/active_release/bin. Put both on PATH so a
# compose `command:` can name `anvil` / `solana-test-validator` bare. The
# mounted wire-sysio binaries are invoked by absolute path from the build-path.
ENV PATH="/root/.foundry/bin:/root/.local/share/solana/install/active_release/bin:${PATH}"

# Runtime libraries:
#   - ca-certificates/curl/bzip2 : the Foundry + Agave installers
#   - git                        : foundryup requires git on PATH to install anvil
#   - libstdc++6                 : the wire-sysio debug binaries (nodeop/kiod/clio)
#                                  AND the Agave validator
#   - libssl3 / libudev1         : the Agave validator's dynamic deps
#   - procps                     : `ps` for in-container diagnostics
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      bzip2 \
      git \
      libstdc++6 \
      libssl3 \
      libudev1 \
      procps \
 && rm -rf /var/lib/apt/lists/*

# --- Foundry / anvil (pinned to FOUNDRY_VERSION = the host's anvil) ---
# `curl … | bash` lays down foundryup; `foundryup --install <version>` fetches
# that exact release (forge/cast/anvil/chisel) into /root/.foundry/bin so
# `anvil --load-state` can read the host-dumped anvil.json.
RUN curl -L https://foundry.paradigm.xyz | bash \
 && /root/.foundry/bin/foundryup --install ${FOUNDRY_VERSION}

# --- Agave solana-test-validator (pinned) ---
# The versioned anza installer drops the release into
# /root/.local/share/solana/install/releases/<ver> and points active_release at it.
RUN sh -c "$(curl -sSfL https://release.anza.xyz/v${SOLANA_VERSION}/install)"

# --- Node.js 22 (for the depot service only) ---
# The depot service launches the WIRE node fleet via `wire-cluster-tool run` —
# NOT by invoking `nodeop` directly. That is deliberate and load-bearing: a
# producer/operator node's `--signature-provider` (its K1 + BLS signing keys) is
# assembled on the command line by the CLI from `cluster-keys.json`
# (`NodeopProcess.buildArgs`); the per-node `config.ini` carries a
# signature-provider ONLY for the bios node, so a raw `nodeop --config-dir
# node_00` would start a non-producing node. The CLI is a Node program (Node >=22,
# per package.json), so the depot service needs a Node runtime. anvil / solana
# never touch Node; sharing one image just keeps a single build.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Fail the build early if any toolchain can't run in this image (catches a
# missing runtime lib before the stack is ever brought up).
RUN anvil --version \
 && solana-test-validator --version \
 && node --version

# No ENTRYPOINT / CMD: the compose service supplies the command —
# `anvil …`, `solana-test-validator …`, or an absolute-path nodeop/kiod
# invocation against the mounted build-path.
