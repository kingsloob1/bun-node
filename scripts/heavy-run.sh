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
# still needs. Use it for bun-jobs' full suite WITH database URLs and its
# --randomize run, nothing else: those share five servers and assert on
# durations, and were measured clean only one at a time. Targeted runs (named
# files, directories or filters, with or without database URLs) are not heavy
# and run directly, without this wrapper (the user's ruling, 2026-10-07).
#
# HEAVY_MODE chooses how a job runs: slot (as above), exclusive (the same as
# HEAVY_EXCLUSIVE=1), direct (at once, holding no slot) or auto, the default,
# which decides from the job's own history (below): the median wall time and
# cores of the last 10 successful runs of its key.
#   - no history, or none that recorded CPU: a slot, the conservative choice;
#   - median cores at or above HEAVY_EXCLUSIVE_CORES (75% of the cores):
#     exclusive, since it takes the machine anyway;
#   - median under HEAVY_DIRECT_SECONDS (60) AND under HEAVY_DIRECT_CORES (2):
#     direct, since a short light job is not worth a place in the line;
#   - otherwise a slot, or direct when no slot is free but the job fits: the
#     head of the line goes direct when the 1-minute load, plus the cores of
#     jobs started in the last minute (which the load does not show yet), plus
#     its own median cores is under HEAVY_MAX_LOAD, and no exclusive job is
#     waiting or running.
# HEAVY_EXCLUSIVE=1 and an explicit HEAVY_MODE always win over history. CPU
# history cannot see a shared database server, so bun-jobs' DB suite must still
# be marked HEAVY_EXCLUSIVE=1. A direct job keeps its ticket, records its
# history and is listed by the queue; it runs with HEAVY_SLOT=direct. The
# decision is printed to stderr in one line as the wrapper starts.
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
# it ends, tab-separated, one write per line so concurrent jobs never
# interleave:
#   <epoch> <key> <seconds> <exit status> <cpu seconds> <cores> <load at start>
#   <load at end> <where: direct, 1..N or all> <mode asked: auto, slot, ...>
# Lines from before 2026-10-07 have the first four fields only, and stay valid.
# CPU seconds are the user+sys time of the job's process tree (the children's
# times in /proc/$$/stat, read before and after it), which counts every process
# the job waited for; cores is that over the wall time (at least 1 s, so a
# job of a few milliseconds does not read as several cores). The key names
# the kind of job across worktrees: the directory relative to its git top
# level (the cwd's basename outside a repo), the command without a leading
# `timeout N`, then [exclusive] (HEAVY_EXCLUSIVE=1 or HEAVY_MODE=exclusive,
# never an auto decision) and [EXAMPLE_DRIVER=...] when they apply. `heavy-run.sh --key
# <command...>` prints the key for the cwd and environment and runs nothing,
# and `--stats <command...>` prints what its history says: <median seconds>
# <n> <median cores, or -> <n with cores>, or nothing. The queue script asks
# them, so both are computed in this one place.
#
# Each wrapper records what it is doing in $DIR/bun-node-heavy-jobs/pid-<pid>.state
# (<phase> <epoch> <mode> <median cores in hundredths, or ->, replaced whole,
# removed on exit) for the queue script. The phase is in-line, head,
# stepping-back, waiting-reserve, waiting-slots, attached, running or direct;
# the mode is what was asked and, for auto, what it decided: slot, exclusive,
# direct, auto>slot, auto>exclusive or auto>direct. The queue ignores the file
# of a wrapper that died without removing it.
#
# The source of these scripts is the bun-node repository (scripts/heavy-run.sh
# and scripts/heavy-queue.sh), and `bun scripts/install-heavy-run.ts` installs
# them here: change them there and reinstall, never edit the installed copy.
#
#   HEAVY_EXCLUSIVE  1 to run alone (default: share); wins over HEAVY_MODE
#   HEAVY_MODE       auto (default), slot, exclusive or direct, see above
#   HEAVY_DIRECT_SECONDS   auto: median seconds under which a light job runs at once (60)
#   HEAVY_DIRECT_CORES     auto: median cores under which a light job runs at once (2)
#   HEAVY_EXCLUSIVE_CORES  auto: median cores from which a job runs alone (75% of cores)
#   HEAVY_EXCLUSIVE_STREAK  exclusive jobs in a row while ordinary ones wait (1)
#   HEAVY_SLOTS      how many slots (default 2)
#   HEAVY_MAX_LOAD   load under which slots 2..N admit a job, and under which
#                    auto lets a job that fits run at once (default: cores)
#   HEAVY_LOADAVG    the file the load is read from (default /proc/loadavg; for tests)
#   HEAVY_WAIT       seconds to wait before giving up (default 5400)
#   HEAVY_DIR        where the locks live (default /tmp/claude-1000; for tests)
#   HEAVY_TICKET     a name for this job (letters, digits, . _ -), see above
#   HEAVY_RERUN      1 to run a ticket whose job already finished, again
#
# The command's exit status is passed through, whatever it is. Giving up on the
# wait exits 75 after a message on stderr, and an unknown HEAVY_MODE exits 64.
# Wrap the heavy command itself, not a whole script that also installs, sleeps
# or runs single files. Never use `flock -o` with these locks: on util-linux
# here it drops the lock while the command runs.
set -u

DIR=${HEAVY_DIR:-/tmp/claude-1000}
HISTORY="$DIR/bun-node-heavy-history.tsv"

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
  if [ "${HEAVY_EXCLUSIVE:-0}" = 1 ] || [ "${HEAVY_MODE:-}" = exclusive ]; then cmd="$cmd [exclusive]"; fi
  [ -n "${EXAMPLE_DRIVER:-}" ] && cmd="$cmd [EXAMPLE_DRIVER=$EXAMPLE_DRIVER]"
  cmd=${cmd//$'\t'/ }; cmd=${cmd//$'\n'/ }; cmd=${cmd//$'\r'/ }
  printf '%s\n' "${cmd:0:400}"
}
# What the history says of a key (see the header): the last 10 successful runs,
# their median seconds and how many, and the median cores of those that
# recorded them (lines from before CPU was recorded have four fields).
heavy_stats() {
  [ -f "$HISTORY" ] || return 0
  K=$1 awk -F'\t' '
    $2 == ENVIRON["K"] && $4 == "0" { n++; w[n] = $3 + 0; c[n] = (NF >= 6 && $6 != "" ? $6 : "-") }
    function sort(a, len,    i, j, t) {
      for (i = 2; i <= len; i++) { t = a[i]; for (j = i - 1; j >= 1 && a[j] > t; j--) a[j + 1] = a[j]; a[j + 1] = t }
    }
    END {
      if (!n) exit
      for (i = (n > 10 ? n - 9 : 1); i <= n; i++) { ww[++m] = w[i]; if (c[i] != "-") cc[++k] = c[i] + 0 }
      sort(ww, m); sort(cc, k)
      med = m % 2 ? ww[(m + 1) / 2] : int((ww[m / 2] + ww[m / 2 + 1]) / 2)
      cores = k ? sprintf("%.2f", k % 2 ? cc[(k + 1) / 2] : (cc[k / 2] + cc[k / 2 + 1]) / 2) : "-"
      printf "%d %d %s %d\n", med, m, cores, k
    }' "$HISTORY"
}
if [ "${1:-}" = --key ]; then shift; heavy_key "$@"; exit 0; fi
if [ "${1:-}" = --stats ]; then shift; heavy_stats "$(heavy_key "$@")"; exit 0; fi

SLOTS=${HEAVY_SLOTS:-2}
CORES=$(nproc)
MAX_LOAD=${HEAVY_MAX_LOAD:-$CORES}
LOADAVG=${HEAVY_LOADAVG:-/proc/loadavg}
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
# Held shared by every exclusive job from its decision until it exits, so an
# ordinary job can tell one is waiting or running (the reserve is let go once
# an exclusive job holds every slot).
PRESENT="$DIR/bun-node-heavy.exclusive.lock"
load_ok() { awk -v max="$MAX_LOAD" '{ exit !($1 < max) }' "$LOADAVG"; }
left() { local l=$(( WAIT - ($(date +%s) - start) )); if [ "$l" -gt 0 ]; then echo "$l"; else echo 0; fi; }
give_up() { record gave-up "$GAVE_UP"; echo "bun-node-heavy-run: no slot after ${WAIT}s, giving up" >&2; exit "$GAVE_UP"; }
say() { echo "bun-node-heavy-run: $*" >&2; }

# A decimal (the load, a number of cores) in hundredths, into the variable $1,
# without forking and whatever the locale: "6.5" is 650, "12" is 1200.
centi() {
  local v=${2:-0} i f
  [[ $v =~ ^([0-9]*)(\.([0-9]*))?$ ]] || v=0
  if [ "$v" = 0 ]; then i=0 f=00; else i=${BASH_REMATCH[1]:-0} f=${BASH_REMATCH[3]:-}00; fi
  printf -v "$1" '%d' $(( 10#$i * 100 + 10#${f:0:2} ))
}
# Hundredths back to a decimal with one place, rounded, for people: 325 is "3.3".
cores_of() { local r=$(( ($1 + 5) / 10 )); printf '%d.%d' $(( r / 10 )) $(( r % 10 )); }
mins() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }

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
# the ticket's lock (or the exclusive mark): if this wrapper dies, a child
# still blocked here would otherwise keep the ticket held until it got the
# lock. Only the job itself inherits them, so a ticket is held exactly while
# its job is alive.
wait_lock() {
  local close="" v
  for v in ticket present; do [ -n "${!v:-}" ] && close="$close {$v}>&-"; done
  eval "flock \"\$@\" $close"
}
# Sleeps between tries without holding anything: the sleep is a child too, and
# if this wrapper dies it must not keep the ticket, the turnstile or the
# waiting mark alive for its last two seconds.
nap() { unheld sleep 2; }
# Runs a command as a child that holds none of the ticket, the turnstile, the
# waiting mark and the exclusive mark, for the same reason.
unheld() {
  local close="" v
  for v in ticket turnstile waiting present; do [ -n "${!v:-}" ] && close="$close {$v}>&-"; done
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
  printf '%s %s %s %s\n' "$1" "$now" "${TAG:-}" "${MED_CORES:--}" 2>/dev/null >"$PSTATE.tmp" &&
    unheld mv -f "$PSTATE.tmp" "$PSTATE" 2>/dev/null
  return 0
}

# How this job runs (see the header): MODE is slot, exclusive or direct; ASKED
# is what the caller asked for; WHY says why, for the line on stderr; TAG goes
# in the state file; MED_CORES is the median cores in hundredths, or -.
ASKED=${HEAVY_MODE:-auto}
case "$ASKED" in
  auto | slot | exclusive | direct) ;;
  *) say "HEAVY_MODE must be auto, slot, exclusive or direct, not '$ASKED'"; exit 64 ;;
esac
MED_CORES=- WHY=""
if [ "$EXCLUSIVE" = 1 ]; then
  ASKED=exclusive MODE=exclusive WHY="HEAVY_EXCLUSIVE=1"
elif [ "$ASKED" != auto ]; then
  MODE=$ASKED WHY="HEAVY_MODE=$ASKED"
else
  read -r med n cores ncores < <(heavy_stats "$(heavy_key "$@")")
  if [ -z "${med:-}" ]; then
    MODE=slot WHY="no history"
  elif [ "${ncores:-0}" -eq 0 ]; then
    MODE=slot WHY="median $(mins "$med"), no CPU on record, n=$n"
  else
    centi MED_CORES "$cores"
    WHY="median $(mins "$med"), $(cores_of "$MED_CORES") cores, n=$n"
    centi excl_c "${HEAVY_EXCLUSIVE_CORES:-0}"
    [ -n "${HEAVY_EXCLUSIVE_CORES:-}" ] || excl_c=$(( CORES * 75 ))
    centi direct_c "${HEAVY_DIRECT_CORES:-2}"
    # Machine-wide is asked first: if the thresholds were set to overlap, the
    # safer answer wins.
    if [ "$MED_CORES" -ge "$excl_c" ]; then MODE=exclusive
    elif [ "$med" -lt "${HEAVY_DIRECT_SECONDS:-60}" ] && [ "$MED_CORES" -lt "$direct_c" ]; then MODE=direct
    else MODE=slot
    fi
  fi
fi
if [ "$ASKED" = auto ]; then TAG="auto>$MODE"; else TAG=$MODE; fi
[ "$MODE" = exclusive ] && EXCLUSIVE=1

# The line this job adds to the history when it ends (see the header): built
# first and written with one printf, so it is one append.
history_add() {
  local began=$1 rc=$2 ticks=$3 us=$4 l0=$5 l1=$6 now tck cpu cores line
  shift 6
  printf -v now '%(%s)T' -1
  tck=$(getconf CLK_TCK 2>/dev/null) || tck=100
  [ "${tck:-0}" -gt 0 ] 2>/dev/null || tck=100
  # A job shorter than a second counts as lasting one: over a few
  # milliseconds, a few ticks of CPU would read as several cores.
  [ "$us" -ge 1000000 ] || us=1000000
  cpu=$(( ticks * 100 / tck ))
  cores=$(( ticks * 100000000 / (tck * us) ))
  printf -v line '%s\t%s\t%s\t%s\t%d.%02d\t%d.%02d\t%s\t%s\t%s\t%s\n' "$now" "$(heavy_key "$@")" \
    "$(( now - began ))" "$rc" $(( cpu / 100 )) $(( cpu % 100 )) $(( cores / 100 )) $(( cores % 100 )) \
    "$l0" "$l1" "$HEAVY_SLOT" "$ASKED"
  printf '%s' "$line" 2>/dev/null >>"$HISTORY"
  return 0
}
# The CPU ticks (user + sys) of this shell's children that it has waited for:
# fields 16 and 17 of /proc/$$/stat, counted after the command name, which may
# hold spaces. Into REPLY, without forking.
child_ticks() {
  local s f
  REPLY=0
  read -r s <"/proc/$$/stat" 2>/dev/null || return 0
  s=${s##*) }
  read -r -a f <<<"$s"
  REPLY=$(( ${f[13]:-0} + ${f[14]:-0} ))
}
# Runs the command in the slot(s) this job holds, or none (phase $1, running
# or direct), and records how it ended and what it used.
run_job() {
  local began c0 c1 t0 t1 l0 l1 rc ran=$1
  shift
  # The ticket first, so whoever sees the phase sees the ticket running too.
  record running "$HEAVY_SLOT"
  phase "$ran"
  printf -v began '%(%s)T' -1
  read -r l0 _ <"$LOADAVG"
  child_ticks; c0=$REPLY
  t0=${EPOCHREALTIME//[!0-9]/}
  "$@"
  rc=$?
  t1=${EPOCHREALTIME//[!0-9]/}
  child_ticks; c1=$REPLY
  read -r l1 _ <"$LOADAVG"
  record done "$rc"
  history_add "$began" "$rc" $(( c1 - c0 )) $(( 10#$t1 - 10#$t0 )) "${l0:--}" "${l1:--}" "$@"
  exit "$rc"
}
if [ -n "$TICKET" ]; then
  case "$TICKET" in
    *[!A-Za-z0-9._-]*) say "HEAVY_TICKET may hold only letters, digits and . _ -"; exit 64 ;;
  esac
  TSTATUS="$JOBS/$TICKET.status"
  CMDSUM=$(printf '%s\0' "$PWD" "$@" | sha1sum | cut -c1-12)
  # The live job holding this ticket holds its lock until it ends.
  exec {ticket}>"$JOBS/$TICKET.lock"
  if ! flock -n "$ticket"; then
    say "ticket $TICKET is $(cut -d' ' -f1 "$TSTATUS" 2>/dev/null || echo starting); waiting for it to end"
    phase attached
    flock "$ticket"
    attached=1
  fi
  state=none
  [ -f "$TSTATUS" ] && read -r state code _ sum _ <"$TSTATUS"
  if [ "$state" = done ] && [ "${sum:-}" = "$CMDSUM" ] && { [ "${attached:-0}" = 1 ] || [ "${HEAVY_RERUN:-0}" != 1 ]; }; then
    say "ticket $TICKET finished with exit $code"
    exit "$code"
  fi
  if [ "${attached:-0}" = 1 ] && [ "$state" = gave-up ] && [ "${sum:-}" = "$CMDSUM" ]; then
    say "ticket $TICKET gave up waiting; queuing it again"
  elif [ "${attached:-0}" = 1 ] && [ "$state" != done ]; then
    say "ticket $TICKET ended without a result ($state); running it"
  fi
  record queued
fi

if [ "$ASKED" = auto ]; then say "auto → $MODE ($WHY)"; else say "$MODE ($WHY)"; fi
if [ "$MODE" = direct ]; then
  export HEAVY_SLOT=direct HEAVY_WAITED=0
  run_job direct "$@"
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
# Whether a lock file is held by anyone: probing takes it briefly.
locked() {
  local probe free=0
  exec {probe}>"$1"
  flock -n -x "$probe" && free=1
  exec {probe}>&-
  [ "$free" -eq 0 ]
}
# Whether an ordinary job is waiting: each holds WAITING shared while it waits.
ordinary_waiting() { locked "$WAITING"; }

# One file descriptor per lock, held by this shell. The command inherits them,
# so a child it leaves running keeps the slot until that child exits, as with a
# plain `flock <file> <command>`. Busy is learnt from flock's own status, never
# the command's, so a command exiting 75 is not mistaken for a busy slot.
if [ "$EXCLUSIVE" = 1 ]; then
  exec {present}>"$PRESENT"
  flock -s "$present"
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
  run_job running "$@"
fi

reserved() { locked "$RESERVE"; }

# Whether this job may run at once although no slot is free (auto only, see
# the header): its median cores, the load and the cores of jobs started in the
# last minute, which the 1-minute load does not show yet, fit under
# HEAVY_MAX_LOAD, and no exclusive job is waiting or running. Only the head of
# the line asks, so two jobs never both fit on the same reading: the first
# records itself as direct before it lets the turnstile go.
fits() {
  [ "$ASKED" = auto ] && [ "$MED_CORES" != - ] || return 1
  reserved && return 1
  locked "$PRESENT" && return 1
  local load max recent=0 now f p ph since tag c
  read -r load _ <"$LOADAVG"
  centi load "$load"
  centi max "$MAX_LOAD"
  printf -v now '%(%s)T' -1
  for f in "$JOBS"/pid-*.state; do
    p=${f##*/pid-}; p=${p%.state}
    [ "$p" != $$ ] && [ -e "/proc/$p" ] || continue
    read -r ph since tag c <"$f" 2>/dev/null || continue
    case "$ph" in running | direct) ;; *) continue ;; esac
    [ "${since:-0}" -ge $(( now - 60 )) ] 2>/dev/null || continue
    # A job with no CPU on record counts as four cores, the worker cap of a
    # bun test run here.
    case "${c:-}" in '' | - | *[!0-9]*) c=400 ;; esac
    recent=$(( recent + 10#$c ))
  done
  FIT="load $(cores_of "$load") + $(cores_of "$recent") starting + $(cores_of "$MED_CORES") < $(cores_of "$max")"
  [ $(( load + recent + MED_CORES )) -lt "$max" ]
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
      run_job running "$@"
    fi
    exec {fd}>&-
  done
  if fits; then
    # Recorded as direct before the turnstile goes, so the next head counts it.
    TAG="auto>direct"
    phase direct
    exec {turnstile}>&-
    exec {waiting}>&-
    streak_set reset
    say "auto → direct, no slot free but it fits ($FIT)"
    export HEAVY_SLOT=direct HEAVY_WAITED=$(( $(date +%s) - start ))
    run_job direct "$@"
  fi
  [ "$(left)" -eq 0 ] && give_up
  nap
done
