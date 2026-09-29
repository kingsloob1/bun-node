#!/usr/bin/env bash
# Runs hostile.ts under bubblewrap inside a transient systemd user scope
# (cgroup limits), without Docker, plus one control per probe.
# One command:  bash bwrap-hostile.sh > bwrap-hostile.out
set -u
cd "$(dirname "$0")"
EV=$PWD
BUNDIR=$(dirname "$(readlink -f "$(command -v bun)")")

# cgroup limits: memory with no swap (the host's swap is otherwise used), tasks, cpu
scope() { # MemoryMax TasksMax
  echo systemd-run --user --scope --quiet -p "MemoryMax=$1" -p MemorySwapMax=0 -p "TasksMax=$2" -p CPUQuota=50%
}

# The sandbox: only /usr, the bun binary and the job dir, all read-only; a
# 16 MiB tmpfs /tmp; every namespace unshared (no network); a clean env; the
# bwrap-made root remounted read-only last.
sandbox() { # extra bwrap args before the command
  echo bwrap --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin \
    --ro-bind "$BUNDIR" /opt/bun --ro-bind "$EV" /w --chdir /w \
    --proc /proc --dev /dev --size 16777216 --tmpfs /tmp \
    --unshare-all --die-with-parent --new-session --clearenv \
    --setenv PATH /opt/bun:/usr/bin --setenv HOME /tmp "$@" --remount-ro /
}

run() { # label, then the full command
  local label=$1; shift
  echo "### $label"
  echo "load: $(cut -d' ' -f1-3 /proc/loadavg)"
  echo "\$ $*"
  timeout 60 "$@" 2>&1 | tail -6
  echo "exit=${PIPESTATUS[0]}"
  echo
}

echo "bwrap $(bwrap --version | cut -d' ' -f2), bun $(bun --version) from $BUNDIR"
echo

run "info (hardened)"                 $(scope 128M 64) $(sandbox) bun hostile.ts info

run "a. shadow: hardened (/etc not bound)"            $(scope 128M 64) $(sandbox) bun hostile.ts shadow
run "a. shadow: control, host / bound read-only"       $(scope 128M 64) $(sandbox --ro-bind / /hostroot) sh -c 'ls -l /hostroot/etc/shadow; head -c1 /hostroot/etc/shadow >/dev/null && echo "host shadow readable" || echo "host shadow NOT readable"; test -r /hostroot'"$HOME"'/.bashrc && echo "host ~/.bashrc readable (whole bound tree is readable as uid 1000)"; echo "uid_map: $(cat /proc/self/uid_map)"'

run "b. network: hardened (--unshare-all)"             $(scope 128M 64) $(sandbox) bun hostile.ts network
run "b. network: control (--share-net)"                $(scope 128M 64) $(sandbox --share-net --ro-bind /etc/resolv.conf /etc/resolv.conf --ro-bind /run/systemd/resolve /run/systemd/resolve) bun hostile.ts network
run "c. host: hardened"                                $(scope 128M 64) $(sandbox) bun hostile.ts host 127.0.0.1:5432 127.0.0.1:6379 172.17.0.2:5432
run "c. host: control (--share-net), host loopback"    $(scope 128M 64) $(sandbox --share-net) bun hostile.ts host 127.0.0.1:5432 127.0.0.1:6379 172.17.0.2:5432

echo "host load before d: $(cat /proc/loadavg)"
t0=$(date +%s.%N)
run "d. forkbomb: hardened (TasksMax=64)"              $(scope 128M 64) $(sandbox) bun hostile.ts forkbomb
echo "elapsed: $(echo "$(date +%s.%N) - $t0" | bc) s; host load after: $(cat /proc/loadavg)"
echo
run "d. forkbomb: control (TasksMax=512)"              $(scope 1G 512) $(sandbox) bun hostile.ts forkbomb

run "e. memhog: hardened (MemoryMax=128M, no swap)"    $(scope 128M 64) $(sandbox) bun hostile.ts memhog 1024
run "e. memhog: control (MemoryMax=512M), 256MB"       $(scope 512M 64) $(sandbox) bun hostile.ts memhog 256

run "f. read-only: hardened (--remount-ro /)"          $(scope 128M 64) $(sandbox) bun hostile.ts rofs
run "f. read-only: control (bwrap root left writable)" $(scope 128M 64) bwrap --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin --ro-bind "$BUNDIR" /opt/bun --ro-bind "$EV" /w --chdir /w --proc /proc --dev /dev --tmpfs /tmp --unshare-all --die-with-parent --clearenv --setenv PATH /opt/bun:/usr/bin bun hostile.ts rofs
run "f. tmpfs: hardened (--size 16MiB), write 32MB"    $(scope 128M 64) $(sandbox) bun hostile.ts tmpfs /tmp/fill 32

SECRET_PROBE=host-secret-value run "g. env: hardened (--clearenv), SECRET_PROBE set on host" $(scope 128M 64) $(sandbox) bun hostile.ts env
run "h. caps: hardened"                                $(scope 128M 64) $(sandbox) bun hostile.ts caps
run "j. cpu: hardened (CPUQuota=50%)"                  $(scope 128M 64) $(sandbox) bun hostile.ts cpu 300000000
