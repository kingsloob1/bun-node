# `bun --hot` misses an atomic save of an entry file outside the working directory

| | |
|---|---|
| **Bun** | 1.4.4-canary.1+11c367163, Linux x64 |
| **Status** | Filed as [oven-sh/bun#47787](https://github.com/oven-sh/bun/issues/47787) (2026-11-02; related, not the same: #40077's third item, #29524, #36328) |
| **Reproduction** | [`hot-misses-rename-outside-cwd.ts`](./hot-misses-rename-outside-cwd.ts) (exits 1 while present) |
| **Worked around in** | `packages/bun-common/__tests__/hotChild.ts` (fixtures rewritten in place); the bun-common README's `bun --hot` notes (start it from the project root) |

## What happens

Under `bun --hot`, an atomic save of the entry file (write a sibling file,
then `rename(2)` it over the target, which is what editors and formatters do)
is not picked up when that file is outside the process's working directory.
The same atomic save inside the working directory is picked up, and so is an
in-place write outside it.

```
rename, file inside cwd: reloaded
in-place, file outside cwd: reloaded
rename, file outside cwd: NOT reloaded (expected reloaded)
```

## Why it is a bug

The file outside the working directory is watched: an in-place write to it
reloads. Only the way the change lands differs, so a save from most editors
silently leaves the old code running.

## The workaround

Start `bun --hot` from a directory that contains the entry file. The test
helper writes its fixtures in place, because they live in a temporary
directory outside the child's working directory.
