#!/usr/bin/env bash
set -euo pipefail

repoRoot="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "Cleaning TypeScript build artifacts in $repoRoot"

find "$repoRoot" -name "*.tsbuildinfo" -delete 2>/dev/null || true
rm -rf "$repoRoot"/packages/*/dist 2>/dev/null || true
rm -rf "$repoRoot"/packages/*/out 2>/dev/null || true
rm -rf "$repoRoot"/packages/*/lib 2>/dev/null || true
