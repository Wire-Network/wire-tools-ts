#!/usr/bin/env fish

set repoRoot (dirname (status dirname))
echo "Cleaning TypeScript build artifacts in $repoRoot"
if test -d $repoRoot
	find $repoRoot -name "*.tsbuildinfo" -delete 2>/dev/null; rm -rf $repoRoot/packages/*/lib 2>/dev/null;
end