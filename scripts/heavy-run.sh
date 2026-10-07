#!/bin/bash
# bun-node-heavy-run: run a heavy job in one of a few machine-wide slots.
#
#   /tmp/claude-1000/bun-node-heavy-run.sh <command> [args...]
#   HEAVY_EXCLUSIVE=1 /tmp/claude-1000/bun-node-heavy-run.sh <command> [args...]
#
# Slot 1 is the original single lock (/tmp/claude-1000/bun-node-heavy.lock), so
# jobs still queued with a plain `flock` on it share slot 1 with this script.
# Slots 2..N open only while the 1-minute load is under HEAVY_MAX_LOAD, so two
# heavy jobs run together on an idle machine and one at a time on a busy one.
#
# HEAVY_EXCLUSIVE=1 runs the job alone: it takes every slot, in order, and
# holds a reserve lock while it waits so ordinary jobs stop taking the slots it
# still needs. Use it for a bun-jobs suite WITH database URLs (the full suite,
# its --randomize run, multi-file DB runs): those share five servers and assert
# on durations, and were measured clean only one at a time.
#
# Exclusive jobs cannot starve ordinary ones: ordinary jobs hold a shared
# "waiting" lock while they wait, and once HEAVY_EXCLUSIVE_STREAK exclusive
# jobs (default 1) have started since the last ordinary one, the next
# exclusive job steps back until an ordinary job has started. A waiter that
# dies drops its lock with it, so nothing stale can hold the queue.
#
# Waiting costs nothing: an ordinary job waits blocked in the kernel on a
# turnstile lock, not polling. Only the job at the head of the line holds the
# turnstile and tries the slots; the moment it gets one it lets the turnstile
# go, and the kernel wakes the next waiter. Run the wrapper in the background
# and let its exit tell you it finished: there is nothing to check meanwhile.
#
# HEAVY_TICKET=<name> survives the caller: an agent stopped by a usage limit
# runs the same command with the same ticket again and gets its job back, not
# a new place at the back of the line. While the ticketed job is queued or
# running, the second call attaches to it (blocked in the kernel) and exits
# with its exit status; once it has finished, the call returns that status at
# once without running anything (HEAVY_RERUN=1 runs it again; a different
# command or directory under the same ticket also runs fresh). If the job died
# without a result, the next call runs it. Its state is in
# $DIR/bun-node-heavy-jobs/<ticket>.status: queued, running, done or gave-up.
#
# Every job that runs appends one line to $DIR/bun-node-heavy-history.tsv when
# it ends: <epoch> <key> <seconds> <exit status>, tab-separated, one write per
# line so concurrent jobs never interleave. The key names the kind of job
# across worktrees: the directory relative to its git top level (the cwd's
# basename outside a repo), the command without a leading `timeout N`, then
# [exclusive] and [EXAMPLE_DRIVER=...] when they apply. `heavy-run.sh --key
# <command...>` prints the key for the cwd and environment and runs nothing;
# the queue script asks it, so the key is computed in this one place.
#
# Each wrapper records what it is doing in $DIR/bun-node-heavy-jobs/pid-<pid>.state
# (<phase> <epoch>, replaced whole, removed on exit) for the queue script:
# in-line, head, stepping-back, waiting-reserve, waiting-slots, attached or
# running. The queue ignores the file of a wrapper that died without removing it.
#
# The source of these scripts is the bun-node repository (scripts/heavy-run.sh
# and scripts/heavy-queue.sh), and `bun scripts/install-heavy-run.ts` installs
# them here: change them there and reinstall, never edit the installed copy.
#
#   HEAVY_EXCLUSIVE  1 to run alone (default: share)
#   HEAVY_EXCLUSIVE_STREAK  exclusive jobs in a row while ordinary ones wait (1)
#   HEAVY_SLOTS      how many slots (default 2)
#   HEAVY_MAX_LOAD   load under which slots 2..N admit a job (default: cores)
#   HEAVY_WAIT       seconds to wait before giving up (default 5400)
#   HEAVY_DIR        where the locks live (default /tmp/claude-1000; for tests)
#   HEAVY_TICKET     a name for this job (letters, digits, . _ -), see above
#   HEAVY_RERUN      1 to run a ticket whose job already finished, again
#
# The command's exit status is passed through, whatever it is. Giving up on the
# wait exits 75 after a message on stderr. Wrap the heavy command itself, not a
# whole script that also installs, sleeps or runs single files. Never use
# `flock -o` with these locks: on util-linux here it drops the lock while the
# command runs.
set -u

# The key of a job (see the header): one line, no tabs, so it fits one field
# of the history file.
heavy_key() {
  local top rel here cmd
  here=$(pwd -P)
  if top=$(git -C "$here" rev-parse --show-toplevel 2>/dev/null) && [ -n "$top" ]; then
    rel=${here#"$top"}; rel=${rel#/}; [ -n "$rel" ] || rel=.
  else
    rel=$(basename "$here")
  fi
  # A leading `timeout [options] N` is how long the caller allows, not what runs.
  if [ "${1:-}" = timeout ] && [ $# -ge 3 ]; then
    shift
    while [ $# -gt 1 ] && [ "${1#-}" != "$1" ]; do
      case "$1" in
        -k | -s | --kill-after | --signal) shift 2 ;;
        *) shift ;;
      esac
    done
    [ $# -gt 1 ] && shift
  fi
  cmd="$*"
  printf -v cmd '%s: %s' "$rel" "$cmd"
  [ "${HEAVY_EXCLUSIVE:-0}" = 1 ] && cmd="$cmd [exclusive]"
  [ -n "${EXAMPLE_DRIVER:-}" ] && cmd="$cmd [EXAMPLE_DRIVER=$EXAMPLE_DRIVER]"
  cmd=${cmd//$'\t'/ }; cmd=${cmd//$'\n'/ }; cmd=${cmd//$'\r'/ }
  printf '%s\n' "${cmd:0:400}"
}
if [ "${1:-}" = --key ]; then shift; heavy_key "$@"; exit 0; fi

DIR=${HEAVY_DIR:-/tmp/claude-1000}
SLOTS=${HEAVY_SLOTS:-2}
MAX_LOAD=${HEAVY_MAX_LOAD:-$(nproc)}
WAIT=${HEAVY_WAIT:-5400}
EXCLUSIVE=${HEAVY_EXCLUSIVE:-0}
STREAK_MAX=${HEAVY_EXCLUSIVE_STREAK:-1}
GAVE_UP=75
start=$(date +%s)

slot_file() { if [ "$1" -eq 1 ]; then echo "$DIR/bun-node-heavy.lock"; else echo "$DIR/bun-node-heavy.$1.lock"; fi; }
RESERVE="$DIR/bun-node-heavy.reserve.lock"
WAITING="$DIR/bun-node-heavy.waiting.lock"
TURNSTILE="$DIR/bun-node-heavy.turnstile.lock"
STREAK="$DIR/bun-node-heavy.streak"
load_ok() { awk -v max="$MAX_LOAD" '{ exit !($1 < max) }' /proc/loadavg; }
left() { local l=$(( WAIT - ($(date +%s) - start) )); if [ "$l" -gt 0 ]; then echo "$l"; else echo 0; fi; }
give_up() { record gave-up "$GAVE_UP"; echo "bun-node-heavy-run: no slot after ${WAIT}s, giving up" >&2; exit "$GAVE_UP"; }

# Tickets (see the header): the job's state, written whole so a reader never
# sees half a line: <state> <exit status or -> <epoch> <command sum> <pid>.
TICKET=${HEAVY_TICKET:-}
JOBS="$DIR/bun-node-heavy-jobs"
record() {
  [ -n "$TICKET" ] || return 0
  printf '%s %s %s %s %s\n' "$1" "${2:--}" "$(date +%s)" "$CMDSUM" "$$" >"$TSTATUS.tmp.$$"
  mv "$TSTATUS.tmp.$$" "$TSTATUS"
}
# Waits for a lock. The waiting flock is a child process, and must not carry
# the ticket's lock: if this wrapper dies, a child still blocked here would
# otherwise keep the ticket held until it got the lock. Only the job itself
# inherits the ticket, so a ticket is held exactly while its job is alive.
wait_lock() {
  if [ -n "${ticket:-}" ]; then flock "$@" {ticket}>&-; else flock "$@"; fi
}
# Sleeps between tries without holding anything: the sleep is a child too, and
# if this wrapper dies it must not keep the ticket, the turnstile or the
# waiting mark alive for its last two seconds.
nap() { unheld sleep 2; }
# Runs a command as a child that holds none of the ticket, the turnstile and
# the waiting mark, for the same reason.
unheld() {
  local close="" v
  for v in ticket turnstile waiting; do [ -n "${!v:-}" ] && close="$close {$v}>&-"; done
  eval "\"\$@\" $close"
}
# This wrapper's phase, for the queue script (see the header). The file is
# replaced whole, by a rename that holds none of the locks.
mkdir -p "$JOBS"
PSTATE="$JOBS/pid-$$.state"
trap 'unheld rm -f "$PSTATE" "$PSTATE.tmp"' EXIT
phase() {
  local now
  printf -v now '%(%s)T' -1
  printf '%s %s\n' "$1" "$now" 2>/dev/null >"$PSTATE.tmp" && unheld mv -f "$PSTATE.tmp" "$PSTATE" 2>/dev/null
  return 0
}
# The line this job adds to the history when it ends (see the header): built
# first and written with one printf, so it is one append.
HISTORY="$DIR/bun-node-heavy-history.tsv"
history_add() {
  local began=$1 rc=$2 now line
  shift 2
  printf -v now '%(%s)T' -1
  printf -v line '%s\t%s\t%s\t%s\n' "$now" "$(heavy_key "$@")" "$(( now - began ))" "$rc"
  printf '%s' "$line" 2>/dev/null >>"$HISTORY"
  return 0
}
# Runs the command in the slot(s) this job holds, and records how it ended.
run_job() {
  local began
  phase running
  record running "$HEAVY_SLOT"
  printf -v began '%(%s)T' -1
  "$@"
  local rc=$?
  record done "$rc"
  history_add "$began" "$rc" "$@"
  exit "$rc"
}
if [ -n "$TICKET" ]; then
  case "$TICKET" in
    *[!A-Za-z0-9._-]*) echo "bun-node-heavy-run: HEAVY_TICKET may hold only letters, digits and . _ -" >&2; exit 64 ;;
  esac
  TSTATUS="$JOBS/$TICKET.status"
  CMDSUM=$(printf '%s\0' "$PWD" "$@" | sha1sum | cut -c1-12)
  # The live job holding this ticket holds its lock until it ends.
  exec {ticket}>"$JOBS/$TICKET.lock"
  if ! flock -n "$ticket"; then
    echo "bun-node-heavy-run: ticket $TICKET is $(cut -d' ' -f1 "$TSTATUS" 2>/dev/null || echo starting); waiting for it to end" >&2
    phase attached
    flock "$ticket"
    attached=1
  fi
  state=none
  [ -f "$TSTATUS" ] && read -r state code _ sum _ <"$TSTATUS"
  if [ "$state" = done ] && [ "${sum:-}" = "$CMDSUM" ] && { [ "${attached:-0}" = 1 ] || [ "${HEAVY_RERUN:-0}" != 1 ]; }; then
    echo "bun-node-heavy-run: ticket $TICKET finished with exit $code" >&2
    exit "$code"
  fi
  if [ "${attached:-0}" = 1 ] && [ "$state" = gave-up ] && [ "${sum:-}" = "$CMDSUM" ]; then
    echo "bun-node-heavy-run: ticket $TICKET gave up waiting; queuing it again" >&2
  elif [ "${attached:-0}" = 1 ] && [ "$state" != done ]; then
    echo "bun-node-heavy-run: ticket $TICKET ended without a result ($state); running it" >&2
  fi
  record queued
fi

# The streak: exclusive jobs started since the last ordinary one. Updated
# under its own lock, so two writers never interleave.
streak_set() {
  local l
  exec {l}>"$STREAK.lock"; flock "$l"
  case "$1" in
    reset) echo 0 >"$STREAK" ;;
    bump) echo $(( $(cat "$STREAK" 2>/dev/null || echo 0) + 1 )) >"$STREAK" ;;
  esac
  exec {l}>&-
}
streak() { cat "$STREAK" 2>/dev/null || echo 0; }
# Whether an ordinary job is waiting: each holds WAITING shared while it waits.
ordinary_waiting() {
  local probe free=0
  exec {probe}>"$WAITING"
  flock -n -x "$probe" && free=1
  exec {probe}>&-
  [ "$free" -eq 0 ]
}

# One file descriptor per lock, held by this shell. The command inherits them,
# so a child it leaves running keeps the slot until that child exits, as with a
# plain `flock <file> <command>`. Busy is learnt from flock's own status, never
# the command's, so a command exiting 75 is not mistaken for a busy slot.
if [ "$EXCLUSIVE" = 1 ]; then
  exec {reserve}>"$RESERVE"
  while :; do
    phase waiting-reserve
    wait_lock -w "$(left)" "$reserve" || give_up
    # Its turn, unless it would extend a streak past the cap while ordinary
    # jobs wait: then step back until one of them has started.
    if [ "$(streak)" -lt "$STREAK_MAX" ] || ! ordinary_waiting; then break; fi
    flock -u "$reserve"
    [ "$(left)" -eq 0 ] && give_up
    phase stepping-back
    nap
  done
  phase waiting-slots
  for i in $(seq 1 "$SLOTS"); do
    exec {fd}>"$(slot_file "$i")"
    wait_lock -w "$(left)" "$fd" || give_up
  done
  # Every slot is held. Count this start BEFORE letting the reserve go: an
  # exclusive job blocked on the reserve takes it the moment it is released,
  # and must see this start in the streak, or two exclusives chain past the
  # cap while ordinary jobs wait.
  streak_set bump
  exec {reserve}>&-
  export HEAVY_SLOT=all HEAVY_WAITED=$(( $(date +%s) - start ))
  run_job "$@"
fi

reserved() {
  local probe held=1
  exec {probe}>"$RESERVE"
  flock -n "$probe" && held=0
  exec {probe}>&-
  return $(( 1 - held ))
}

# Announce this job as waiting, for the streak cap (see the header).
exec {waiting}>"$WAITING"
flock -s "$waiting"

# Wait in line, blocked in the kernel: only the head of the line goes on.
exec {turnstile}>"$TURNSTILE"
phase in-line
wait_lock -w "$(left)" "$turnstile" || give_up
phase head

while :; do
  # An exclusive job is waiting for the slots: leave every one to it.
  for i in $(reserved && echo || seq 1 "$SLOTS"); do
    if [ "$i" -gt 1 ]; then load_ok || continue; fi
    exec {fd}>"$(slot_file "$i")"
    if flock -n "$fd"; then
      # A slot is ours: let the next waiter up to the head of the line.
      exec {turnstile}>&-
      exec {waiting}>&-
      streak_set reset
      export HEAVY_SLOT=$i HEAVY_WAITED=$(( $(date +%s) - start ))
      run_job "$@"
    fi
    exec {fd}>&-
  done
  [ "$(left)" -eq 0 ] && give_up
  nap
done
