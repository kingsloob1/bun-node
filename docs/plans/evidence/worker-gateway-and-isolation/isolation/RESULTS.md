# Local isolation mechanisms: measurements

Measured on 2026-09-29 on one developer laptop, which other sessions share.
Every figure below comes from a script in this directory; the raw output sits
beside it as `*.out`. Marks: **[M]** measured here, **[V]** read from a primary
source (path given), **[U]** unverified.

Containers share the host kernel. Nothing measured here defends against a
kernel exploit; a hostile job that finds one escapes Docker and bubblewrap
alike. gVisor, Kata and Firecracker, which do address that, are not installed
and were not installed for this.

## Host

| Item | Value |
|---|---|
| CPU | i9-11900H, 16 threads |
| Kernel | Linux 7.0.0-31-generic x86_64 |
| Docker | 29.8.0, snap package |
| Host Bun | 1.4.3 (1.4.3-canary.1+5f554969b) |
| Container Bun | 1.4.2 (`oven/bun:1`) |
| Load during runs | 1-min load 2.3 to 5.4 |

The image is `oven/bun:1` at
`sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895`,
which is Bun 1.4.2: `docker pull oven/bun:1.4.3` failed with "manifest
unknown". [M]

## Scripts

Each runs with one command from this directory.

| Script | Command | Output |
|---|---|---|
| `inventory.sh` | `bash inventory.sh` | `inventory.out` |
| `cold-start.ts` | `bun cold-start.ts 10` | `cold-start.out` |
| `warm-pool.ts` | `bun warm-pool.ts 1000 20` | `warm-pool.out` |
| `warm-pool.ts` | `bun warm-pool.ts 10000 20` | `warm-pool-10k.out` |
| `docker-hostile.sh` | `bash docker-hostile.sh` | `docker-hostile.out` |
| `bwrap-hostile.sh` | `bash bwrap-hostile.sh` | `bwrap-hostile.out` |
| `bun-limits.ts` | see section 6 | `bun-limits.out` |
| `single-use-pool.ts` | `bun single-use-pool.ts 40 4` | `single-use-pool.out` |

`hostile.ts` is the hostile job, one mode per probe (`shadow`, `network`,
`host`, `forkbomb`, `memhog`, `rofs`, `tmpfs`, `env`, `caps`, `dockersock`,
`cpu`). It prints one JSON line per probe, where `ok: true` means the hostile
action succeeded. `pool-worker.ts` is the long-lived NDJSON job loop the warm
pool drives. The Docker scripts name every container `gwplan-*` and remove it;
none were left behind.

## 1. Tool inventory

From `inventory.sh` (`inventory.out`), all [M]:

| Tool or setting | State |
|---|---|
| Docker runtimes | `runc` (default), `io.containerd.runc.v2`, `nvidia` |
| Docker security options | apparmor (default), seccomp (builtin), cgroupns |
| userns-remap | off: container uid 0 maps to host uid 0 |
| cgroups | v2, systemd driver |
| Storage driver | overlay2 on zfs |
| Rootless Docker | not set up |
| Docker socket | `/var/run/docker.sock`, root:docker 0660 |
| This user in `docker` group | yes |
| gVisor (`runsc`) | absent |
| Kata, Firecracker | absent |
| Podman, crun, youki | absent |
| nsjail, firejail | absent |
| bubblewrap | 0.11.1, works unprivileged |
| `unshare -Ur` | works |
| `systemd-run --user --scope` | works, with MemoryMax/TasksMax |
| User cgroup delegation | cpu, memory, pids |
| Unprivileged userns | enabled, AppArmor-restricted |
| Landlock | in the LSM list, ABI 8 |
| Swap | 8 GB, full at the time |

Rootless: `docker context ls` lists only `default` on
`unix:///var/run/docker.sock`, `$XDG_RUNTIME_DIR/docker.sock` does not exist,
and `dockerd-rootless.sh` and `rootlesskit` are not installed. [M]

Being in the `docker` group is root-equivalent on this host: anyone who can
reach that socket can start a privileged container. Any design where the job
host itself drives Docker gives the job host that power. [V] Docker docs,
["Docker daemon attack surface"](https://docs.docker.com/engine/security/#docker-daemon-attack-surface).

bubblewrap works under `kernel.apparmor_restrict_unprivileged_userns = 1`
because Ubuntu ships an AppArmor profile for it,
`/etc/apparmor.d/bwrap-userns-restrict`, which grants `userns` to
`/usr/bin/bwrap`. [V: that file] A copied or differently-located bwrap binary
would not match that profile. [U]

### snap Docker refuses `no-new-privileges`

With `--security-opt no-new-privileges`, every container on this host fails
before its first instruction, with any image and any entrypoint: [M]

```
$ docker run --rm --security-opt no-new-privileges oven/bun:1 true
exec /usr/local/bin/docker-entrypoint.sh: operation not permitted
```

The kernel log names the cause: runc runs under the snap's own AppArmor
profile, and NNP forbids its transition to `docker-default`: [M]

```
apparmor="DENIED" operation="exec" info="no new privs" profile="snap.docker.dockerd"
  name="/usr/local/bin/bun" comm="runc:[2:INIT]" target="docker-default"
```

`apparmor=unconfined` fails the same way. It works only with
`--security-opt apparmor=snap.docker.dockerd`, which keeps the container in
the daemon's own snap profile, broader than `docker-default`. So on snap
Docker you choose between NNP and the `docker-default` AppArmor profile. A
non-snap Docker install should not have this conflict. [U]

The hardened profile below therefore omits NNP, and a variant adding
`--security-opt no-new-privileges --security-opt apparmor=snap.docker.dockerd`
is measured beside it.

## 2. Cold start

`bun cold-start.ts 10` (`cold-start.out`). One untimed warm-up run per variant,
then 10 timed runs of `bun -e 'console.log(1)'`, each checked to print `1`.
Load 3.76 before, 4.20 after. [M]

The hardened profile throughout this document:

```
--read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --user 65534:65534
--cap-drop=ALL --pids-limit 64 --memory 128m --memory-swap 128m --cpus 0.5
--network none --ipc none
```

| Variant | min ms | median ms | p90 ms |
|---|---|---|---|
| host `bun -e`, no isolation | 3 | 4 | 4 |
| bwrap `--unshare-all` | 8 | 9 | 10 |
| systemd-run scope + bwrap | 42 | 56 | 61 |
| docker run, defaults | 421 | 437 | 453 |
| docker run, `--network none` only | 255 | 273 | 287 |
| docker run, hardened | 253 | 277 | 292 |
| docker run, hardened + NNP | 272 | 281 | 290 |
| docker create, hardened | 137 | 145 | 150 |
| docker start -a, created | 250 | 261 | 268 |
| docker rm -f | 137 | 141 | 145 |

The hardening flags cost nothing measurable. The default bridge network costs
about 160 ms per container: `--network none` alone brings the default run from
437 ms to 273 ms. Pre-creating a container saves only the create (about
145 ms); starting it is still about 260 ms. The systemd scope, not bwrap, is
most of the bwrap path's cost (9 ms against 56 ms).

## 3. Warm pool and per-job exec

`bun warm-pool.ts 1000 20` and `bun warm-pool.ts 10000 20`. The persistent
variants run `pool-worker.ts`, which reads one NDJSON job per stdin line and
writes one result per stdout line. The job doubles a number, so the figure is
transport plus isolation. After 50 warm-up jobs, "sequential" keeps one job in
flight (latency) and "pipelined" writes all jobs at once (throughput). [M]

The Docker variant is one long-lived container:

```
docker run -i --rm <hardened> -v $PWD:/w:ro -w /w oven/bun:1 bun pool-worker.ts
```

10,000 jobs, load 5.39 before and after:

| Persistent transport | median ms | p90 ms | p99 ms | seq jobs/s | piped jobs/s |
|---|---|---|---|---|---|
| host child (Bun.spawn) | 0.028 | 0.050 | 0.127 | 29,319 | 355,688 |
| bwrap child | 0.029 | 0.051 | 0.126 | 28,081 | 295,814 |
| docker run -i, hardened | 0.068 | 0.109 | 0.297 | 12,215 | 354,683 |

1,000 jobs, load 4.50 to 4.54:

| Persistent transport | median ms | p90 ms | p99 ms | seq jobs/s | piped jobs/s |
|---|---|---|---|---|---|
| host child (Bun.spawn) | 0.023 | 0.034 | 0.094 | 37,896 | 262,963 |
| bwrap child | 0.020 | 0.028 | 0.056 | 44,959 | 252,707 |
| docker run -i, hardened | 0.081 | 0.107 | 0.247 | 11,288 | 334,702 |

Time to the first result, including start-up: host child 16 to 22 ms, bwrap
child 25 to 28 ms, Docker 287 to 291 ms.

A warm container adds about 40 to 60 µs per job round trip over a plain
child, because stdin and stdout pass through the Docker CLI and daemon. With
jobs pipelined the difference disappears: all three reach roughly 300,000
trivial jobs/s. A real job's work will dominate either figure.

Process per job, N=20, from the 10k run (the 1k run read 3.6, 9.5, 171 and 202 ms medians):

| Per-job process | min ms | median ms | p90 ms |
|---|---|---|---|
| Bun.spawn(`bun -e`), host | 3.3 | 3.8 | 4.1 |
| bwrap `bun -e` | 9.0 | 9.9 | 10.5 |
| docker exec `bun -e`, hardened | 153 | 165 | 176 |
| docker exec `echo`, hardened | 151 | 158 | 164 |

`docker exec` costs about 160 ms whatever it runs: the `echo` row shows the
exec machinery is the whole cost, with Bun's start-up lost in its noise.

Overhead attributable to isolation, per job:

| Model | Plain | Isolated | Added |
|---|---|---|---|
| Persistent worker, sequential | 0.028 ms | 0.068 ms (docker) | about 0.04 ms |
| Process per job | 3.8 ms | 9.9 ms (bwrap) | about 6 ms |
| Process per job | 3.8 ms | 165 ms (docker exec) | about 160 ms |
| Container per job | 3.8 ms | 277 ms (docker run) | about 270 ms |

### 3b. Pre-warmed, single-use containers

Added by the plan's author after the runs above. `bun single-use-pool.ts 40
<spares>` (`single-use-pool.out`) keeps `<spares>` hardened containers
started and waiting on stdin (`one-shot.ts`). Each job takes one, sends one
NDJSON line, reads the result, and the container exits and is removed. A
replacement is started the moment a spare is taken. Dispatch is the time from
writing the job to reading its result. Load 2.1 to 3.4. [M]

| Spares | jobs/s | dispatch p50 ms | dispatch p90 ms | ready p50 ms | ready p90 ms |
|---|---|---|---|---|---|
| 1 | 6.96 | 0.5 | 0.7 | 236 | 264 |
| 2 | 12.97 | 0.6 | 0.8 | 258 | 275 |
| 4 | 19.72 | 0.6 | 1.0 | 317 | 418 |
| 8 | 26.55 | 1.1 | 3.0 | 447 | 513 |

With a spare ready, a job pays about a millisecond, not the 277 ms cold start.
The price is throughput: a single-use pool can run no more jobs per second
than the daemon can start containers, which here flattened at about 27/s
with 8 spares, as each start slowed from 236 ms to 447 ms.

## 4. Hardening flags under Docker

`bash docker-hostile.sh` (`docker-hostile.out`), load 4.18 at the start. Each
probe runs under the hardened profile and under a control that removes the
flag in question. `hostile.ts` is mounted read-only at `/w`. All [M].

### a. Reading `/etc/shadow`

| Run | Result |
|---|---|
| hardened (uid 65534) | `EACCES` |
| control, root, default flags | read, 20 lines, first user `root` |

That file is the image's `/etc/shadow`, not the host's. Container root is,
however, host uid 0: `/proc/self/uid_map` reads `0 0 4294967295`, because
userns-remap is off. A container escape as root is a host root escape.

### b. Network

| Probe | hardened (`--network none`) | control (default bridge) |
|---|---|---|
| fetch `http://1.1.1.1/` | `FailedToOpenSocket` | 200 in 1,347 ms |
| fetch `http://169.254.169.254/` | `FailedToOpenSocket` | timeout at 3 s |
| DNS `example.com` | timeout | resolved |

There is no metadata service on this laptop, so the 169.254.169.254 control
shows the route exists but nothing answers. On a cloud VM it would answer
unless blocked. [U]

### c. Reaching the host and other containers

TCP connect only, no protocol spoken:

| Target | hardened | control (bridge) |
|---|---|---|
| host `172.17.0.1:80` | refused | **connected** |
| host `172.17.0.1:57621` | refused | **connected** |
| host `172.17.0.1:5432` | refused | refused |
| peer container `172.17.0.2:5432` | refused | **connected** |
| peer container `172.17.0.3:27017` | refused | **connected** |

On the default bridge a job reaches every host service bound to `0.0.0.0`
and, directly, every other container on the bridge: here the repo's own
Postgres and MongoDB test containers. Host services bound to `127.0.0.1`
(Postgres published as `127.0.0.1:5432`) were not reachable.

### d. Fork bomb

`hostile.ts forkbomb` spawns `sleep 30` until spawning fails:

| Run | pids.max | Spawned | First error |
|---|---|---|---|
| hardened | 64 | 60 | `EAGAIN` |
| control | 512 | 508 | `EAGAIN` |

Bun's own threads count against the limit: 60 children plus 4 threads is 64.
The hardened run took 75 ms inside and 0.51 s for the whole `docker run`;
host load read 3.77 before and after.

### e. Memory

`hostile.ts memhog` allocates and touches 16 MiB chunks:

| Run | Limit | Asked | Result |
|---|---|---|---|
| hardened | 128m, swap 128m | 1024 MB | ExitCode=137, OOMKilled=true |
| control | 512m, swap 512m | 256 MB | ExitCode 0, all 256 MB |

The hardened run printed 64 MB before the kill: the Bun runtime itself uses
some of the 128 MB. `--memory-swap` equal to `--memory` matters on this host,
whose swap was otherwise available.

### f. Filesystem

| Probe | hardened | control |
|---|---|---|
| write `/etc`, `/`, `/usr` | `EROFS` | written (root, writable) |
| write 32 MB to `/tmp` | `ENOSPC` after 16 MB | 32 MB (size=64m) |
| exec a copied `/bin/true` in `/tmp` | `EACCES` | ran (`exec` option) |

Docker's `--tmpfs` defaults to `noexec,nosuid,nodev`: a control with
`/tmp:rw,size=64m` still refused exec (`/proc/mounts` showed `noexec`), so
exec needs an explicit `exec` option.

### g. Environment

With `SECRET_PROBE` exported in the calling shell:

| Run | Container env keys |
|---|---|
| `-e FOO=bar` | image defaults plus FOO |
| `-e SECRET_PROBE` (name only) | image defaults plus SECRET_PROBE |
| `--env-file f` | image defaults plus the file's lines |

The image defaults are `BUN_INSTALL_BIN`, `BUN_RUNTIME_TRANSPILER_CACHE_PATH`,
`HOME`, `HOSTNAME`, `PATH` and `PWD`.

`docker run` inherits nothing from the caller's environment. Two spellings
do copy host values in: `-e NAME` with no value copies the caller's value of
NAME, and `--env-file` passes every line of the file.

### h. Capabilities and privilege

| Run | uid | CapEff | NoNewPrivs | chown | mknod |
|---|---|---|---|---|---|
| hardened | 65534 | 0 | 0 | `EPERM` | denied |
| root, default caps | 0 | `a80425fb` | 0 | allowed | allowed |
| root, `--cap-drop=ALL` | 0 | 0 | 0 | `EPERM` | denied |
| hardened + NNP (snap profile) | 65534 | 0 | 1 | `EPERM` | denied |

`Seccomp: 2` (filter) in every Docker run. The image has setuid-root binaries
(`su`, `passwd`, `mount`, `newgrp` and others). Without NNP, executing one
sets euid 0, but with an empty bounding set it gains no capabilities; euid 0
still owns root-owned files such as the image's `/etc/shadow`. That
escalation path was not exercised. [U]

### i. Docker socket

`/var/run/docker.sock` and `/run/docker.sock` are absent in the hardened
container. Nothing here mounts the socket, and nothing should: a job holding
it controls the host.

### j. CPU

A fixed 300M-iteration loop:

| Run | cpu.max | Wall ms | CPU ms | Share |
|---|---|---|---|---|
| `--cpus 0.5` | 50000 100000 | 2,796 | 1,398 | 0.50 |
| no `--cpus` | max 100000 | 1,403 | 1,407 | 1.00 |

### k. Disk quota

```
$ docker run --rm --storage-opt size=64m oven/bun:1 true
docker: Error response from daemon: --storage-opt is supported only for
overlay over xfs with 'pquota' mount option
```

Unsupported here (overlay2 on zfs). `--read-only` plus a sized tmpfs is the
working cap: writes outside the tmpfs fail with `EROFS`, and the tmpfs stops
at its size. tmpfs pages count against the container's memory limit. [U]

### Verdict: Docker flags

| Flag | Blocked | Evidence |
|---|---|---|
| `--user 65534:65534` | image shadow read | a: `EACCES` vs read |
| `--network none` | internet, DNS | b: socket fails vs 200 |
| `--network none` | host and peer containers | c: refused vs connected |
| `--pids-limit 64` | fork bomb | d: 60 vs 508 spawned |
| `--memory` + `--memory-swap` | memory hog | e: 137, OOMKilled |
| `--read-only` | root fs writes | f: `EROFS` vs written |
| tmpfs `size=16m` | filling /tmp | f: `ENOSPC` at 16 MB |
| tmpfs `noexec` | exec from /tmp | f: `EACCES` vs ran |
| no inheritance (default) | host env | g: only `-e` names |
| `--cap-drop=ALL` | chown, mknod as root | h: `EPERM` vs allowed |
| `no-new-privileges` | setuid gain (NoNewPrivs=1) | h: needs snap profile |
| socket not mounted | Docker control | i: absent |
| `--cpus 0.5` | CPU beyond half a core | j: share 0.50 |
| `--storage-opt size` | nothing: unsupported | k: daemon error |
| any of the above | kernel exploits | shared kernel |

## 5. bubblewrap under a systemd scope, no Docker

`bash bwrap-hostile.sh` (`bwrap-hostile.out`), load 3.64 at the start,
unprivileged, as uid 1000. The profile:

```
systemd-run --user --scope -p MemoryMax=128M -p MemorySwapMax=0 -p TasksMax=64 -p CPUQuota=50% \
  bwrap --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin \
    --ro-bind ~/.bun/bin /opt/bun --ro-bind <evidence dir> /w --chdir /w \
    --proc /proc --dev /dev --size 16777216 --tmpfs /tmp \
    --unshare-all --die-with-parent --new-session --clearenv \
    --setenv PATH /opt/bun:/usr/bin --setenv HOME /tmp --remount-ro / \
  bun hostile.ts <mode>
```

It works unprivileged with no setup. Cold start is in section 2: 9 ms for
bwrap alone, 56 ms with the scope. All [M]:

| Probe | hardened | control |
|---|---|---|
| a. `/etc/shadow` | `ENOENT` (`/etc` not bound) | host `/` bound: shadow `EACCES` |
| b. fetch 1.1.1.1 | `FailedToOpenSocket` | `--share-net`: 200 |
| b. DNS | `EAI_AGAIN` | `--share-net`: resolved |
| c. host `127.0.0.1:5432`, `:6379` | refused | `--share-net`: **connected** |
| c. container `172.17.0.2:5432` | refused | `--share-net`: **connected** |
| d. fork bomb | 58 (TasksMax=64) | 506 (TasksMax=512) |
| e. memhog 1024 MB | exit 137 (128M) | 256 MB ok (512M) |
| f. write `/`, `/usr` | `EROFS` | `/` written without `--remount-ro` |
| f. 32 MB to `/tmp` | `ENOSPC` at 16 MB | not run |
| f. exec from `/tmp` | **ran** | - |
| g. env with SECRET_PROBE set | HOME, PATH, PWD only | - |
| h. caps | CapEff 0, NoNewPrivs 1 | - |
| j. cpu | share 0.50 | - |

Notes on the bwrap results:

- **The sandbox sees exactly what is bound, with the host user's
  permissions.** With the host `/` bound read-only, the host's real
  `/etc/shadow` was unreadable (mode 0640, and uid 1000 is not in `shadow`),
  but `~/.bashrc` was readable, and so is everything else that user can read.
  The profile binds only `/usr`, the Bun directory and the job directory.
- **`--share-net` shares the host's network namespace**, including
  loopback. That is worse than Docker's bridge: host services bound to
  `127.0.0.1` (Postgres, Redis) connected.
- **No seccomp filter by default** (`Seccomp: 0`), where Docker applies one.
  bwrap accepts one through `--seccomp FD`. [V: `bwrap --help`]
- **tmpfs cannot be `noexec`**: exec from `/tmp` succeeded. bwrap has no
  mount-option flag for `--tmpfs`. [V: `bwrap --help`] Landlock (ABI 8
  present) could deny execute there. [U]
- bwrap sets `NoNewPrivs: 1` itself, which Docker on this host could not.
- The OOM kill takes the whole scope: systemd logs "Failed with result
  'oom-kill'", since `DefaultOOMPolicy=stop`.
- An earlier control run with MemoryMax=256M and TasksMax=512 was OOM-killed
  at 506 `sleep` processes. The same count fit in Docker's 128 MB, so memory
  accounting differs between the two. That was not investigated. [U]
- `MemorySwapMax=0` is required: without it the scope pages into the host's
  swap.

## 6. Bun-level limits

`bun-limits.ts`, each mode run under a scope as a safety net:

```
systemd-run --user --scope --quiet -p MemoryMax=2G -p MemorySwapMax=0 -p TasksMax=256 \
  bun bun-limits.ts <mode>
```

### Worker `resourceLimits`: not honoured [M]

A worker allocating about 1 GB of JS heap, host Bun 1.4.3, load 2.93:

| Worker options | Worker finished? | Process RSS after |
|---|---|---|
| none, to 512 MB | yes | 547 MB |
| `smol: true`, to 512 MB | yes | 542 MB |
| Web `Worker`, maxOldGenerationSizeMb 64 | yes, 1024 MB | 1,037 MB |
| `worker_threads`, maxOldGenerationSizeMb 64 | yes, 1024 MB | 1,044 MB |

No `ERR_WORKER_OUT_OF_MEMORY` and no error event: `resourceLimits` is
accepted and ignored. `smol` changes the heap configuration, not a cap. When
the same worker runs under `MemoryMax=512M` the kernel kills the **whole
process**, main thread included (exit 137): a worker offers no memory
isolation from the thread that started it.

bun-types 1.4.2 agrees: `resourceLimits` is commented out of
`WorkerOptions`, and `smol` is documented as "Use less memory, but make the
worker slower". [V: `node_modules/bun-types/bun.d.ts`, lines 653 and 694]

### Bun.spawn options

The options read from `node_modules/bun-types/bun.d.ts` (1.4.2, around
lines 7395 to 7725) [V]:

| Option | What it does |
|---|---|
| `timeout` | kill after N ms with `killSignal` |
| `killSignal` | signal for timeout, abort, maxBuffer; default SIGTERM |
| `maxBuffer` | kill when output exceeds N bytes |
| `signal` | AbortSignal kills the child |
| `uid`, `gid` | setuid/setgid the child (POSIX) |
| `cgroup` | join an existing cgroup before exec (Linux) |
| `env` | defaults to the startup env, not live `process.env` |
| rlimits | **no option**; the child inherits the parent's |

Measured with `bun bun-limits.ts spawn-opts` [M]:

| Probe | Result |
|---|---|
| `timeout: 200, killSignal: SIGKILL` on `sleep 10` | killed at 201 ms, SIGKILL |
| `maxBuffer: 1e6` on `yes` | SIGTERM after 1,065,536 bytes read |
| child `ulimit -a` | inherited: memory unlimited, nproc 250543 |

`maxBuffer` overshoots by one 64 KiB pipe read before the kill.

### Bun.spawn `cgroup`, unprivileged [M]

```
systemd-run --user --scope --quiet -p Delegate=yes -p MemoryMax=1G -p MemorySwapMax=0 -p TasksMax=256 \
  bun bun-limits.ts spawn-cgroup
```

Inside a delegated user scope the script moves itself to a leaf cgroup
(cgroup v2 forbids processes in a cgroup whose children use controllers),
enables `+memory +pids`, creates `job1` with `memory.max` 64M,
`memory.swap.max` 0 and `pids.max` 16, and spawns `hostile.ts` into it with
`Bun.spawn({ cgroup })`:

| Hostile mode | Result |
|---|---|
| memhog | SIGKILL after 47 ms; memory.events `oom_kill 1` |
| forkbomb | 12 spawned, then `EAGAIN` (16 minus 4 threads) |

So per-job memory and pids limits need neither root nor Docker: a
`Delegate=yes` scope, or a systemd service with `Delegate=yes`, plus Bun's own
`cgroup` spawn option. The container image's Bun 1.4.2 declares the option in
its types; the measurement was on host Bun 1.4.3. [M]

## 7. What stayed unverified

- A kernel-level escape. Every mechanism here shares the kernel. [U]
- Whether NNP works with `docker-default` on a non-snap Docker. [U]
- The setuid-binary escalation path without NNP. [U]
- Landlock to deny exec from bwrap's tmpfs. [U]
- Why 506 sleeps OOM at 256M under bwrap but fit 128M in Docker. [U]
- tmpfs pages counting against the container memory limit. [U]
- The metadata endpoint on a real cloud VM. [U]
- gVisor, Kata, Firecracker, Podman, nsjail: not installed, not installed
  for this. [U]
