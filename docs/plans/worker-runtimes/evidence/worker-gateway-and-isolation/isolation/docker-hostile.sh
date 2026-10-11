#!/usr/bin/env bash
# Runs hostile.ts under the hardened Docker profile and under controls that
# drop one flag each. One command:  bash docker-hostile.sh > docker-hostile.out
# Containers are named gwplan-* and removed on the way out.
set -u
cd "$(dirname "$0")"
IMG=${IMG:-oven/bun:1}
MNT="-v $PWD:/w:ro -w /w"

# The hardened profile, minus no-new-privileges (see NNP below: snap Docker
# refuses to exec anything under NNP with its default AppArmor transition).
HARD="--read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --user 65534:65534 --cap-drop=ALL --pids-limit 64 --memory 128m --memory-swap 128m --cpus 0.5 --network none --ipc none"
# no-new-privileges only works here if the container stays in dockerd's own
# snap AppArmor profile (no profile transition).
NNP="--security-opt no-new-privileges --security-opt apparmor=snap.docker.dockerd"

run() { # label, then docker run args
  local label=$1; shift
  echo "### $label"
  echo "load: $(cut -d' ' -f1-3 /proc/loadavg)"
  echo "\$ docker run $*"
  timeout 90 docker run "$@" 2>&1 | cat
  echo "exit=${PIPESTATUS[0]}"
  echo
}

echo "image: $IMG  ($(docker run --rm $IMG bun --revision 2>&1 | cat))"
echo

run "a. shadow: hardened (uid 65534)"   --rm --name gwplan-a1 $HARD $MNT $IMG bun hostile.ts shadow
run "a. shadow: control root, default"  --rm --name gwplan-a2 $MNT $IMG bun hostile.ts shadow
run "a. uid_map: container root is host root (no userns-remap)" --rm --name gwplan-a3 $IMG cat /proc/self/uid_map

run "b. network: hardened (--network none)" --rm --name gwplan-b1 $HARD $MNT $IMG bun hostile.ts network
run "b. network: control, default bridge"   --rm --name gwplan-b2 $MNT $IMG bun hostile.ts network

run "c. host: hardened (--network none)" --rm --name gwplan-c1 $HARD $MNT $IMG bun hostile.ts host 172.17.0.1:80 172.17.0.1:57621 172.17.0.1:5432 172.17.0.2:5432 172.17.0.3:27017
run "c. host: control, default bridge"   --rm --name gwplan-c2 $MNT $IMG bun hostile.ts host 172.17.0.1:80 172.17.0.1:57621 172.17.0.1:5432 172.17.0.2:5432 172.17.0.3:27017

echo "### d. forkbomb: hardened (--pids-limit 64)"
echo "host load before: $(cat /proc/loadavg)"
t0=$(date +%s.%N)
run "d1" --rm --name gwplan-d1 $HARD $MNT $IMG bun hostile.ts forkbomb
echo "elapsed: $(echo "$(date +%s.%N) - $t0" | bc) s; host load after: $(cat /proc/loadavg)"
run "d. forkbomb: control (--pids-limit 512, otherwise hardened)" --rm --name gwplan-d2 ${HARD/--pids-limit 64/--pids-limit 512} $MNT $IMG bun hostile.ts forkbomb
echo "host load after control: $(cat /proc/loadavg)"
echo

for spec in "e1:--memory 128m --memory-swap 128m:1024" "e2:--memory 512m --memory-swap 512m:256"; do
  IFS=: read -r name mem cap <<<"$spec"
  base=${HARD/--memory 128m --memory-swap 128m/$mem}
  echo "### e. memhog $name ($mem, allocate up to ${cap}MB)"
  echo "load: $(cut -d' ' -f1-3 /proc/loadavg)"
  echo "\$ docker run --name gwplan-$name $base $MNT $IMG bun hostile.ts memhog $cap"
  timeout 90 docker run --name gwplan-$name $base $MNT $IMG bun hostile.ts memhog "$cap" 2>&1 | tail -3 | cat
  echo "inspect: $(docker inspect -f 'ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}}' gwplan-$name | cat)"
  docker rm -f gwplan-$name >/dev/null 2>&1
  echo
done

run "f. read-only root: hardened"               --rm --name gwplan-f1 $HARD $MNT $IMG bun hostile.ts rofs
run "f. read-only root: control root, writable" --rm --name gwplan-f2 $MNT $IMG bun hostile.ts rofs
run "f. tmpfs 16m noexec: hardened, write 32MB" --rm --name gwplan-f3 $HARD $MNT $IMG bun hostile.ts tmpfs /tmp/fill 32
run "f. tmpfs control: size=64m, exec (Docker tmpfs defaults to noexec)"  --rm --name gwplan-f4 ${HARD/\/tmp:rw,noexec,nosuid,size=16m//tmp:rw,exec,size=64m} $MNT $IMG bun hostile.ts tmpfs /tmp/fill 32

export SECRET_PROBE=host-secret-value
run "g. env: hardened, -e FOO=bar only (SECRET_PROBE is exported on host)" --rm --name gwplan-g1 $HARD -e FOO=bar $MNT $IMG bun hostile.ts env
run "g. env: -e SECRET_PROBE (name only) copies the host value"              --rm --name gwplan-g2 $HARD -e SECRET_PROBE $MNT $IMG bun hostile.ts env
printf 'SECRET_PROBE=from-env-file\n' > gwplan-envfile.tmp
run "g. env: --env-file passes every line of the file"                      --rm --name gwplan-g3 $HARD --env-file gwplan-envfile.tmp $MNT $IMG bun hostile.ts env
rm -f gwplan-envfile.tmp
unset SECRET_PROBE

run "h. caps: hardened (65534, cap-drop ALL)"       --rm --name gwplan-h1 $HARD $MNT $IMG bun hostile.ts caps
run "h. caps: control root, default caps"           --rm --name gwplan-h2 --tmpfs /tmp $MNT $IMG bun hostile.ts caps
run "h. caps: root with --cap-drop=ALL"             --rm --name gwplan-h3 --cap-drop=ALL --tmpfs /tmp $MNT $IMG bun hostile.ts caps
run "h. NNP: hardened + no-new-privileges (snap AppArmor profile kept)" --rm --name gwplan-h4 $HARD $NNP $MNT $IMG bun hostile.ts caps
run "h. NNP with default AppArmor transition (fails on snap Docker)"   --rm --name gwplan-h5 --security-opt no-new-privileges $IMG true

run "i. docker socket: hardened, not mounted" --rm --name gwplan-i1 $HARD $MNT $IMG bun hostile.ts dockersock

run "j. cpu: hardened (--cpus 0.5)"  --rm --name gwplan-j1 $HARD $MNT $IMG bun hostile.ts cpu 300000000
run "j. cpu: control (no --cpus)"    --rm --name gwplan-j2 ${HARD/--cpus 0.5/} $MNT $IMG bun hostile.ts cpu 300000000

run "k. disk: --storage-opt size=64m" --rm --name gwplan-k1 --storage-opt size=64m $IMG true

docker rm -f $(docker ps -aq --filter name=gwplan-) >/dev/null 2>&1 || true
echo "done; leftover gwplan containers: $(docker ps -aq --filter name=gwplan- | wc -l)"
