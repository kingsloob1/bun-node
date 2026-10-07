#!/bin/bash
# bun-node-heavy-queue: list every job holding or waiting for the heavy-run
# slots, with how long it has waited or run, and the Claude session it
# belongs to.
#
#   /tmp/claude-1000/bun-node-heavy-queue.sh
#
# Sessions are named from /tmp/claude-1000/bun-node-sessions (lines of
# `<claude pid> <name>`); a job whose ancestors include none of them is
# "detached" (started by a script that outlived its session, or by hand).
#
# STATE is the phase each wrapper records in bun-node-heavy-jobs/pid-<pid>.state;
# for a wrapper that records none (an older copy still running) it is guessed
# from the wrapper's child processes. A state file whose wrapper is gone is
# ignored and deleted.
#
# EST is the median duration of the last 10 successful runs (exit 0) of the
# same kind of job, from bun-node-heavy-history.tsv, which the wrapper appends
# to as each job ends; the kind is the key `bun-node-heavy-run.sh --key` prints.
# A running job also shows what is left of it, or how far past the median it
# is. With no successful run on record it reads "unknown".
#
#   HEAVY_DIR      where the locks live (default /tmp/claude-1000; for tests)
#   HEAVY_WRAPPER  the wrapper whose jobs to list (default $HEAVY_DIR/bun-node-heavy-run.sh)
set -u
DIR=${HEAVY_DIR:-/tmp/claude-1000}
WRAPPER=${HEAVY_WRAPPER:-$DIR/bun-node-heavy-run.sh}
JOBS="$DIR/bun-node-heavy-jobs"
HISTORY="$DIR/bun-node-heavy-history.tsv"
declare -A NAME=()
if [ -f "$DIR/bun-node-sessions" ]; then
  while read -r pid name; do [ -n "${pid:-}" ] && NAME[$pid]=$name; done <"$DIR/bun-node-sessions"
fi

owner() {
  local p=$1
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    if [ -n "${NAME[$p]:-}" ]; then echo "${NAME[$p]}"; return; fi
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  echo "detached"
}
mins() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }
where() { readlink "/proc/$1/cwd" 2>/dev/null | sed 's|^/home/[^/]*/Desktop/projects/mine/||'; }
envof() { tr '\0' '\n' <"/proc/$1/environ" 2>/dev/null | sed -n "s/^$2=//p"; }
printf -v now '%(%s)T' -1

# The key of a process's job, asked of the wrapper itself so it is computed in
# one place: in the process's directory, with its HEAVY_EXCLUSIVE and
# EXAMPLE_DRIVER. Arguments after the first <skip> of its command line.
keyof() {
  local pid=$1 skip=$2 excl=${3:-} cwd args=()
  grep -q '^heavy_key()' "$WRAPPER" 2>/dev/null || return 0
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || return 0
  mapfile -d '' args <"/proc/$pid/cmdline" 2>/dev/null || return 0
  [ "${#args[@]}" -gt "$skip" ] || return 0
  (cd "$cwd" 2>/dev/null && HEAVY_EXCLUSIVE="$excl" EXAMPLE_DRIVER="$(envof "$pid" EXAMPLE_DRIVER)" \
    bash "$WRAPPER" --key "${args[@]:$skip}" 2>/dev/null)
}
# How long a key's job normally takes: "~6m10s (n=4)", or for a job running
# for <ran> seconds "~6m10s, ~2m left" or "~6m10s, overrun +1m".
roughly() { if [ "$1" -lt 60 ]; then echo "${1}s"; else echo "$((($1 + 30) / 60))m"; fi; }
estimate() {
  local key=$1 ran=${2:-} med n
  read -r med n < <([ -n "$key" ] && [ -f "$HISTORY" ] &&
    K=$key awk -F'\t' '$2 == ENVIRON["K"] && $4 == "0" { print $3 }' "$HISTORY" | tail -n 10 | sort -n |
    awk '{ v[NR] = $1 } END { if (NR) print (NR % 2 ? v[(NR + 1) / 2] : int((v[NR / 2] + v[NR / 2 + 1]) / 2)), NR }')
  if [ -z "${med:-}" ]; then echo unknown; return; fi
  if [ -z "$ran" ]; then echo "~$(mins "$med") (n=$n)"
  elif [ "$ran" -le "$med" ]; then echo "~$(mins "$med"), ~$(roughly $((med - ran))) left"
  else echo "~$(mins "$med"), overrun +$(roughly $((ran - med)))"
  fi
}

# A wrapper that died without its exit trap leaves its state file behind.
for f in "$JOBS"/pid-*.state "$JOBS"/pid-*.state.tmp; do
  [ -e "$f" ] || continue
  p=${f##*/pid-}; p=${p%%.*}
  [ -e "/proc/$p" ] || rm -f "$f"
done

rows=()
# Wrapper jobs: what each is doing, read from its children.
for w in $(ps -eo pid=,args= | awk -v h="$WRAPPER" '$3 == h { print $1 }'); do
  wdir=$(envof "$w" HEAVY_DIR)
  [ "${wdir:-/tmp/claude-1000}" = "$DIR" ] || continue
  age=$(ps -o etimes= -p "$w" | tr -d ' ')
  [ -n "$age" ] || continue
  kids=$(ps -o pid=,args= --ppid "$w")
  cmd=$(ps -o args= -p "$w" | sed "s|^[^ ]* $WRAPPER ||" | cut -c1-60)
  ticket=$(envof "$w" HEAVY_TICKET)
  excl=$(envof "$w" HEAVY_EXCLUSIVE)
  # Its own record of its phase, unless that is older than the wrapper: then
  # it belongs to an earlier process with the same pid.
  phase="" since=""
  [ -f "$JOBS/pid-$w.state" ] && read -r phase since _ <"$JOBS/pid-$w.state"
  if [ -n "$phase" ] && ! [ "${since:-0}" -ge $((now - age - 1)) ] 2>/dev/null; then phase=""; fi
  ran=""
  if [ -n "$phase" ]; then
    case "$phase" in
      running) ran=$((now - since)); [ "$ran" -le "$age" ] || ran=$age; [ "$ran" -ge 0 ] || ran=0 ;;
      head) state="waiting $(mins "$age"), head of the line" ;;
      in-line) state="waiting $(mins "$age"), in line" ;;
      stepping-back) state="waiting $(mins "$age"), stepping back for ordinary jobs" ;;
      waiting-reserve) state="waiting $(mins "$age"), for the reserve" ;;
      waiting-slots) state="waiting $(mins "$age"), for slots" ;;
      attached) state="waiting $(mins "$age"), attached to its ticket" ;;
      *) state="waiting $(mins "$age"), $phase" ;;
    esac
  else
    job=$(echo "$kids" | awk '$2 != "flock" && !($2 == "sleep" && $3 == "2") && NF { print $1; exit }')
    if [ -n "$job" ]; then
      ran=$(ps -o etimes= -p "$job" | tr -d ' ')
    else
      case "$kids" in
        *"sleep 2"*) state="waiting $(mins "$age"), head of the line" ;;
        *turnstile*) state="waiting $(mins "$age"), in line" ;;
        *heavy-jobs*) state="waiting $(mins "$age"), attached to its ticket" ;;
        *flock*) state="waiting $(mins "$age"), for slots" ;;
        *) state="waiting $(mins "$age")" ;;
      esac
    fi
  fi
  if [ -n "$ran" ]; then
    state="RUNNING $(mins "$ran") (waited $(mins $((age - ran))))"; key=$((100000 + ran))
  else
    key=$age
  fi
  est=$(estimate "$(keyof "$w" 2 "$excl")" "$ran")
  [ "$excl" = 1 ] && state="$state [exclusive]"
  rows+=("$key|$state|$est|$(owner "$w")|${ticket:--}|$(where "$w")|$cmd")
done
# Plain `flock` jobs on the old lock file (slot 1), not started by the wrapper.
for p in $(lslocks -n -o PID,PATH 2>/dev/null | awk -v f="$DIR/bun-node-heavy.lock" '$2 == f { print $1 }' | sort -u); do
  [ "$(ps -o comm= -p "$p" 2>/dev/null)" = flock ] || continue
  parent=$(ps -o ppid= -p "$p" | tr -d ' ')
  [ "$(ps -o args= -p "$parent" | awk '{ print $2 }')" = "$WRAPPER" ] && continue
  age=$(ps -o etimes= -p "$p" | tr -d ' ')
  kid=$(pgrep -P "$p" | head -1)
  ran=""
  if [ -n "$kid" ]; then
    ran=$(ps -o etimes= -p "$kid" | tr -d ' ')
    state="RUNNING $(mins "$ran") (waited $(mins $((age - ran)))), plain flock"; key=$((100000 + ran))
  else
    state="waiting $(mins "$age"), plain flock on slot 1"; key=$age
  fi
  cmd=$(ps -o args= -p "$p" | sed 's|^flock [^ ]* ||' | cut -c1-60)
  # `flock [options] <file> <command...>`: the command starts after the file.
  skip=1
  while read -r a; do
    skip=$((skip + 1))
    case "$a" in -w | -E | --timeout | --conflict-exit-code) read -r _; skip=$((skip + 1)) ;; -*) ;; *) break ;; esac
  done < <(tr '\0' '\n' <"/proc/$p/cmdline" 2>/dev/null | tail -n +2)
  est=$(estimate "$(keyof "$p" "$skip")" "$ran")
  rows+=("$key|$state|$est|$(owner "$p")|-|$(where "$p")|$cmd")
done

if [ ${#rows[@]} -eq 0 ]; then
  echo "Nothing holds or waits for the heavy-run slots."
else
  {
    echo "STATE|EST|SESSION|TICKET|WORKTREE|COMMAND"
    printf '%s\n' "${rows[@]}" | sort -t'|' -k1,1nr | cut -d'|' -f2-
  } | column -t -s'|'
fi
echo
echo "load $(cut -d' ' -f1-3 /proc/loadavg)   streak $(cat "$DIR/bun-node-heavy.streak" 2>/dev/null || echo 0)"
