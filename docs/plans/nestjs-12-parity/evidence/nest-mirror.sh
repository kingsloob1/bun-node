#!/usr/bin/env bash
# Copies a bun-node checkout to DEST and installs one NestJS version into it,
# leaving every other dependency exactly as the checkout's bun.lock pins it.
# The copy is what the plan's measurements ran in: bun-nest's suite, its type
# check, examples/bun-nest and consumer-check, on Nest 12 without touching the
# real tree.
#
#   evidence/nest-mirror.sh <repo-root> <dest> <nest-version>
#   evidence/nest-mirror.sh . ~/.cache/me/repo12 12.1.3
#
# Caveat, measured: a DEST with a dot segment (~/.cache/...) makes Express's
# `send` refuse every file below it (dotfiles: "ignore"), so expressCompat's
# res.sendFile and res.download probes fail on BOTH Nest majors there. Use a
# path without one when you need those two probes.
set -euo pipefail
src=$(cd "$1" && pwd)
dest=$2
version=$3

mkdir -p "$dest"
rsync -a --delete --exclude node_modules --exclude .git --exclude dts --exclude dist "$src/" "$dest/"
cd "$dest"

# devDependencies: the four Nest packages bun-nest and bun-jobs-ui install.
sed -i -E "s#(\"@nestjs/(common|core|platform-express|websockets)\": )\"[^\"]+\"#\1\"$version\"#" \
  packages/bun-nest/package.json packages/bun-jobs-ui/package.json
# bun-nest's peer range, so the install does not warn and a pack carries it.
major=${version%%.*}
sed -i -E "s#(\"@nestjs/(common|core|websockets)\": )\"\^11\.0\.0\"#\1\"^11.0.0 || ^${major}.0.0\"#" \
  packages/bun-nest/package.json

bun install
# The gate validates this tree, not another one (CLAUDE.md, worktrees).
bun -e "console.log(require.resolve('@kingsleyweb/bun-nest'))"
grep -h '"version"' node_modules/@nestjs/*/package.json
