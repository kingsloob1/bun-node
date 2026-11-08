#!/usr/bin/env bash
# Spike: does a branch that edits bun-jobs-ui rebase cheaply over a commit that
# moves the package into bun-ui (`git mv`, layer-first: app/ -> app/jobs/,
# __tests__/app/ -> __tests__/jobs/)?
#
# Runs in a throwaway repository of its own (never the bun-node checkout):
#
#   bash rename-rebase.sh <bun-node checkout> <empty scratch dir>
#
# It copies three real files, makes a feature branch that edits one moved file
# and adds a new file in a moved directory, then lands "move (pure)" and
# "fix imports" on develop and rebases the feature over them.
set -euo pipefail
REPO=${1:?bun-node checkout}
S=${2:?empty scratch dir}
mkdir -p "$S" && cd "$S"
git init -q -b develop
git config user.email spike@example.invalid
git config user.name spike
git config commit.gpgsign false

mkdir -p packages/bun-jobs-ui/app/components packages/bun-jobs-ui/__tests__/app
cp "$REPO/packages/bun-jobs-ui/app/components/Pager.tsx" packages/bun-jobs-ui/app/components/
cp "$REPO/packages/bun-jobs-ui/app/config.ts" packages/bun-jobs-ui/app/
cp "$REPO/packages/bun-jobs-ui/__tests__/app/pagination.test.tsx" packages/bun-jobs-ui/__tests__/app/
git add -A && git commit -qm base

# A feature branch written before the move: an edit and a new file.
git checkout -qb feat
sed -i '20s/$/ \/\/ feature edit/' packages/bun-jobs-ui/app/components/Pager.tsx
echo 'export const x = 1;' > packages/bun-jobs-ui/app/components/New.tsx
git add -A && git commit -qm feature

# develop: the move as a pure-rename commit, then the import fix-up.
git checkout -q develop
mkdir -p packages/bun-ui/app packages/bun-ui/__tests__
git mv packages/bun-jobs-ui/app packages/bun-ui/app/jobs
git mv packages/bun-jobs-ui/__tests__/app packages/bun-ui/__tests__/jobs
git commit -qm "move (pure)"
sed -i 's#"\.\./\.\./app/#"../../../app/jobs/#' packages/bun-ui/__tests__/jobs/pagination.test.tsx
git commit -qam "fix imports"

git checkout -q feat
out=$(git rebase develop 2>&1) || true
echo "$out" | grep CONFLICT || true
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  git status --short
  # The only conflict expected is "file location" for the new file, which git
  # has already placed at the new path: accept it.
  git add packages/bun-ui/app/jobs/components/New.tsx
  GIT_EDITOR=true git rebase --continue
fi
echo "--- after the rebase"
git show --stat --format=%s HEAD | sed -n '1,6p'
echo "edit carried to the new path: $(grep -c 'feature edit' packages/bun-ui/app/jobs/components/Pager.tsx)"
echo "--- history of the moved file (git log --follow)"
git log --follow --oneline -- packages/bun-ui/app/jobs/components/Pager.tsx
