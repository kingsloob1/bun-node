/**
 * The Lua the Redis driver runs.
 *
 * Redis has no transactions worth the name for this shape of work — `MULTI`
 * cannot branch on what it reads — so every operation that has to decide
 * something (is this job still waiting? does this token still hold the lock?)
 * is a script. A script is the unit of atomicity: Redis runs it start to
 * finish with nothing interleaved, which is exactly the guarantee the driver
 * contract asks for.
 *
 * Each script documents its `KEYS` and `ARGV` because Lua offers no help with
 * either. The driver assembles them in `keys.ts`, and the two must agree.
 */

import { SECOND_BUCKET_MS } from "../../api/contract/constants";
import { JOB_OPTION_BITS } from "../../queue/jobDefaults";
import { THROUGHPUT_BUCKET_MS } from "../readApis";
import { STAMP_FIELD } from "./stamp";

/**
 * The most wake tokens a queue's wake list holds. A batch making more jobs
 * ready than this wakes this many consumers, which is plenty: each claims
 * again as soon as it finishes a job.
 */
export const WAKE_TOKENS_MAX = 100;

/**
 * How many entries past a count cap one settle removes, at most — see
 * `retain`.
 */
export const RETAIN_CAP_BATCH = 100;

/** How many pending entries one {@link CLEAN} call examines, at most. */
export const CLEAN_SCAN_BUDGET = 1000;

/** How many entries {@link CLEAN} reads per `ZRANGE` inside one call. */
const CLEAN_PAGE = 250;

/** How many pending jobs one {@link DRAIN} call removes, at most. */
export const DRAIN_BATCH = 1000;

/** The keys every queue script receives, in order. */
export const QUEUE_KEYS = [
  "wait",
  "delayed",
  "failed",
  "active",
  "completed",
  "dead",
  "meta",
  "seq",
  "wake",
  "children",
] as const;

/**
 * A job's fields, in the order the add scripts send their values.
 *
 * The wire carries **values only**. Sending `name, value` pairs meant 22 ARGV
 * entries per job where 10 will do, and every ARGV entry is an independent
 * string for the Lua VM to intern — measured against bee-queue, whose script
 * takes two. The names come from {@link JOB_FIELDS_LUA} instead, a constant
 * table interned once when the script is cached rather than once per job.
 *
 * `blob` is `name`, `maxAttempts`, `opts` and `data` in one JSON value, in
 * that order. The scripts that read inside it never re-encode it: the claim's
 * name exclusion and `FIND_JOBS` cut the leading `name` literal out, and
 * {@link UPDATE_JOB} and {@link REWRITE_PENDING} decode the head up to the end
 * of `opts` — which is why `opts` comes before `data`: a large payload is
 * never parsed to read a job's options (see `JOB_HEAD_PRELUDE`). Storing the
 * four apart bought nothing. Storing them together takes a
 * brand-new job's `HSET` from ten fields to seven, which is worth 83,525/s
 * against 109,828/s on 5,000 jobs: the cost of that statement is dominated by
 * how many fields it names. The exceptions are {@link UPDATE_JOB}, which
 * never touches `blob` but writes `data`, `optsPriority` and `xmask` beside
 * it — see there for why — and {@link REWRITE_PENDING}, which writes
 * `o:<option>` fields beside it the same way; `#toRecord` lets each win over
 * the blob's copy.
 *
 * **The first {@link FRESH_JOB_FIELD_COUNT} are exactly what a brand-new job
 * carries**, which is why they lead. That makes the fresh set a prefix of the
 * full one, so a job says how many values follow and the script needs one name
 * table rather than two — and `state`, `priority` and `runAt` sit at fixed
 * positions both shapes share, so the script reads them straight from ARGV
 * instead of asking Redis for what it just wrote.
 *
 * The driver builds values in this order and the Lua table is generated from
 * it, so the two cannot drift.
 */
export const JOB_FIELDS = [
  // The brand-new prefix. Do not reorder without regenerating: the add scripts
  // read these positions directly, through the `AT` map below.
  "id",
  "state",
  "priority",
  "runAt",
  "createdAt",
  "blob",
  // Everything a job only acquires by running. A fresh job omits all of these
  // and the reader treats absent and default alike.
  "processedOn",
  "finishedOn",
  "expiresAt",
  "attemptsMade",
  "stalledCount",
  "lockToken",
  "lockExpiresAt",
  "workerId",
  "repeatKey",
  "progress",
  "returnValue",
  "failedReason",
  "stacktrace",
  // A job's place in a flow, last so a record in none stops before them. Only
  // the parts that never change after the add live in `flow` (its parent and
  // children, as JSON); the two a script changes are scalars of their own, so
  // no script ever re-encodes JSON — see `RECORD_CHILD` for why that matters.
  "flow",
  "flowPending",
  "flowRecorded",
] as const;

/** How many leading {@link JOB_FIELDS} a brand-new job carries. */
export const FRESH_JOB_FIELD_COUNT = 6;

/**
 * The hash field prefix a completed child's value is stored under, followed
 * by the child's `queue:id` key. One field per child, holding the JSON the
 * driver encoded, untouched.
 */
export const FLOW_VALUE_PREFIX = "flow:v:";

/** The hash field prefix an ignored child failure is stored under. */
export const FLOW_FAILURE_PREFIX = "flow:f:";

/** {@link JOB_FIELDS} as a Lua table literal, so the two cannot disagree. */
const JOB_FIELDS_LUA = `{ ${JOB_FIELDS.map((field) => `'${field}'`).join(", ")} }`;

/**
 * Where the fields the add scripts read by position sit in {@link JOB_FIELDS}.
 *
 * Lua indexes from one. Generated rather than written out, so reordering
 * {@link JOB_FIELDS} moves these with it.
 */
const AT = Object.fromEntries(
  JOB_FIELDS.map((field, index) => [field, index + 1]),
) as Record<(typeof JOB_FIELDS)[number], number>;

/** The keys every runner script receives, in order. */
export const RUNNER_KEYS = [
  "lock",
  "state",
  "history",
  "queued",
  "runners",
] as const;

/**
 * Shared Lua, prepended to every queue script.
 *
 * `job(id)` builds a job's hash key from the prefix in `ARGV[1]`; with the
 * cluster hash tag that prefix carries, every key a script touches lives in
 * one slot.
 */
const QUEUE_PRELUDE = `
local WAIT, DELAYED, FAILED = KEYS[1], KEYS[2], KEYS[3]
local ACTIVE, COMPLETED, DEAD = KEYS[4], KEYS[5], KEYS[6]
local META, SEQ, WAKE = KEYS[7], KEYS[8], KEYS[9]
local CHILDREN = KEYS[10]
local PREFIX = ARGV[1]

local function job(id) return PREFIX .. id end

-- A job's log list. The prefix is the job prefix with its trailing 'job:'
-- swapped for 'log:', matching \`logPrefix\` in keys.ts, so it keeps the hash
-- tag and lives in the same slot. Built on demand rather than once up front,
-- so the scripts that never delete a job pay nothing for it.
local function logs(id) return string.sub(PREFIX, 1, -5) .. 'log:' .. id end

-- Deletes a job and its log in one call. Every path that removes a job goes
-- through here, because a log must live exactly as long as its job — a job
-- added later under the same id would otherwise inherit the old lines.
local function drop(id) redis.call('DEL', job(id), logs(id)) end

local function member(id)
  -- The ordering key a job was given when it was added. Kept on the hash so
  -- moving a job back into the wait set restores its original place in the
  -- queue rather than sending it to the back.
  local stored = redis.call('HGET', job(id), 'member')
  return stored or id
end

local function state(id) return redis.call('HGET', job(id), 'state') end

-- Whether a job is active under this lock token. One HMGET, not two HGETs.
local function holds(id, token)
  local held = redis.call('HMGET', job(id), 'state', 'lockToken')
  return held[1] == 'active' and held[2] == token
end

-- Announces that n jobs became ready: one token per job, so as many idle
-- consumers wake — in any process — as there is work for. One token for a
-- whole batch woke one consumer fleet-wide and left the rest sleeping out their
-- block. Capped at the list's length, and trimmed only once it is past it, so
-- the usual single token costs one command rather than two.
local function wake(n)
  local length
  if n == nil or n <= 1 then
    length = redis.call('LPUSH', WAKE, '1')
  else
    local tokens = {}
    for i = 1, math.min(n, ${WAKE_TOKENS_MAX}) do tokens[i] = '1' end
    length = redis.call('LPUSH', WAKE, unpack(tokens))
  end
  if length > ${WAKE_TOKENS_MAX} then
    redis.call('LTRIM', WAKE, 0, ${WAKE_TOKENS_MAX - 1})
  end
end

-- An empty wait set means every token left in the wake list announces a job
-- that has already been taken. Dropped, so an idle consumer parks at once
-- rather than spinning through them one empty claim at a time.
local function dropStaleWakes()
  if redis.call('ZCARD', WAIT) == 0 then
    redis.call('DEL', WAKE)
  end
end

-- Whether a job is a flow child whose outcome its parent has not recorded,
-- which no retention may remove. Only a job in a flow has 'flowRecorded' at
-- all, so any other job costs this one field read; the skeleton is read only
-- for a flow job, and holds '"parent":{' exactly when it has a parent.
local function awaitsDelivery(id)
  local fields = redis.call('HMGET', job(id), 'flowRecorded', 'flow')
  if fields[1] ~= '0' then
    return false
  end
  return fields[2] ~= false and string.find(fields[2], '"parent":{', 1, true) ~= nil
end

local function retain(id, set, mode, count, ttl, now)
  -- mode: 'remove' deletes now, 'keep' keeps everything, 'cap' keeps a number.
  if mode == 'remove' then
    redis.call('ZREM', set, id)
    drop(id)
    return
  end

  if ttl and tonumber(ttl) > 0 then
    redis.call('HSET', job(id), 'expiresAt', tostring(tonumber(now) + tonumber(ttl)))
  end

  if mode == 'cap' then
    local keep = tonumber(count)
    -- At most ${RETAIN_CAP_BATCH} past the cap per call. Steady state is one; after a cap
    -- is lowered, or behind flow children held for their parent, reading
    -- everything past it made one completion walk the whole set, and every
    -- completion after it walk it again. The excess drains over later calls.
    local stale = redis.call('ZREVRANGE', set, keep, keep + ${RETAIN_CAP_BATCH - 1})
    for _, staleId in ipairs(stale) do
      -- A child whose parent has not taken its outcome yet stays.
      if not awaitsDelivery(staleId) then
        redis.call('ZREM', set, staleId)
        drop(staleId)
      end
    end
  end
end
`;

/**
 * Adds many jobs in one script.
 *
 * `addJobs` was a loop over {@link ADD_JOB}, so 5,000 jobs meant 5,000 round
 * trips — measured, 13,544/s against bee-queue's 95,032/s, which pipelines.
 * One script per chunk is the same work with one trip.
 *
 * Per job ARGV carries a value count and then that many values, in
 * {@link JOB_FIELDS} order; the field *names* come from a constant table in
 * the script. The count is how a fresh job says it stopped at
 * {@link FRESH_JOB_FIELD_COUNT}. The reply is one `0` or `1` per job, in the
 * order they were given, so the caller still learns exactly which ids were new.
 *
 * Nothing here reads back what it just wrote: `state`, `runAt`, `priority` and
 * the timestamps that place a record all sit at known positions in ARGV.
 */
export const ADD_JOBS = `${QUEUE_PRELUDE}
local FIELDS = ${JOB_FIELDS_LUA}
local queue, now = ARGV[2], tonumber(ARGV[3])
local count = tonumber(ARGV[4])
local cursor = 5
local results = {}
local ready = 0

for _ = 1, count do
  -- The values for one job: a count, then that many, in FIELDS order.
  local fieldCount = tonumber(ARGV[cursor])
  local at = cursor
  cursor = at + 1 + fieldCount

  -- Read straight out of ARGV rather than back out of the hash. Placement
  -- follows the record's own state, not its runAt: they usually agree, because
  -- a producer derives one from the other, but a record may arrive already
  -- finished — a migration, a test, a job restored from elsewhere — and it
  -- belongs in the set it says it is in.
  local id = ARGV[at + ${AT.id}]
  local state = ARGV[at + ${AT.state}]
  local priority = tonumber(ARGV[at + ${AT.priority}])
  local runAt = tonumber(ARGV[at + ${AT.runAt}])
  local createdAt = tonumber(ARGV[at + ${AT.createdAt}]) or 0

  -- A value a fresh job never sends, falling back to createdAt the way the
  -- record itself does when the field is absent or empty.
  local function stamp(index)
    local value = index <= fieldCount and ARGV[at + index] or nil
    if value == nil or value == '' then
      return createdAt
    end
    return tonumber(value) or createdAt
  end

  if redis.call('EXISTS', job(id)) == 1 then
    results[#results + 1] = 0
  else
    -- Ordering: the score is the priority, and ties break on the member, which
    -- carries a monotonic sequence. Encoding both in one score would need more
    -- precision than a double has.
    local seq = redis.call('INCR', SEQ)
    local entry = string.format('%016d', seq) .. ':' .. id

    local fields = { 'member', entry }
    for i = 1, math.min(fieldCount, #FIELDS) do
      fields[#fields + 1] = FIELDS[i]
      fields[#fields + 1] = ARGV[at + i]
    end
    -- Past the named fields come name/value pairs: a flow's child outcomes,
    -- whose field names depend on the child.
    for i = #FIELDS + 1, fieldCount, 2 do
      fields[#fields + 1] = ARGV[at + i]
      fields[#fields + 1] = ARGV[at + i + 1]
    end
    redis.call('HSET', job(id), unpack(fields))

    if state == 'delayed' then
      redis.call('ZADD', DELAYED, runAt, id)
    elseif state == 'failed' then
      redis.call('ZADD', FAILED, runAt, id)
    elseif state == 'active' then
      redis.call('ZADD', ACTIVE, stamp(${AT.lockExpiresAt}), id)
    elseif state == 'completed' then
      redis.call('ZADD', COMPLETED, stamp(${AT.finishedOn}), id)
    elseif state == 'dead' then
      redis.call('ZADD', DEAD, stamp(${AT.finishedOn}), id)
    elseif state == 'waiting-children' then
      -- Never in the wait set: a parent runs once RECORD_CHILD releases it.
      redis.call('ZADD', CHILDREN, createdAt, id)
    else
      redis.call('ZADD', WAIT, priority, entry)
      ready = ready + 1
    end

    results[#results + 1] = 1
  end
end

-- One token per job made ready, so as many idle consumers wake.
if ready > 0 then
  wake(ready)
end

return results
`;

/**
 * Adds a job, unless its id is already present.
 *
 * The id is the idempotency key, so the existence check and the write have to
 * be one operation — that is what makes repeat scheduling safe with several
 * workers all noticing the same series at once.
 *
 * ARGV: prefix, queue, now, then a value count and that many values in
 * {@link JOB_FIELDS} order — the same shape {@link ADD_JOBS} takes per job.
 * Returns 1 when it added the job, 0 when the id was already there.
 */
export const ADD_JOB = `${QUEUE_PRELUDE}
local FIELDS = ${JOB_FIELDS_LUA}
local queue, now = ARGV[2], tonumber(ARGV[3])
local fieldCount = tonumber(ARGV[4])
local at = 4

-- Read straight out of ARGV rather than back out of the hash.
local id = ARGV[at + ${AT.id}]
local state = ARGV[at + ${AT.state}]
local priority = tonumber(ARGV[at + ${AT.priority}])
local runAt = tonumber(ARGV[at + ${AT.runAt}])
local createdAt = tonumber(ARGV[at + ${AT.createdAt}]) or 0

-- A value a fresh job never sends, falling back to createdAt the way the
-- record itself does when the field is absent or empty.
local function stamp(index)
  local value = index <= fieldCount and ARGV[at + index] or nil
  if value == nil or value == '' then
    return createdAt
  end
  return tonumber(value) or createdAt
end

if redis.call('EXISTS', job(id)) == 1 then
  return 0
end

-- Ordering: the score is the priority, and ties break on the member, which
-- carries a monotonic sequence. Encoding both in one score would need more
-- precision than a double has.
local seq = redis.call('INCR', SEQ)
local entry = string.format('%016d', seq) .. ':' .. id

local fields = { 'member', entry }
for i = 1, math.min(fieldCount, #FIELDS) do
  fields[#fields + 1] = FIELDS[i]
  fields[#fields + 1] = ARGV[at + i]
end
-- Past the named fields come name/value pairs: a flow's child outcomes, whose
-- field names depend on the child.
for i = #FIELDS + 1, fieldCount, 2 do
  fields[#fields + 1] = ARGV[at + i]
  fields[#fields + 1] = ARGV[at + i + 1]
end
redis.call('HSET', job(id), unpack(fields))

-- Placed by the record's own state, not by its runAt. They usually agree,
-- because a producer derives one from the other, but a record may arrive
-- already finished — a migration, a test, a job restored from elsewhere —
-- and it belongs in the set it says it is in.
if state == 'delayed' then
  redis.call('ZADD', DELAYED, runAt, id)
elseif state == 'failed' then
  redis.call('ZADD', FAILED, runAt, id)
elseif state == 'active' then
  redis.call('ZADD', ACTIVE, stamp(${AT.lockExpiresAt}), id)
elseif state == 'completed' then
  redis.call('ZADD', COMPLETED, stamp(${AT.finishedOn}), id)
elseif state == 'dead' then
  redis.call('ZADD', DEAD, stamp(${AT.finishedOn}), id)
elseif state == 'waiting-children' then
  -- Never in the wait set: a parent runs once RECORD_CHILD releases it.
  redis.call('ZADD', CHILDREN, createdAt, id)
else
  redis.call('ZADD', WAIT, priority, entry)
  wake()
end

return 1
`;

/**
 * How many wait-set entries the continuation scan of a claim that excludes
 * names inspects, at most.
 *
 * Without a bound, a long run of excluded jobs at the head — a capped name
 * that has queued thousands — would make every claim walk all of them inside
 * Redis's single thread. Past this many the claim returns what it found, which
 * may be fewer than asked or nothing at all; the contract allows that, and the
 * worker simply asks again — and because the scan leaves a cursor behind, the
 * next claim looks at the *next* this-many rather than the same ones. Only the
 * exclusion path pays any of this.
 */
export const EXCLUDE_SCAN_LIMIT = 1000;

/**
 * How many entries from the head of the wait set every excluding claim looks
 * at before resuming from its cursor, so a job that arrives at the head is
 * seen on the next claim however deep into a pile the cursor has gone.
 */
export const EXCLUDE_HEAD_WINDOW = 64;

/**
 * The most exclusion signatures one queue keeps a cursor for. Past it the
 * cursor hash is cleared before the next write, so a service whose capped
 * names keep changing cannot grow it without bound.
 */
export const EXCLUDE_CURSOR_MAX_SIGNATURES = 32;

/**
 * How long a queue's exclusion cursors live untouched, in milliseconds. Every
 * write renews it, so a cursor only lapses once nothing has scanned past a
 * pile for this long — and a lapsed one only costs a rescan from the head.
 */
export const EXCLUDE_CURSOR_TTL_MS = 10 * 60 * 1000;

/** The largest page the exclusion scan reads in one `ZRANGE`. */
const EXCLUDE_PAGE_MAX = 256;

/**
 * Shared Lua for the claim scripts: the wait-set heads, in claim order,
 * skipping jobs whose names are excluded.
 *
 * Only ever called when the caller passed names, so a claim without them runs
 * exactly the commands it always did.
 *
 * **Two bounded scans.** A head scan reads the first
 * {@link EXCLUDE_HEAD_WINDOW} entries, so a new job at the head is never
 * missed. If that does not fill the request, a continuation scan reads up to
 * {@link EXCLUDE_SCAN_LIMIT} more, starting where the last claim with the
 * same exclusions stopped. Without it, more than the limit of excluded jobs
 * at the head meant every claim re-read the same entries and returned nothing,
 * starving every other name behind them for as long as the cap held.
 *
 * **The cursor** is one field per exclusion *signature* (the sorted, length
 * prefixed names) in the queue's `exclude` hash — see `excludeCursors` in
 * keys.ts. It holds the score and member of the last entry examined, not a
 * rank, because ranks shift as jobs are claimed and added. Resuming takes
 * `ZRANK` of the member, and when that entry has gone since, the rank of the
 * first entry ordered after its (score, member) pair. It advances when the
 * continuation scan uses its whole budget without filling the request (any
 * allowed job it passed was claimed, so nothing is skipped), and is cleared
 * when the scan reaches the end of the set, so the next pass starts again
 * behind the head window. An allowed job that lands *behind* the cursor but
 * past the head window — a retry restored to its original place — waits at
 * most one pass through the pile.
 *
 * A job's name is inside `blob`, or in a `name` field on a record from before
 * `blob` existed. The blob is only ever *decoded* here, never re-encoded — see
 * {@link UPDATE_JOB} for what a cjson round trip does to a value. And it is
 * usually not decoded whole either: `#toValues` writes `name` as the blob's
 * first key, so the name is the string literal right after the opening
 * `{"name":`, and decoding just that literal keeps a large payload from being
 * parsed once per inspected job. Anything else falls back to a full decode.
 *
 * Pages start small, since the common case is a short run of excluded jobs,
 * and double so a long run costs few round trips into the sorted set.
 */
const EXCLUDE_PRELUDE = `
local function nameOf(id)
  local stored = redis.call('HMGET', job(id), 'blob', 'name')
  local blob = stored[1]
  if not blob then
    return stored[2]
  end

  if string.sub(blob, 1, 9) == '{"name":"' then
    local from = 10
    while true do
      local quote = string.find(blob, '"', from, true)
      if not quote then
        break
      end
      -- A quote preceded by an odd run of backslashes (byte 92) is escaped.
      local slashes = 0
      while string.byte(blob, quote - 1 - slashes) == 92 do
        slashes = slashes + 1
      end
      if slashes % 2 == 0 then
        return cjson.decode(string.sub(blob, 9, quote))
      end
      from = quote + 1
    end
  end

  local ok, decoded = pcall(cjson.decode, blob)
  if ok and type(decoded) == 'table' and type(decoded.name) == 'string' then
    return decoded.name
  end
  return stored[2]
end

-- The queue's cursor hash, a sibling of META: the prefix with its trailing
-- 'meta' swapped for 'exclude', matching \`excludeCursors\` in keys.ts.
local function excludeCursors() return string.sub(META, 1, -5) .. 'exclude' end

-- Scans up to budget entries from rank from, appending allowed ones to heads
-- until it holds count. Returns the last entry examined, whether the set ran
-- out, and whether heads filled.
local function scanWait(excluded, heads, count, from, budget)
  local examined, last = 0, nil
  local page = math.min(math.max(count, 16), ${EXCLUDE_PAGE_MAX})

  while examined < budget do
    local size = math.min(page, budget - examined)
    local start = from + examined
    local entries = redis.call('ZRANGE', WAIT, start, start + size - 1)

    for _, entry in ipairs(entries) do
      examined = examined + 1
      last = entry
      if not excluded[nameOf(string.sub(entry, 18))] then
        heads[#heads + 1] = entry
        if #heads == count then
          return last, false, true
        end
      end
    end

    -- A short page means the set ran out.
    if #entries < size then
      return last, true, false
    end

    page = math.min(page * 2, ${EXCLUDE_PAGE_MAX})
  end

  return last, false, false
end

-- The rank just after a stored cursor, 'score member'. The member's own rank
-- when it is still waiting; otherwise the first entry ordered after its
-- (score, member) pair, found by a binary search within that score's run.
-- Members lead with a fixed-width sequence, so comparing them as strings
-- orders them as ZRANGE does.
local function resumeRank(stored)
  local space = string.find(stored, ' ', 1, true)
  if not space then
    return nil
  end
  local score = string.sub(stored, 1, space - 1)
  local member = string.sub(stored, space + 1)

  local rank = redis.call('ZRANK', WAIT, member)
  if rank then
    return rank + 1
  end

  local lo = redis.call('ZCOUNT', WAIT, '-inf', '(' .. score)
  local hi = lo + redis.call('ZCOUNT', WAIT, score, score)
  while lo < hi do
    local mid = math.floor((lo + hi) / 2)
    if redis.call('ZRANGE', WAIT, mid, mid)[1] < member then
      lo = mid + 1
    else
      hi = mid
    end
  end
  return lo
end

-- Up to count wait-set entries whose job is not excluded, in claim order. The
-- excluded names are ARGV[first] onwards.
local function claimableHeads(first, count)
  local excluded, names = {}, {}
  for i = first, #ARGV do
    if not excluded[ARGV[i]] then
      excluded[ARGV[i]] = true
      names[#names + 1] = ARGV[i]
    end
  end

  local heads = {}
  local _, ended, filled = scanWait(excluded, heads, count, 0, ${EXCLUDE_HEAD_WINDOW})
  if ended or filled then
    return heads
  end

  -- Length-prefixed, so no name can contain a separator that forges another
  -- set's signature.
  table.sort(names)
  local parts = {}
  for i, name in ipairs(names) do
    parts[i] = #name .. ':' .. name
  end
  local signature = table.concat(parts)
  local cursors = excludeCursors()

  local from = ${EXCLUDE_HEAD_WINDOW}
  local stored = redis.call('HGET', cursors, signature)
  if stored then
    local rank = resumeRank(stored)
    if rank and rank > from then
      from = rank
    end
  end

  local last
  last, ended, filled = scanWait(excluded, heads, count, from, ${EXCLUDE_SCAN_LIMIT})

  if ended then
    -- Through to the end: the next pass starts again behind the head window.
    if stored then
      redis.call('HDEL', cursors, signature)
    end
  elseif not filled and last then
    if not stored and redis.call('HLEN', cursors) >= ${EXCLUDE_CURSOR_MAX_SIGNATURES} then
      redis.call('DEL', cursors)
    end
    -- Read before the claim removes anything: last is still in the set.
    local score = redis.call('ZSCORE', WAIT, last)
    redis.call('HSET', cursors, signature, score .. ' ' .. last)
    redis.call('PEXPIRE', cursors, ${EXCLUDE_CURSOR_TTL_MS})
  end

  return heads
end
`;

/**
 * Claims up to `count` jobs in one script.
 *
 * One script is one unit of atomicity, so N claims inside it are as exclusive
 * as one — this needs no locking that {@link CLAIM} does not already have.
 *
 * Two details matter. The promotion sweep stays *outside* the loop: it scans
 * two sorted sets, and repeating that per job would multiply the cost of every
 * idle poll by the batch size. And the reply is a nested table, one `HGETALL`
 * per job, not a joined string — job data is arbitrary JSON and any separator
 * would eventually appear inside it.
 *
 * ARGV: prefix, now, token, workerId, lockMs, promoteLimit, count, stamp,
 * then the names to exclude, if any. Excluding names bounds each claim's scan
 * (see `EXCLUDE_PRELUDE`), so it may claim fewer than `count` while more
 * remain; repeated claims resume from a cursor and work through any pile.
 *
 * `stamp` is the packed attribution (`packStamp` in stamp.ts), written to the
 * stamp field in the same `HSET` as `workerId`: the attribution costs no call
 * and no round trip of its own. It replaces the previous attempt's stamp whole,
 * and no settle touches it — only `workerId`, the holder, is cleared there.
 */
export const CLAIM_MANY = `${QUEUE_PRELUDE}${EXCLUDE_PRELUDE}
local now, token = tonumber(ARGV[2]), ARGV[3]
local workerId, lockMs = ARGV[4], tonumber(ARGV[5])
local limit = tonumber(ARGV[6])
local count = tonumber(ARGV[7])
local stamp = ARGV[8]

if redis.call('HGET', META, 'paused') == '1' then
  return {}
end

-- Due delayed and retrying jobs are not promoted here: that is the worker's
-- maintenance (PROMOTE_DELAYED), which \`maintenance: false\` turns off, as on
-- every other driver. ARGV[6] stays in place so the names after it do not move.

-- Names to skip arrive after the stamp. Without any, this is the plain head
-- read it always was: #ARGV is a length check in the VM, not a call to Redis.
local heads
if #ARGV >= 9 then
  heads = claimableHeads(9, count)
else
  heads = redis.call('ZRANGE', WAIT, 0, count - 1)
end
local claimed = {}

for _, entry in ipairs(heads) do
  local id = string.sub(entry, 18)

  redis.call('ZREM', WAIT, entry)
  redis.call('ZADD', ACTIVE, now + lockMs, id)
  redis.call('HSET', job(id),
    'state', 'active',
    'processedOn', tostring(now),
    'lockToken', token,
    'lockExpiresAt', tostring(now + lockMs),
    'workerId', workerId,
    '${STAMP_FIELD}', stamp)
  redis.call('HINCRBY', job(id), 'attemptsMade', 1)

  claimed[#claimed + 1] = redis.call('HGETALL', job(id))
end

-- Fewer than asked for may mean the wait set is now empty.
if #heads < count then
  dropStaleWakes()
end

return claimed
`;

/**
 * Claims the next due job.
 *
 * Promotes whatever has come due first, then takes the head of the wait set,
 * so a caller never has to ask twice. Returns the job's fields, or nothing
 * when the queue is empty or paused.
 *
 * ARGV: prefix, now, token, workerId, lockMs, promoteLimit, stamp, then the
 * names to exclude, if any. Excluding names bounds each claim's scan (see
 * `EXCLUDE_PRELUDE`), so it may return nothing while a claimable job sits
 * further back; repeated claims resume from a cursor and reach it. `stamp` is
 * written exactly as {@link CLAIM_MANY} writes it.
 */
export const CLAIM = `${QUEUE_PRELUDE}${EXCLUDE_PRELUDE}
local now, token = tonumber(ARGV[2]), ARGV[3]
local workerId, lockMs = ARGV[4], tonumber(ARGV[5])
local limit = tonumber(ARGV[6])
local stamp = ARGV[7]

if redis.call('HGET', META, 'paused') == '1' then
  return nil
end

-- Due delayed and retrying jobs are not promoted here: that is the worker's
-- maintenance (PROMOTE_DELAYED), which \`maintenance: false\` turns off, as on
-- every other driver. ARGV[6] stays in place so the names after it do not move.

-- Names to skip arrive after the stamp. Without any, this is the plain head
-- read it always was: #ARGV is a length check in the VM, not a call to Redis.
local entry
if #ARGV >= 8 then
  entry = claimableHeads(8, 1)[1]
  if not entry then
    dropStaleWakes()
    return nil
  end
else
  local head = redis.call('ZRANGE', WAIT, 0, 0)
  if #head == 0 then
    -- The wait set is empty, so every token still queued is stale.
    redis.call('DEL', WAKE)
    return nil
  end
  entry = head[1]
end

local id = string.sub(entry, 18)

redis.call('ZREM', WAIT, entry)
redis.call('ZADD', ACTIVE, now + lockMs, id)
redis.call('HSET', job(id),
  'state', 'active',
  'processedOn', tostring(now),
  'lockToken', token,
  'lockExpiresAt', tostring(now + lockMs),
  'workerId', workerId,
  '${STAMP_FIELD}', stamp)
redis.call('HINCRBY', job(id), 'attemptsMade', 1)

return redis.call('HGETALL', job(id))
`;

/**
 * Extends an active job's lock, for its holder only.
 *
 * ARGV: prefix, id, token, expiresAt. Returns 1 when it was ours.
 */
export const EXTEND_LOCK = `${QUEUE_PRELUDE}
local id, token, expiresAt = ARGV[2], ARGV[3], tonumber(ARGV[4])

if not holds(id, token) then
  return 0
end

redis.call('ZADD', ACTIVE, expiresAt, id)
redis.call('HSET', job(id), 'lockExpiresAt', tostring(expiresAt))
return 1
`;

/**
 * Writes a job's progress, only while the job exists.
 *
 * One script rather than `EXISTS` then `HSET`: between those two round trips
 * a completion that removes the job, a `removeJob` or a `drain` could delete
 * the hash, and the `HSET` then recreated it as a one-field orphan in no set
 * and with no expiry — a key nothing would ever collect.
 *
 * KEYS: the job's hash. ARGV: the progress as JSON. Returns 1 when written.
 */
export const UPDATE_PROGRESS = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
redis.call('HSET', KEYS[1], 'progress', ARGV[1])
return 1
`;

/**
 * Shared by {@link renderScripts}' `COMPLETE` and `FAIL`: counts one completion
 * or failed attempt in the minute — and, when per-second recording is on, in
 * the second — of `now`, in the same script as the write it counts.
 *
 * Both hashes are siblings of `job:`, derived from the prefix exactly as
 * `logs(id)` is — see `throughputPrefix` and `metricsPrefix` in keys.ts — so
 * neither takes a KEYS entry and both keep the queue's hash tag. The cost per
 * job is one `HINCRBY` per width; a bucket's first count also sets its hash's
 * expiry, once per hash per field. An expiry already in the past deletes the
 * hash at once, which is exactly what retention asks of a bucket that old.
 *
 * **Redis is the one backend that counts a queue's own buckets inside the
 * script** (§4a of the analytics design): an `HINCRBY` in a script already
 * being sent costs no round trip, so the rule that per-second counts must not
 * ride the per-job statement — which exists because a contended row measured
 * 1,421 ms against 2 ms on Postgres — buys nothing here. The namespace roll-up
 * is another matter: its keys are outside the queue's hash tag, so it cannot
 * ride this and is buffered by the driver instead.
 *
 * **This is the text §9.10 is about.** `secondRetentionMs` and
 * `minuteRetentionMs` are interpolated, so two drivers configured differently
 * hold different script *text* and therefore different SHAs. Nothing may cache
 * a script by its name.
 */
function throughputCount(options: ScriptOptions): string {
  const seconds = options.secondRetentionMs > 0;

  return `
local function countThroughput(kind, at)
  local bucket = at - (at % ${THROUGHPUT_BUCKET_MS})
  local key = string.sub(PREFIX, 1, -5) .. 'tp:' .. string.format('%.0f', bucket)
  if redis.call('HINCRBY', key, kind, 1) == 1 then
    redis.call('PEXPIREAT', key, string.format('%.0f', bucket + ${options.minuteRetentionMs + THROUGHPUT_BUCKET_MS}))
  end
${
  seconds
    ? `  -- The second's count, in the hash of sixty second-fields its minute owns.
  local second = at - (at % ${SECOND_BUCKET_MS})
  local fine = string.sub(PREFIX, 1, -5) .. 'mx:jobs:s:' .. string.format('%.0f', bucket)
  local field = string.format('%d', (second - bucket) / ${SECOND_BUCKET_MS}) .. ':' .. kind
  if redis.call('HINCRBY', fine, field, 1) == 1 then
    redis.call('PEXPIREAT', fine, string.format('%.0f', bucket + ${THROUGHPUT_BUCKET_MS + options.secondRetentionMs}))
  end
`
    : ""
}end
`;
}

/**
 * Completes a job, for its lock holder only, and counts it in the minute's
 * throughput — only once the lock check has passed.
 *
 * ARGV: prefix, id, token, now, returnValue, retention mode, count, ttl.
 */
const COMPLETE_ONE = `
-- Completes one job for its lock holder. Returns whether it did.
local function completeOne(id, token, now, result, mode, count, ttl)
  if not holds(id, token) then
    return false
  end

  countThroughput('completed', now)

  redis.call('ZREM', ACTIVE, id)

  -- Removed on completion: straight to the delete. Recording the job as
  -- completed only for retain() to remove it again at once was a ZADD, a
  -- six-field HSET and a ZREM of nothing anybody could observe.
  if mode == 'remove' then
    drop(id)
    return true
  end

  redis.call('ZADD', COMPLETED, now, id)
  redis.call('HSET', job(id),
    'state', 'completed',
    'finishedOn', tostring(now),
    'returnValue', result,
    'lockToken', '',
    'lockExpiresAt', '',
    'workerId', '')

  retain(id, COMPLETED, mode, count, ttl, now)
  return true
end
`;

const complete = (
  COUNT: string,
): string => `${QUEUE_PRELUDE}${COUNT}${COMPLETE_ONE}
local id, token, now = ARGV[2], ARGV[3], tonumber(ARGV[4])
local result, mode, count, ttl = ARGV[5], ARGV[6], ARGV[7], ARGV[8]

if completeOne(id, token, now, result, mode, count, ttl) then
  return 1
end
return 0
`;

/**
 * Completes several jobs held under one token, in one script — the Redis
 * `completeJobs`. Each is exactly {@link renderScripts}' `COMPLETE`, lock
 * check included; the script is the one statement the batcher expects, so a
 * failure is every job's failure and a success reports each.
 *
 * ARGV: prefix, token, now, then per job: id, returnValue, retention mode,
 * count, ttl. Returns the ids completed; one missing lost its lock.
 */
const completeMany = (
  COUNT: string,
): string => `${QUEUE_PRELUDE}${COUNT}${COMPLETE_ONE}
local token, now = ARGV[2], tonumber(ARGV[3])
local done = {}

for at = 4, #ARGV, 5 do
  local id = ARGV[at]
  if completeOne(id, token, now, ARGV[at + 1], ARGV[at + 2], ARGV[at + 3], ARGV[at + 4]) then
    done[#done + 1] = id
  end
end

return done
`;

/**
 * Fails an attempt, for its lock holder only: either back to `failed` with a
 * retry time, or to `dead` for good. Either way the attempt counts as failed
 * in the minute's throughput, once the lock check has passed.
 *
 * ARGV: prefix, id, token, now, error, stacktrace, retry, runAt, mode, count, ttl.
 */
const fail = (COUNT: string): string => `${QUEUE_PRELUDE}${COUNT}
local id, token, now = ARGV[2], ARGV[3], tonumber(ARGV[4])
local err, stacktrace, retry = ARGV[5], ARGV[6], ARGV[7]
local runAt, mode, count, ttl = tonumber(ARGV[8]), ARGV[9], ARGV[10], ARGV[11]

if not holds(id, token) then
  return 0
end

-- Before the branch, so the retry and the dead path both count.
countThroughput('failed', now)

redis.call('ZREM', ACTIVE, id)
redis.call('HSET', job(id),
  'failedReason', err,
  'stacktrace', stacktrace,
  'lockToken', '',
  'lockExpiresAt', '',
  'workerId', '')

if retry == '1' then
  redis.call('ZADD', FAILED, runAt, id)
  redis.call('HSET', job(id), 'state', 'failed', 'runAt', tostring(runAt), 'finishedOn', '')
  return 1
end

redis.call('ZADD', DEAD, now, id)
redis.call('HSET', job(id), 'state', 'dead', 'finishedOn', tostring(now))
retain(id, DEAD, mode, count, ttl, now)
return 1
`;

/**
 * Buries a job from outside its processor: `dead` for good, from any state
 * it waits in, or from `active` while it is still under `token`. Counted as a
 * failure in the minute's throughput, as `FAIL` counts one; attempts
 * and the flow's `recorded` flag are left as they are.
 *
 * ARGV: prefix, id, token ('' for none), now, error, stacktrace, mode, count,
 * ttl. Returns the job's fields as buried — read before retention, which may
 * remove it, and again after when it is still there — or nothing when the job
 * was not buried.
 */
const bury = (COUNT: string): string => `${QUEUE_PRELUDE}${COUNT}
local id, token, now = ARGV[2], ARGV[3], tonumber(ARGV[4])
local err, stacktrace = ARGV[5], ARGV[6]
local mode, count, ttl = ARGV[7], ARGV[8], ARGV[9]
local current = state(id)

if current == 'active' then
  if token == '' or redis.call('HGET', job(id), 'lockToken') ~= token then
    return nil
  end
  redis.call('ZREM', ACTIVE, id)
elseif current == 'waiting' then
  redis.call('ZREM', WAIT, member(id))
elseif current == 'delayed' then
  redis.call('ZREM', DELAYED, id)
elseif current == 'failed' then
  redis.call('ZREM', FAILED, id)
elseif current == 'waiting-children' then
  redis.call('ZREM', CHILDREN, id)
else
  return nil
end

countThroughput('failed', now)

redis.call('ZADD', DEAD, now, id)
redis.call('HSET', job(id),
  'state', 'dead',
  'finishedOn', tostring(now),
  'failedReason', err,
  'stacktrace', stacktrace,
  'lockToken', '',
  'lockExpiresAt', '',
  'workerId', '')

local buried = redis.call('HGETALL', job(id))
retain(id, DEAD, mode, count, ttl, now)

if redis.call('EXISTS', job(id)) == 1 then
  return redis.call('HGETALL', job(id))
end
return buried
`;

/**
 * Moves whatever has come due into the wait set, and reports when the next
 * scheduled job comes due.
 *
 * ARGV: prefix, now, limit. Returns { how many moved, the lowest score left
 * in the delayed and failed sets, or '' when both are empty }. The second is
 * two \`ZRANGE 0 0\` inside the script the promotion already runs, so an idle
 * worker learns its wait budget without a round trip of its own.
 */
export const PROMOTE_DELAYED = `${QUEUE_PRELUDE}
local now, limit = tonumber(ARGV[2]), tonumber(ARGV[3])
local moved = 0

for _, set in ipairs({ DELAYED, FAILED }) do
  local due = redis.call('ZRANGEBYSCORE', set, '-inf', now, 'LIMIT', 0, limit)
  for _, id in ipairs(due) do
    redis.call('ZREM', set, id)
    redis.call('ZADD', WAIT, tonumber(redis.call('HGET', job(id), 'priority')), member(id))
    redis.call('HSET', job(id), 'state', 'waiting')
    moved = moved + 1
  end
end

if moved > 0 then
  wake(moved)
end

local next = ''
for _, set in ipairs({ DELAYED, FAILED }) do
  local head = redis.call('ZRANGE', set, 0, 0, 'WITHSCORES')
  if head[2] and (next == '' or tonumber(head[2]) < tonumber(next)) then
    next = head[2]
  end
end

return { moved, next }
`;

/**
 * Recovers jobs whose worker died holding them: back to the queue, or to the
 * dead set once they have stalled too often.
 *
 * ARGV: prefix, now, maxStalled, limit. Returns { how many were requeued,
 * requeued… , dead… }.
 */
const recoverStalled = (COUNT: string): string => `${QUEUE_PRELUDE}${COUNT}
local now, maxStalled, limit = tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local stalled = redis.call('ZRANGEBYSCORE', ACTIVE, '-inf', now, 'LIMIT', 0, limit)

local requeued, dead = {}, {}

for _, id in ipairs(stalled) do
  local count = redis.call('HINCRBY', job(id), 'stalledCount', 1)
  redis.call('ZREM', ACTIVE, id)
  redis.call('HSET', job(id), 'lockToken', '', 'lockExpiresAt', '', 'workerId', '')

  if count > maxStalled then
    redis.call('ZADD', DEAD, now, id)
    redis.call('HSET', job(id), 'state', 'dead', 'finishedOn', tostring(now))
    -- A burial is a failure, counted as FAIL counts one.
    countThroughput('failed', now)
    dead[#dead + 1] = id
  else
    redis.call('ZADD', WAIT, tonumber(redis.call('HGET', job(id), 'priority')), member(id))
    redis.call('HSET', job(id), 'state', 'waiting', 'runAt', tostring(now))
    requeued[#requeued + 1] = id
  end
end

if #requeued > 0 then
  wake(#requeued)
end

-- Lua cannot return nested tables, so the reply leads with the length of the
-- first list. A marker between them would have to be a string no job id can
-- be, and '|' is a legal id.
local result = { #requeued }
for _, id in ipairs(requeued) do result[#result + 1] = id end
for _, id in ipairs(dead) do result[#result + 1] = id end
return result
`;

/**
 * Removes a job, unless a worker is running it.
 *
 * ARGV: prefix, id. Returns 1 when it went.
 */
export const REMOVE_JOB = `${QUEUE_PRELUDE}
local id = ARGV[2]
local current = state(id)

if current == nil or current == false or current == 'active' then
  return 0
end

redis.call('ZREM', WAIT, member(id))
redis.call('ZREM', DELAYED, id)
redis.call('ZREM', FAILED, id)
redis.call('ZREM', COMPLETED, id)
redis.call('ZREM', DEAD, id)
redis.call('ZREM', CHILDREN, id)
drop(id)
return 1
`;

/**
 * Returns a finished job to the queue.
 *
 * ARGV: prefix, id, now, resetAttempts. Returns 1 when it moved.
 */
export const RETRY_JOB = `${QUEUE_PRELUDE}
local id, now, reset = ARGV[2], tonumber(ARGV[3]), ARGV[4]
local current = state(id)

-- A parent waiting on children is not finished; moving it would run it
-- before they settle.
if current == nil or current == false or current == 'active' or current == 'waiting' or current == 'waiting-children' then
  return 0
end

redis.call('ZREM', DELAYED, id)
redis.call('ZREM', FAILED, id)
redis.call('ZREM', COMPLETED, id)
redis.call('ZREM', DEAD, id)
redis.call('ZREM', CHILDREN, id)

redis.call('ZADD', WAIT, tonumber(redis.call('HGET', job(id), 'priority')), member(id))
redis.call('HSET', job(id), 'state', 'waiting', 'runAt', tostring(now), 'finishedOn', '', 'expiresAt', '')

-- A flow child's next outcome has not reached its parent.
if redis.call('HGET', job(id), 'flowRecorded') == '1' then
  redis.call('HSET', job(id), 'flowRecorded', '0')
end

if reset == '1' then
  redis.call('HSET', job(id), 'attemptsMade', '0', 'stalledCount', '0')
end

wake()
return 1
`;

/**
 * Makes a delayed or retry-pending job claimable now.
 *
 * ARGV: prefix, id, now. Returns 1 when it moved.
 */
export const PROMOTE_JOB = `${QUEUE_PRELUDE}
local id, now = ARGV[2], tonumber(ARGV[3])
local current = state(id)

if current ~= 'delayed' and current ~= 'failed' then
  return 0
end

redis.call('ZREM', DELAYED, id)
redis.call('ZREM', FAILED, id)
redis.call('ZADD', WAIT, tonumber(redis.call('HGET', job(id), 'priority')), member(id))
redis.call('HSET', job(id), 'state', 'waiting', 'runAt', tostring(now))
wake()
return 1
`;

/**
 * Removes jobs older than a cutoff, examining a bounded stretch per call.
 *
 * ARGV: prefix, set name, cutoff, limit, offset, budget. Returns the rank the
 * next call resumes at (`-1` once the set is exhausted), then the ids that
 * went.
 *
 * The pending sets are scored by priority or due time, neither of which is a
 * job's age, so they are walked and each job's age read from its hash. That
 * walk used to run to `limit` matches or the end of the set inside one script:
 * with few old enough, every job in the set was read while Redis served
 * nobody else — on the order of a second per million waiting. Now one call
 * examines at most `budget` entries and says where it stopped; the driver
 * calls again from there until it has `limit` or reaches the end.
 */
export const CLEAN = `${QUEUE_PRELUDE}
local which, cutoff, limit = ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])
local offset, budget = tonumber(ARGV[5]) or 0, tonumber(ARGV[6]) or ${CLEAN_SCAN_BUDGET}
local sets = { waiting = WAIT, delayed = DELAYED, failed = FAILED, completed = COMPLETED, dead = DEAD, ['waiting-children'] = CHILDREN }
local set = sets[which]
local result = { -1 }

if not set then
  return result
end

if which == 'waiting' or which == 'delayed' or which == 'failed' or which == 'waiting-children' then
  -- Age lives on the hash, as every other driver measures it: finishedOn
  -- when the job has one, else createdAt.
  local removed, examined = 0, 0
  while removed < limit and examined < budget do
    local page = math.min(${CLEAN_PAGE}, budget - examined)
    local entries = redis.call('ZRANGE', set, offset, offset + page - 1)
    if #entries == 0 then
      return result
    end
    for _, entry in ipairs(entries) do
      examined = examined + 1
      local id = which == 'waiting' and string.sub(entry, 18) or entry
      local times = redis.call('HMGET', job(id), 'finishedOn', 'createdAt')
      local age = tonumber(times[1]) or tonumber(times[2])
      if age and age <= cutoff and removed < limit then
        redis.call('ZREM', set, entry)
        drop(id)
        removed = removed + 1
        result[#result + 1] = id
      else
        offset = offset + 1
      end
    end
  end
  result[1] = offset
  return result
end

-- Completed and dead are scored by when they finished, which is their age:
-- a bounded range read, finished in one call.
local ids = redis.call('ZRANGEBYSCORE', set, '-inf', cutoff, 'LIMIT', 0, math.min(limit, budget))
for _, id in ipairs(ids) do
  redis.call('ZREM', set, id)
  drop(id)
  result[#result + 1] = id
end
if #ids == math.min(limit, budget) and #ids < limit then
  result[1] = 0
end
return result
`;

/**
 * How many entries of one finished set each of {@link PRUNE_EXPIRED}'s two
 * walks reads, per job the call may remove. Each read is a hash lookup or
 * two, so at the worker's batch of 100 a call reads at most 4,000 entries
 * across both sets and both walks — a few milliseconds of the server's time —
 * however many of them it finds it cannot remove.
 */
export const PRUNE_SCAN_FACTOR = 10;

/**
 * How long, in milliseconds, a queue's prune cursors outlive the last call
 * that moved them. A cursor is only a place to resume, so one that expired
 * costs a walk from the start and nothing else, and a queue nobody sweeps any
 * more does not keep its hash for good.
 */
export const PRUNE_CURSOR_TTL_MS = 60 * 60 * 1000;

/**
 * Removes jobs whose retention has expired.
 *
 * The finished sets are scored by when a job finished, not by when it
 * expires, and retention is per job: a job kept for good, or for a week, can
 * sit ahead of any number that have expired. Reading only the first `limit`
 * entries — which this once did — let `limit` such jobs at the head hide
 * every expired job behind them for good.
 *
 * So each set gets two bounded walks, each reading at most
 * `limit * PRUNE_SCAN_FACTOR` entries and passing over what it cannot remove:
 *
 * - **From the head.** Under one retention the oldest finished are the first
 *   to expire, so this is where nearly all the work is, found at once.
 * - **From a cursor**, a rank saved between calls in the queue's `prune` hash
 *   (a sibling of `meta`, derived from it as `exclude` is), wrapping to the
 *   start at the end of the set. It reaches whatever the head walk cannot —
 *   jobs expired behind more unremovable ones than one walk reads — so every
 *   entry is looked at within `size / (limit * PRUNE_SCAN_FACTOR)` calls.
 *
 * A cursor needs no care to stay correct: removals ahead of it can only lower
 * the ranks behind it, which skips an entry until the next time round rather
 * than losing it. Those the head walk made are subtracted, so it does not
 * even skip those.
 *
 * ARGV: prefix, now, limit. Returns how many went.
 */
export const PRUNE_EXPIRED = `${QUEUE_PRELUDE}
local now, limit = tonumber(ARGV[2]), tonumber(ARGV[3])
local budget = limit * ${PRUNE_SCAN_FACTOR}
local cursors = string.sub(META, 1, -5) .. 'prune'
local removed = 0

-- Walks a set from a rank, reading at most budget entries and removing the
-- expired ones, wrapping to the start once when asked to. Returns the rank it
-- stopped at, and how many it removed.
local function walk(set, offset, wrap)
  local examined, went, wrapped = 0, 0, offset == 0 or not wrap
  while removed < limit and examined < budget do
    local ids = redis.call('ZRANGE', set, offset, offset + 99)
    if #ids == 0 then
      if wrapped then
        break
      end
      offset, wrapped = 0, true
    else
      for _, id in ipairs(ids) do
        examined = examined + 1
        local expiresAt = redis.call('HGET', job(id), 'expiresAt')
        if expiresAt and expiresAt ~= '' and tonumber(expiresAt) <= now
          and not awaitsDelivery(id) then
          redis.call('ZREM', set, id)
          drop(id)
          removed = removed + 1
          went = went + 1
        else
          offset = offset + 1
        end
        if removed >= limit or examined >= budget then
          break
        end
      end
    end
  end
  return offset, went
end

for _, pair in ipairs({ { COMPLETED, 'completed' }, { DEAD, 'dead' } }) do
  local set, field = pair[1], pair[2]
  local headEnd, headWent = walk(set, 0, false)

  if removed < limit then
    local saved = (tonumber(redis.call('HGET', cursors, field)) or 0) - headWent
    local cursor = walk(set, math.max(saved, headEnd), true)
    if cursor > 0 then
      redis.call('HSET', cursors, field, cursor)
    else
      redis.call('HDEL', cursors, field)
    end
  end
end

if redis.call('EXISTS', cursors) == 1 then
  redis.call('PEXPIRE', cursors, ${PRUNE_CURSOR_TTL_MS})
end

return removed
`;

/**
 * Drops up to `budget` pending jobs. Never touches what a worker is running.
 *
 * ARGV: prefix, includeDelayed, budget. Returns { how many went, how many
 * pending remain in the sets it drains }.
 *
 * Bounded, and the driver calls it until nothing remains. It used to read and
 * delete every waiting job in one script — a million-element Lua table and a
 * million `DEL`s while every other client waited, seconds of a stalled server.
 * Each call now takes at most `budget` from the head of each set in turn
 * (`ZRANGE` then `ZREMRANGEBYRANK` over exactly that range), so the server
 * serves other clients between calls. A drain is therefore no longer one
 * atomic snapshot: a job added while it runs may or may not go with it,
 * exactly as with a SQL driver deleting in batches.
 */
export const DRAIN = `${QUEUE_PRELUDE}
local includeDelayed, budget = ARGV[2], tonumber(ARGV[3]) or ${DRAIN_BATCH}
local removed = 0

-- Exclusion cursors point into the wait set being emptied. See excludeCursors.
redis.call('DEL', string.sub(META, 1, -5) .. 'exclude')

local sets = { { WAIT, true }, { CHILDREN, false } }
if includeDelayed == '1' then
  sets[#sets + 1] = { DELAYED, false }
  sets[#sets + 1] = { FAILED, false }
end

local remaining = 0
for _, pair in ipairs(sets) do
  local set, ordered = pair[1], pair[2]
  if removed < budget then
    local take = budget - removed
    local entries = redis.call('ZRANGE', set, 0, take - 1)
    for _, entry in ipairs(entries) do
      -- A wait-set member is a sequence then the id; every other set holds ids.
      drop(ordered and string.sub(entry, 18) or entry)
    end
    if #entries > 0 then
      redis.call('ZREMRANGEBYRANK', set, 0, #entries - 1)
      removed = removed + #entries
    end
  end
  remaining = remaining + redis.call('ZCARD', set)
end

return { removed, remaining }
`;

/**
 * A page of the jobs in the given states, as a flat list of ids: the states'
 * sets one after another, in the order given — reversed, set and members
 * alike, for `desc`.
 *
 * Paged on the server. Whole sets before the offset are skipped by their
 * size, and only the page itself is ranged, so a maintenance pass paging
 * through a large completed set costs what the page costs rather than the
 * whole set per call.
 *
 * ARGV: prefix, offset, limit, order, then one state per remaining argument.
 */
export const LIST_JOBS = `${QUEUE_PRELUDE}
local offset, limit, order = tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
local sets = { waiting = WAIT, delayed = DELAYED, failed = FAILED, active = ACTIVE, completed = COMPLETED, dead = DEAD, ['waiting-children'] = CHILDREN }

local names = {}
for i = 5, #ARGV do names[#names + 1] = ARGV[i] end
if order == 'desc' then
  local reversed = {}
  for i = #names, 1, -1 do reversed[#reversed + 1] = names[i] end
  names = reversed
end

local page, skip = {}, offset
for _, name in ipairs(names) do
  local set = sets[name]
  if set and #page < limit then
    local size = redis.call('ZCARD', set)
    if skip >= size then
      skip = skip - size
    else
      local last = skip + (limit - #page) - 1
      local entries
      if order == 'desc' then
        entries = redis.call('ZREVRANGE', set, skip, last)
      else
        entries = redis.call('ZRANGE', set, skip, last)
      end
      skip = 0
      for _, entry in ipairs(entries) do
        page[#page + 1] = (name == 'waiting') and string.sub(entry, 18) or entry
      end
    end
  end
end

return page
`;

/**
 * How many jobs are in each state. ARGV: prefix. Returns waiting, delayed,
 * active, completed, failed, dead and waiting-children, in that order.
 */
export const COUNT_JOBS = `${QUEUE_PRELUDE}
return {
  redis.call('ZCARD', WAIT),
  redis.call('ZCARD', DELAYED),
  redis.call('ZCARD', ACTIVE),
  redis.call('ZCARD', COMPLETED),
  redis.call('ZCARD', FAILED),
  redis.call('ZCARD', DEAD),
  redis.call('ZCARD', CHILDREN),
}
`;

/**
 * One chunk of a state's set, filtered inside the script by the attribution
 * filters, answering each surviving job's id and — when the query needs it —
 * its name, never the payload. What `findJobs` walks when a query names jobs,
 * searches, or uses `workerKeys`, `workerIds`, `finishedFrom`/`finishedTo`.
 *
 * **Ranged by rank within a score window.** Without a range the window is the
 * whole set, and a chunk is ranged exactly as {@link LIST_JOBS} ranges one set
 * (`ZRANGE` for `asc`, `ZREVRANGE` for `desc`, the wait set's ordering prefix
 * stripped), so paging through chunks visits jobs in `listJobs` order. With a
 * range — only ever sent for `completed` and `dead`, whose score *is*
 * `finishedOn` — the window's rank bounds are two `ZCOUNT`s, each O(log n):
 * `[from, to)` is ranks `[ZCOUNT(-inf, (from), ZCOUNT(-inf, (to))`, and the
 * chunk is ranged by rank inside it. Recomputed per call rather than carried
 * by the caller, so a completion landing after `to` — the usual case, since
 * it scores `now` — shifts nothing the walk has still to visit. Ranging by
 * rank rather than `ZRANGEBYSCORE … LIMIT offset` matters: a `LIMIT` offset is
 * walked element by element, so chunk *k* would re-walk every chunk before it.
 *
 * **The worker filter runs here, not in the driver**: each member costs one
 * `HMGET` of the fields the query needs, and only matches are sent back, so a
 * selective key over a dense range answers a short reply instead of every id
 * in it. A chunk is at most `count` members, which bounds how long one call
 * holds Redis's single thread; the reply's first element is how many members
 * the chunk examined, which is how the caller knows the window ran out.
 *
 * Matching, exactly as `matchesAttribution` defines it: `workerIds` against the
 * stamp's id, `workerKeys` against its key — both exact byte comparisons, by
 * table lookup, so a hundred keys cost what one does — and, with a range, the
 * job's own `finishedOn` re-checked against `[from, to)`: a record restored
 * finished but without a `finishedOn` is scored by `createdAt` and must not
 * match. A job with no stamp, or a stamp without a key, never matches a key.
 *
 * The name is cut out of `blob` rather than decoded from it: `#toValues`
 * writes `name` as the blob's first key, so it is the JSON string literal
 * right after `{"name":`, ending at the first quote not escaped by an odd run
 * of backslashes. The literal is sent as it is stored, quotes included, and
 * the driver parses it — so a large payload is neither decoded here nor sent.
 * Tagged by its first byte: `j` for a JSON literal, `r` for a plain string (a
 * record from before `blob`, or a blob the cut could not read), `-` for a job
 * whose hash has gone.
 *
 * ARGV: prefix, state, start (rank within the window), count, order, from
 * ('' for none), to ('' for none), withNames ('1' or '0'), keyCount, idCount,
 * then that many keys, then that many ids. Reply: the number examined, then
 * `id, name` pairs with names, or bare ids without.
 */
export const FIND_JOBS = `${QUEUE_PRELUDE}
local which, start, count, order = ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4]), ARGV[5]
local from, to, withNames = ARGV[6], ARGV[7], ARGV[8] == '1'
local keyCount, idCount = tonumber(ARGV[9]), tonumber(ARGV[10])
local sets = { waiting = WAIT, delayed = DELAYED, failed = FAILED, active = ACTIVE, completed = COMPLETED, dead = DEAD, ['waiting-children'] = CHILDREN }
local set = sets[which]

if not set or count <= 0 then
  return { 0 }
end

local keys, ids = nil, nil
if keyCount > 0 then
  keys = {}
  for i = 11, 10 + keyCount do keys[ARGV[i]] = true end
end
if idCount > 0 then
  ids = {}
  for i = 11 + keyCount, 10 + keyCount + idCount do ids[ARGV[i]] = true end
end
local ranged = from ~= '' or to ~= ''
local low, high = tonumber(from), tonumber(to)

-- The window, as ranks: [lo, hi).
local card = redis.call('ZCARD', set)
local lo, hi = 0, card
if from ~= '' then lo = redis.call('ZCOUNT', set, '-inf', '(' .. from) end
if to ~= '' then hi = redis.call('ZCOUNT', set, '-inf', '(' .. to) end

local entries = {}
if order == 'desc' then
  local top = hi - 1 - start
  local bottom = math.max(lo, top - count + 1)
  if top >= bottom then
    entries = redis.call('ZREVRANGE', set, card - 1 - top, card - 1 - bottom)
  end
else
  local first = lo + start
  local last = math.min(hi - 1, first + count - 1)
  if last >= first then
    entries = redis.call('ZRANGE', set, first, last)
  end
end

-- One length-prefixed segment of a packed stamp at byte at: its text (nil for
-- an absent part, '-') and where the next begins. Malformed input ends the
-- walk (nil, past the end) rather than guessing — see stamp.ts for the format.
local function segment(packed, at)
  if at > #packed then return nil, at end
  if string.sub(packed, at, at) == '-' then return nil, at + 1 end
  local colon = string.find(packed, ':', at, true)
  if not colon then return nil, #packed + 1 end
  local n = tonumber(string.sub(packed, at, colon - 1))
  if not n or n < 0 or n ~= math.floor(n) or colon + n > #packed then
    return nil, #packed + 1
  end
  return string.sub(packed, colon + 1, colon + n), colon + 1 + n
end

-- The fields each member needs, read in one HMGET: the stamp only when a
-- worker filter asks, finishedOn only with a range, the name only with names.
local fields, at = {}, {}
if keys or ids then fields[#fields + 1] = '${STAMP_FIELD}'; at.stamp = #fields end
if ranged then fields[#fields + 1] = 'finishedOn'; at.finished = #fields end
if withNames then
  fields[#fields + 1] = 'blob'; at.blob = #fields
  fields[#fields + 1] = 'name'; at.name = #fields
end

local function matches(stored)
  if at.stamp then
    local packed = stored[at.stamp]
    if not packed then return false end
    local id, rest = segment(packed, 1)
    if ids and not (id and ids[id]) then return false end
    if keys then
      local key = segment(packed, rest)
      if not (key and keys[key]) then return false end
    end
  end
  if ranged then
    local finished = tonumber(stored[at.finished])
    if not finished then return false end
    if low and finished < low then return false end
    if high and finished >= high then return false end
  end
  return true
end

-- The JSON literal of a blob's leading name, or nil when it has none there.
local function nameLiteral(blob)
  if string.sub(blob, 1, 9) ~= '{"name":"' then
    return nil
  end
  local pos = 10
  while true do
    local quote = string.find(blob, '"', pos, true)
    if not quote then
      return nil
    end
    -- A quote preceded by an odd run of backslashes (byte 92) is escaped.
    local slashes = 0
    while string.byte(blob, quote - 1 - slashes) == 92 do
      slashes = slashes + 1
    end
    if slashes % 2 == 0 then
      return string.sub(blob, 9, quote)
    end
    pos = quote + 1
  end
end

local function nameOf(blob, plain)
  if blob then
    local literal = nameLiteral(blob)
    if literal then
      return 'j' .. literal
    end
    local ok, decoded = pcall(cjson.decode, blob)
    if ok and type(decoded) == 'table' and type(decoded.name) == 'string' then
      return 'r' .. decoded.name
    elseif plain then
      return 'r' .. plain
    end
    return 'r'
  elseif plain then
    return 'r' .. plain
  end
  return '-'
end

local reply = { #entries }
for _, entry in ipairs(entries) do
  local id = (which == 'waiting') and string.sub(entry, 18) or entry
  local stored = #fields > 0 and redis.call('HMGET', job(id), unpack(fields)) or {}
  if matches(stored) then
    reply[#reply + 1] = id
    if withNames then
      reply[#reply + 1] = nameOf(stored[at.blob], stored[at.name])
    end
  end
end

return reply
`;

/**
 * The throughput counts of every minute from `from` to `to`, both minute
 * starts, read from the per-minute hashes `COMPLETE` and `FAIL`
 * write. The caller bounds the range, so this is at most a day of `HMGET`s.
 *
 * ARGV: prefix, from, to. Reply: a flat list of triples — minute, completed,
 * failed — for the minutes that have a hash.
 */
export const GET_THROUGHPUT = `${QUEUE_PRELUDE}
local from, to = tonumber(ARGV[2]), tonumber(ARGV[3])
local base = string.sub(PREFIX, 1, -5) .. 'tp:'
local reply = {}

local at = from
while at <= to do
  local minute = string.format('%.0f', at)
  local counts = redis.call('HMGET', base .. minute, 'completed', 'failed')
  if counts[1] or counts[2] then
    reply[#reply + 1] = minute
    reply[#reply + 1] = counts[1] or '0'
    reply[#reply + 1] = counts[2] or '0'
  end
  at = at + ${THROUGHPUT_BUCKET_MS}
end

return reply
`;

/**
 * Writes a worker's heartbeat record and its expiry together, after removing
 * the records already lapsed at the reporter's `now` — so a dead worker's
 * record goes while live workers keep reporting, not only when somebody lists.
 *
 * The keys' own lifetime is **relative**: `PEXPIRE` by `ttl`, and never
 * shortened. It used to be `PEXPIREAT` the latest record's `expiresAt`, an
 * absolute time from the caller's clock, and a caller a few intervals behind
 * the server set a time already past — which deleted the whole registry on the
 * spot. A relative lifetime is measured by the server alone, and the registry
 * of a queue nobody consumes any more still removes itself.
 *
 * KEYS: workers hash, expiry sorted set. ARGV: id, record as JSON, expiresAt,
 * now, ttl in milliseconds.
 */
export const REGISTER_WORKER = `
local lapsed = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[4])
for _, id in ipairs(lapsed) do
  if id ~= ARGV[1] then
    redis.call('HDEL', KEYS[1], id)
    redis.call('ZREM', KEYS[2], id)
  end
end

redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])

local ttl = tonumber(ARGV[5])
for _, key in ipairs({ KEYS[1], KEYS[2] }) do
  if redis.call('PTTL', key) < ttl then
    redis.call('PEXPIRE', key, ttl)
  end
end
return 1
`;

/**
 * Removes a worker's record and its expiry together.
 *
 * KEYS: workers hash, expiry sorted set. ARGV: id. Returns 1 when there was a
 * record.
 */
export const REMOVE_WORKER = `
local removed = redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return removed
`;

/**
 * Drops every record lapsed at `now` — `expiresAt` at or before it — and
 * returns the rest.
 *
 * KEYS: workers hash, expiry sorted set. ARGV: now. Reply: the live records,
 * as JSON, in no particular order.
 */
export const LIST_WORKERS = `
local lapsed = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, id in ipairs(lapsed) do
  redis.call('HDEL', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
end
return redis.call('HVALS', KEYS[1])
`;

/**
 * Records how a child ended on its parent, and moves the parent on.
 *
 * Runs on the **parent's** queue keys, so it is one script and atomic by
 * construction, whatever queue the child lives in.
 *
 * **Nothing here decodes or re-encodes JSON.** A child's value is arbitrary
 * JSON, and a cjson round trip changes it: an empty array comes back as an
 * object, and a large integer loses precision — see {@link UPDATE_JOB}. So
 * the outcome is stored exactly as the driver encoded it, in a hash field of
 * its own named after the child (`FLOW_VALUE_PREFIX` / `FLOW_FAILURE_PREFIX`
 * plus `queue:id`), and the count left is the scalar `flowPending`. That also
 * makes the repeat check an `HEXISTS` rather than a decode of every outcome
 * recorded so far, which would make recording n children O(n²).
 *
 * Whether the parent lists the child is a plain substring search of its
 * `flow` skeleton for the child's reference, encoded exactly as the driver
 * writes each entry of `children` — no decode, so it stays linear in the
 * skeleton's length. It searches from the `"children":` key on, which comes
 * after `"parent":`, so the parent's own reference can never match. Inside a
 * JSON string every quote is escaped, so neither pattern can match text
 * inside an id.
 *
 * **A stale failure is refused.** A delivery decided from an earlier view
 * must not bury a parent retried since. So before burying, the script reads
 * the child's own record, and answers `"already"`, changing nothing, when it
 * exists and either says the failure was delivered (`flowRecorded` is `1`) or
 * is no longer `dead` — the child itself was retried, which resets
 * `flowRecorded`, so only its state tells that case apart. A child with no
 * record still buries, and so does one that failed again (dead, unrecorded).
 * Read in this script, the one that buries, so no retry can land between the
 * read and the bury. The child's hash is in its own queue's keyspace; in
 * cluster mode a child on another queue is in another slot and cannot be read
 * here, so the driver reads it just before and passes its verdict
 * (`ARGV[9]`) — a window of one round trip instead of none.
 *
 * ARGV: prefix, parent id, child key (`queue:id`), kind (`completed`,
 * `ignored` or `failed`), the value or error as JSON, now, the child's
 * reference as JSON (`{"queue":…,"id":…}`), the child's hash key (empty when
 * it cannot be read in this script), and `1` when the driver found the
 * failure stale by reading the child first. Returns one of the
 * `ChildRecordResult` strings.
 */
const recordChild = (COUNT: string): string => `${QUEUE_PRELUDE}${COUNT}
local id, key, kind = ARGV[2], ARGV[3], ARGV[4]
local payload, now, ref = ARGV[5], tonumber(ARGV[6]), ARGV[7]
local childHash, stale = ARGV[8], ARGV[9] == '1'

local stored = redis.call('HMGET', job(id), 'state', 'flow', 'flowPending', 'runAt', 'priority')
if not stored[1] then
  return 'missing'
end

-- A job that does not list this child is not its parent.
local skeleton = stored[2]
if not skeleton or skeleton == '' then
  return 'missing'
end
local listed = string.find(skeleton, '"children":', 1, true)
if not listed or not string.find(skeleton, ref, listed, true) then
  return 'missing'
end

local valueField = '${FLOW_VALUE_PREFIX}' .. key
local failureField = '${FLOW_FAILURE_PREFIX}' .. key

-- Repeat-safe: an outcome already held changes nothing.
if redis.call('HEXISTS', job(id), valueField) == 1
  or redis.call('HEXISTS', job(id), failureField) == 1 then
  return 'already'
end

local field = kind == 'completed' and valueField or failureField

if stored[1] == 'dead' then
  -- A buried parent keeps a settled outcome for its retry, and refuses a
  -- failure: that child stays unsettled, for the retry to wait on.
  if kind == 'failed' then
    return 'parent-dead'
  end
  redis.call('HSET', job(id), field, payload)
  return 'recorded'
end

if stored[1] ~= 'waiting-children' then
  return 'already'
end

if kind == 'failed' then
  -- Stale: the parent was already told (it was buried once, and retried
  -- since), or the child has moved on from this failure (retried itself).
  if childHash ~= '' then
    local child = redis.call('HMGET', childHash, 'state', 'flowRecorded')
    stale = child[1] and (child[2] == '1' or child[1] ~= 'dead') or false
  end
  if stale then
    return 'already'
  end

  -- A failure not ignored buries the parent, the way FAIL buries a job.
  redis.call('ZREM', CHILDREN, id)
  redis.call('ZADD', DEAD, now, id)
  redis.call('HSET', job(id),
    'state', 'dead',
    'failedReason', payload,
    'finishedOn', tostring(now))
  countThroughput('failed', now)
  return 'buried'
end

local pending = math.max(0, (tonumber(stored[3]) or 0) - 1)
redis.call('HSET', job(id), field, payload, 'flowPending', tostring(pending))

if pending > 0 then
  return 'recorded'
end

redis.call('ZREM', CHILDREN, id)
local runAt = tonumber(stored[4]) or 0
if runAt > now then
  redis.call('ZADD', DELAYED, runAt, id)
  redis.call('HSET', job(id), 'state', 'delayed')
else
  -- The member it was given on add, so it keeps its place among equals.
  redis.call('ZADD', WAIT, tonumber(stored[5]) or 0, member(id))
  redis.call('HSET', job(id), 'state', 'waiting')
  wake()
end

return 'released'
`;

/**
 * Returns a parent buried by a child's failure to waiting on its children.
 *
 * Only a `dead` job with a flow qualifies. Outcomes already recorded are
 * kept, and the count left is taken here, in the same script: each child in
 * the skeleton with no value or failure field. The skeleton holds only
 * references, so decoding it cannot change anything a caller sees. With none
 * left it goes straight to waiting, or delayed when its `runAt` is later.
 *
 * Its own `flowRecorded` goes back to `0`, as {@link RETRY_JOB} does for a
 * child: the outcome it ends with this time has not reached its own parent,
 * and without the reset `RECORD_CHILD` would refuse a nested parent's second
 * failure as already delivered.
 *
 * ARGV: prefix, id, now. Returns 1 when it moved.
 */
export const REQUEUE_PARENT = `${QUEUE_PRELUDE}
local id, now = ARGV[2], tonumber(ARGV[3])

local stored = redis.call('HMGET', job(id), 'state', 'flow', 'flowRecorded', 'runAt', 'priority', 'createdAt')
if stored[1] ~= 'dead' or not stored[2] or stored[2] == '' then
  return 0
end

local ok, skeleton = pcall(cjson.decode, stored[2])
if not ok or type(skeleton) ~= 'table' then
  return 0
end

local pending = 0
if type(skeleton.children) == 'table' then
  for _, child in ipairs(skeleton.children) do
    local key = tostring(child.queue) .. ':' .. tostring(child.id)
    if redis.call('HEXISTS', job(id), '${FLOW_VALUE_PREFIX}' .. key) == 0
      and redis.call('HEXISTS', job(id), '${FLOW_FAILURE_PREFIX}' .. key) == 0 then
      pending = pending + 1
    end
  end
end

redis.call('ZREM', DEAD, id)
redis.call('HSET', job(id),
  'flowPending', tostring(pending),
  'failedReason', 'null',
  'finishedOn', '',
  'expiresAt', '')

-- What it ends with this time has not reached its own parent.
if stored[3] == '1' then
  redis.call('HSET', job(id), 'flowRecorded', '0')
end

if pending > 0 then
  redis.call('ZADD', CHILDREN, tonumber(stored[6]) or now, id)
  redis.call('HSET', job(id), 'state', 'waiting-children')
else
  local runAt = tonumber(stored[4]) or 0
  if runAt > now then
    redis.call('ZADD', DELAYED, runAt, id)
    redis.call('HSET', job(id), 'state', 'delayed')
  else
    redis.call('ZADD', WAIT, tonumber(stored[5]) or 0, member(id))
    redis.call('HSET', job(id), 'state', 'waiting')
    wake()
  end
end

return 1
`;

/**
 * Marks a child's outcome as recorded on its parent, then applies the
 * retention its completion or failure deferred.
 *
 * A job with no flow gains one: \`flowRecorded\` alone is enough for the
 * reader to build an empty flow around it. Retention runs through the same
 * \`retain\` as COMPLETE and FAIL, after clearing any expiry an earlier step
 * set, so the retention given here is the one that holds.
 *
 * ARGV: prefix, id, now, retention mode, count, ttl. Returns 1 when the job
 * exists.
 */
export const MARK_CHILD_RECORDED = `${QUEUE_PRELUDE}
local id, now = ARGV[2], tonumber(ARGV[3])
local mode, count, ttl = ARGV[4], ARGV[5], ARGV[6]

local current = state(id)
if not current then
  return 0
end

redis.call('HSET', job(id), 'flowRecorded', '1')

if current == 'completed' or current == 'dead' then
  if mode ~= 'remove' then
    redis.call('HSET', job(id), 'expiresAt', '')
  end
  retain(id, current == 'completed' and COMPLETED or DEAD, mode, count, ttl, now)
end

return 1
`;

/**
 * The hash field prefix a rewritten option is stored under, followed by the
 * option's name (`o:timeout`), holding the JSON the driver encoded. Written by
 * {@link REWRITE_PENDING} beside the blob, never into it, and laid over the
 * blob's `opts` by the reader. `priority` is the exception: it keeps the
 * `optsPriority` field {@link UPDATE_JOB} already writes.
 */
export const OPTION_FIELD_PREFIX = "o:";

/**
 * The hash field a rewritten `attempts` also writes, holding the job's new
 * `maxAttempts`, which the reader prefers over the blob's copy.
 */
export const MAX_ATTEMPTS_FIELD = `${OPTION_FIELD_PREFIX}maxAttempts`;

/**
 * The hash field holding a job's explicit mask once {@link UPDATE_JOB} has set
 * its priority bit, which the reader prefers over `opts.explicit` in the blob.
 * Only that write creates it, so the add path carries no field for the mask:
 * a new job's mask rides inside the blob's `opts`, which it writes anyway.
 */
export const EXPLICIT_MASK_FIELD = "xmask";

/**
 * The most jobs one {@link REWRITE_PENDING} call examines.
 *
 * A script blocks every client of the server while it runs, a claim included,
 * so a rewrite is cut into scripts this size: each is a few milliseconds of
 * decoding heads and writing fields, which is as long as a claim waits.
 */
export const REWRITE_BATCH_MAX = 200;

/**
 * How many bytes of stored blobs one {@link REWRITE_PENDING} call reads before
 * it stops early, however few jobs that is.
 *
 * Only the head of a blob is decoded, but Redis still copies the whole value
 * into the script to hand it over: measured, a batch of 200 jobs with 64 KB
 * payloads took 28–49 ms against 3.4 ms for small ones, all of it moving
 * payloads nobody reads. A budget keeps a script at a few milliseconds
 * whatever the payloads weigh; the walk simply takes more scripts.
 */
export const REWRITE_BLOB_BUDGET = 1024 * 1024;

/** {@link JOB_OPTION_BITS} as a Lua table literal, so the two cannot disagree. */
const OPTION_BITS_LUA = `{ ${Object.entries(JOB_OPTION_BITS)
  .map(([key, bit]) => `${key} = ${bit}`)
  .join(", ")} }`;

/**
 * Shared Lua for the scripts that read a job's stored options: its explicit
 * mask ({@link UPDATE_JOB}) and every option a rewrite compares
 * ({@link REWRITE_PENDING}).
 *
 * **Only the head of the blob is decoded.** `#toValues` writes the blob as
 * `{"name":…,"maxAttempts":…,"opts":{…},"data":…}`, so the head — everything
 * up to the brace closing `opts` — is a complete JSON object once a `}` is
 * appended, and decoding it never parses the payload, however large. The
 * closing brace is found by a scan that jumps from brace to quote to brace
 * (`objectEnd`), skipping string contents. The anchored pattern cannot match
 * text inside the name: in a JSON string every quote is escaped.
 *
 * A blob written before that order (payload ahead of `opts`) is decoded
 * whole — but only when the caller needs its options, or the blob has an
 * `"explicit":` somewhere in it. One without is certainly unmarked (older
 * than the mask), which is all a rewrite that skips unmarked jobs needs to
 * know, so the backlog that predates the mask costs no decode at all. A record
 * from before `blob` keeps `opts` in a field of its own, read the same way.
 *
 * Decoding is read-only: nothing here ever re-encodes what it decoded.
 */
const JOB_HEAD_PRELUDE = `
local BITS = ${OPTION_BITS_LUA}

-- Where a blob's leading name literal closes, or nil when it has none there.
local function nameEnd(blob)
  if string.sub(blob, 1, 9) ~= '{"name":"' then
    return nil
  end
  local from = 10
  while true do
    local quote = string.find(blob, '"', from, true)
    if not quote then
      return nil
    end
    -- A quote preceded by an odd run of backslashes (byte 92) is escaped.
    local slashes = 0
    while string.byte(blob, quote - 1 - slashes) == 92 do
      slashes = slashes + 1
    end
    if slashes % 2 == 0 then
      return quote
    end
    from = quote + 1
  end
end

-- The index of the brace closing the object that opens at from, or nil.
local function objectEnd(text, from)
  local depth, at = 0, from
  while true do
    local found = string.find(text, '[{}"]', at)
    if not found then
      return nil
    end
    local byte = string.byte(text, found)
    if byte == 34 then
      -- A string: on to its closing quote, past any escaped ones.
      local scan = found + 1
      while true do
        local quote = string.find(text, '"', scan, true)
        if not quote then
          return nil
        end
        local slashes = 0
        while string.byte(text, quote - 1 - slashes) == 92 do
          slashes = slashes + 1
        end
        scan = quote + 1
        if slashes % 2 == 0 then
          break
        end
      end
      at = scan
    elseif byte == 123 then
      depth = depth + 1
      at = found + 1
    else
      depth = depth - 1
      if depth == 0 then
        return found
      end
      at = found + 1
    end
  end
end

-- A whole JSON value decoded, when the caller needs it or it may hold a mask.
local function decodeWhole(text, needed)
  if not needed and not string.find(text, '"explicit":', 1, true) then
    return nil
  end
  local ok, value = pcall(cjson.decode, text)
  if ok and type(value) == 'table' then
    return value
  end
  return nil
end

-- A job's stored opts and maxAttempts, from its blob, or from the fields a
-- record from before the blob has. Either may come back nil: opts when the
-- job is certainly unmarked and needed is false, or when it cannot be read.
local function storedOptions(blob, optsField, maxField, needed)
  if blob then
    local stop = nameEnd(blob)
    if stop then
      local _, lead = string.find(blob, '^,"maxAttempts":[^,]*,"opts":{', stop + 1)
      if lead then
        local close = objectEnd(blob, lead)
        if close then
          local ok, head = pcall(cjson.decode, string.sub(blob, 1, close) .. '}')
          if ok and type(head) == 'table' then
            return head.opts, head.maxAttempts
          end
        end
      end
    end
    local whole = decodeWhole(blob, needed)
    if whole then
      return whole.opts, whole.maxAttempts
    end
    return nil, nil
  end
  local opts = optsField and decodeWhole(optsField, needed) or nil
  return opts, tonumber(maxField)
end

-- A job's explicit mask: the field UPDATE_JOB writes, else opts.explicit, else
-- nil for a job older than the mask.
local function explicitMask(stored, opts)
  local mask = tonumber(stored)
  if mask then
    return mask
  end
  if type(opts) == 'table' and type(opts.explicit) == 'number' then
    return opts.explicit
  end
  return nil
end
`;

/**
 * Changes a stored job's data, priority or due time, if its state allows.
 *
 * The state check and the write are one script, which is the whole point of
 * `onlyIn`: a job claimed between the caller reading it and calling this must
 * not be changed. The allowed states arrive already narrowed — `onlyIn`
 * intersected with waiting/delayed when `runAt` is patched — and so does the
 * state a new `runAt` leads to, since that depends only on `runAt` and `now`,
 * both of which the caller has.
 *
 * **Nothing here re-encodes JSON.** `data` and `opts` live inside `blob`, and
 * rewriting that in Lua would mean a cjson round trip, which changes the value:
 * an empty array comes back as an object and large integers lose precision.
 * Splicing the blob in the driver instead would need a read first, which is no
 * longer one step. So a patched payload goes into a `data` field of its own,
 * which the reader prefers over the blob's copy — the same field a record from
 * before `blob` already uses, so both shapes read back through one rule. A new
 * priority is written to `priority`, which the scripts already order by, and
 * to `optsPriority`, which the reader lays over `opts.priority`; that one only
 * exists once a priority has been patched, so an untouched job's `opts` reads
 * back exactly as it was added.
 *
 * A new priority re-scores the job's existing wait-set member, whose sequence
 * prefix is unchanged, so FIFO within a priority survives a reprioritisation.
 *
 * **A new priority is explicit.** It ORs the priority bit into the job's mask
 * and stores the result in `xmask` (`EXPLICIT_MASK_FIELD`), which the reader
 * prefers over `opts.explicit` — set even when the value is unchanged, since
 * choosing it is what pins it. A job with no mask (older than it) is left
 * without one. Finding the mask is the one read of JSON here: the head of the
 * blob, decoded and never re-encoded (`JOB_HEAD_PRELUDE`), and only when no
 * `xmask` exists yet.
 *
 * ARGV: prefix, id, setData, data, setPriority, priority, setRunAt, runAt,
 * nextState, then the allowed states — none at all meaning any state.
 * Returns the job's fields as they now are, or nothing when it was refused.
 */
export const UPDATE_JOB = `${QUEUE_PRELUDE}${JOB_HEAD_PRELUDE}
local id = ARGV[2]
local setData, data = ARGV[3] == '1', ARGV[4]
local setPriority, priority = ARGV[5] == '1', ARGV[6]
local setRunAt, runAt, nextState = ARGV[7] == '1', ARGV[8], ARGV[9]

local current = state(id)
if not current then
  return nil
end

if #ARGV >= 10 then
  local allowed = false
  for i = 10, #ARGV do
    if ARGV[i] == current then
      allowed = true
      break
    end
  end
  if not allowed then
    return nil
  end
end

if setData then
  redis.call('HSET', job(id), 'data', data)
end

if setPriority then
  local fields = { 'priority', priority, 'optsPriority', priority }
  local stored = redis.call('HMGET', job(id), '${EXPLICIT_MASK_FIELD}', 'blob', 'opts')
  local mask = tonumber(stored[1])
  if not mask then
    mask = explicitMask(nil, (storedOptions(stored[2], stored[3], nil, false)))
  end
  if mask then
    fields[#fields + 1] = '${EXPLICIT_MASK_FIELD}'
    fields[#fields + 1] = tostring(bit.bor(mask, BITS.priority))
  end
  redis.call('HSET', job(id), unpack(fields))
  if current == 'waiting' then
    -- ZADD on an existing member only moves its score, and the member keeps
    -- the sequence it was given on add.
    redis.call('ZADD', WAIT, tonumber(priority), member(id))
  end
end

if setRunAt then
  if current == 'waiting' then
    redis.call('ZREM', WAIT, member(id))
  else
    redis.call('ZREM', DELAYED, id)
  end

  if nextState == 'delayed' then
    redis.call('ZADD', DELAYED, tonumber(runAt), id)
  else
    redis.call('ZADD', WAIT, tonumber(redis.call('HGET', job(id), 'priority')), member(id))
  end

  redis.call('HSET', job(id), 'state', nextState, 'runAt', runAt)
  current = nextState
end

-- A job made claimable, or moved ahead of others, is worth a blocked worker
-- looking again. A payload change alone makes nothing newly claimable.
if current == 'waiting' and (setRunAt or setPriority) then
  wake()
end

return redis.call('HGETALL', job(id))
`;

/**
 * Rewrites the options of up to `count` jobs in one pending state, walking its
 * sorted set in order from a cursor — one batch of the driver's
 * `rewritePendingOptions`.
 *
 * **Atomic per batch, state re-checked per job.** The whole batch is one
 * script, so a job is examined and written with nothing in between: a claim
 * either ran before the script (the job is no longer in the set, and is never
 * met) or runs after it (and reads the whole rewritten record). Each job's
 * `state` is still checked against the walked one before anything is decided,
 * so a hash that disagrees with its set is counted `moved` and left alone.
 *
 * **The per-job rule is `planPendingRewrite`'s**, in Lua: no mask → skipped
 * unless `includeUnmarked`; a key is written only when its bit is clear and its
 * value differs — compared structurally, so an object stored with its keys in
 * another order is the same — where `attempts` also compares `maxAttempts` and
 * `priority` the `priority` field; nothing to write but an explicit key that
 * would have changed → `skippedExplicit`, nothing at all → `unchanged`;
 * `exhausted` when `attempts` is written and `attemptsMade` reaches it.
 *
 * **Values are written beside the blob, never into it** — the rule of
 * {@link UPDATE_JOB}, for the same reason: each goes into `o:<option>` exactly
 * as the driver encoded it; `attempts` also into `o:maxAttempts`; `priority`
 * into `priority` and `optsPriority`, re-scoring a waiting job's existing
 * member so it keeps its FIFO place among equal priorities. The mask is never
 * written. A job's current options are read the same way the reader builds
 * them: those fields over the blob's head (`JOB_HEAD_PRELUDE`).
 *
 * **The walk is a keyset walk.** The cursor is the `(score, member)` of the
 * last job examined — as the claim's exclusion cursor is — never a rank, since
 * ranks shift as jobs are claimed, added and re-scored. Resuming takes the
 * cursor member's rank when it still holds the cursor's score, and otherwise
 * (claimed, or moved by its own rewrite) the first entry ordered after the
 * pair, by a binary search within that score's run that compares members byte
 * by byte, as the sorted set orders them. A job re-scored ahead of the cursor
 * is met again and counts `unchanged`; nothing not yet visited moves behind
 * it. A waiting job's member is `sequence:id`; every other set's is the id.
 *
 * ARGV: prefix, state, whether a cursor follows (`1`), its score, its member,
 * count, includeUnmarked (`1`), dryRun (`1`), then option/JSON pairs in
 * `JOB_DEFAULT_KEYS` order. Reply: examined, rewritten, unchanged,
 * skippedExplicit, skippedUnmarked, moved, exhausted, then the last entry
 * examined — score and member, both empty when the set held nothing past the
 * cursor — and `1` when more entries follow it. A call may examine fewer than
 * `count` while more follow: it stops once it has read
 * {@link REWRITE_BLOB_BUDGET} bytes of blobs.
 */
export const REWRITE_PENDING = `${QUEUE_PRELUDE}${JOB_HEAD_PRELUDE}
local walked = ARGV[2]
local hasCursor, cursorScore, cursorMember = ARGV[3] == '1', ARGV[4], ARGV[5]
local count = tonumber(ARGV[6])
local includeUnmarked, dryRun = ARGV[7] == '1', ARGV[8] == '1'

local sets = { waiting = WAIT, delayed = DELAYED, failed = FAILED, ['waiting-children'] = CHILDREN }
local set = sets[walked]
if not set then
  return redis.error_reply('ERR not a pending state: ' .. tostring(walked))
end

-- The values, decoded once for comparing and kept encoded for writing.
local names, values, encoded = {}, {}, {}
for i = 9, #ARGV, 2 do
  local name = ARGV[i]
  names[#names + 1] = name
  encoded[name] = ARGV[i + 1]
  values[name] = cjson.decode(ARGV[i + 1])
end

-- What to read per job: the fields that place and count it, the ones laid
-- over the blob, and one override field per option being written.
local FIXED = { 'state', 'blob', 'opts', 'maxAttempts', 'priority', 'attemptsMade',
  '${EXPLICIT_MASK_FIELD}', '${MAX_ATTEMPTS_FIELD}' }
local reads = {}
for i, field in ipairs(FIXED) do
  reads[i] = field
end
for i, name in ipairs(names) do
  reads[#FIXED + i] = name == 'priority' and 'optsPriority' or '${OPTION_FIELD_PREFIX}' .. name
end

-- Whether two decoded JSON values are the same, whatever their key order.
local function same(a, b)
  if a == b then
    return true
  end
  if type(a) ~= 'table' or type(b) ~= 'table' then
    return false
  end
  local size = 0
  for key, value in pairs(a) do
    if not same(value, b[key]) then
      return false
    end
    size = size + 1
  end
  for _ in pairs(b) do
    size = size - 1
  end
  return size == 0
end

-- Members ordered as the sorted set orders them: byte by byte, never by the
-- server's collation, which is what Lua's < would use.
local function before(a, b)
  for i = 1, math.min(#a, #b) do
    local x, y = string.byte(a, i), string.byte(b, i)
    if x ~= y then
      return x < y
    end
  end
  return #a < #b
end

local start = 0
if hasCursor then
  local score = tonumber(cursorScore)
  if tonumber(redis.call('ZSCORE', set, cursorMember)) == score then
    start = redis.call('ZRANK', set, cursorMember) + 1
  else
    local lo = redis.call('ZCOUNT', set, '-inf', '(' .. cursorScore)
    local hi = lo + redis.call('ZCOUNT', set, cursorScore, cursorScore)
    while lo < hi do
      local mid = math.floor((lo + hi) / 2)
      if before(redis.call('ZRANGE', set, mid, mid)[1], cursorMember) then
        lo = mid + 1
      else
        hi = mid
      end
    end
    start = lo
  end
end

-- One entry more than the batch, to know whether any follow it.
local entries = redis.call('ZRANGE', set, start, start + count, 'WITHSCORES')
local seen = #entries / 2
local more = seen > count
if more then
  seen = count
end

local examined, rewritten, unchanged, skippedExplicit = 0, 0, 0, 0
local skippedUnmarked, moved, exhausted = 0, 0, 0
local lastScore, lastMember = '', ''
local bytes = 0

for n = 1, seen do
  -- Past the byte budget, stop here: the rest are for the next script.
  if bytes >= ${REWRITE_BLOB_BUDGET} then
    more = true
    break
  end

  local entry, score = entries[2 * n - 1], entries[2 * n]
  lastScore, lastMember = score, entry
  local id = set == WAIT and string.sub(entry, 18) or entry
  local stored = redis.call('HMGET', job(id), unpack(reads))
  bytes = bytes + (stored[2] and #stored[2] or 0) + (stored[3] and #stored[3] or 0)

  -- A set entry with no hash behind it is nothing to examine.
  if stored[1] then
    examined = examined + 1

    if stored[1] ~= walked then
      moved = moved + 1
    else
      -- Needed whole when unmarked jobs are rewritten too, or when the mask
      -- field says the job has one.
      local opts, maxAttempts = storedOptions(stored[2], stored[3], stored[4],
        includeUnmarked or stored[7] ~= false)
      local mask = explicitMask(stored[7], opts)

      if not mask and not includeUnmarked then
        skippedUnmarked = skippedUnmarked + 1
      else
        mask = mask or 0
        if type(opts) ~= 'table' then
          opts = {}
        end
        local max = tonumber(stored[8])
          or (type(maxAttempts) == 'number' and maxAttempts)
          or tonumber(stored[4]) or 0
        local column = tonumber(stored[5]) or 0
        local writes, blocked = {}, false

        for i, name in ipairs(names) do
          local override, current = stored[#FIXED + i], nil
          if override and override ~= '' then
            if name == 'priority' then
              current = tonumber(override)
            else
              local ok, decoded = pcall(cjson.decode, override)
              current = ok and decoded or nil
            end
          else
            current = opts[name]
          end

          local value = values[name]
          local differs = not same(current, value)
            or (name == 'attempts' and max ~= value)
            or (name == 'priority' and column ~= value)

          if differs then
            if bit.band(mask, BITS[name]) ~= 0 then
              blocked = true
            else
              writes[#writes + 1] = name
            end
          end
        end

        if #writes == 0 then
          if blocked then
            skippedExplicit = skippedExplicit + 1
          else
            unchanged = unchanged + 1
          end
        else
          rewritten = rewritten + 1
          local fields, rescore = {}, false
          for _, name in ipairs(writes) do
            if name == 'attempts' and (tonumber(stored[6]) or 0) >= values.attempts then
              exhausted = exhausted + 1
            end
            if name == 'priority' then
              rescore = true
              fields[#fields + 1] = 'priority'
              fields[#fields + 1] = encoded.priority
              fields[#fields + 1] = 'optsPriority'
              fields[#fields + 1] = encoded.priority
            elseif name == 'attempts' then
              fields[#fields + 1] = '${OPTION_FIELD_PREFIX}attempts'
              fields[#fields + 1] = encoded.attempts
              fields[#fields + 1] = '${MAX_ATTEMPTS_FIELD}'
              fields[#fields + 1] = encoded.attempts
            else
              fields[#fields + 1] = '${OPTION_FIELD_PREFIX}' .. name
              fields[#fields + 1] = encoded[name]
            end
          end

          if not dryRun then
            redis.call('HSET', job(id), unpack(fields))
            if rescore and set == WAIT then
              -- Only the score moves: the member keeps its add sequence.
              redis.call('ZADD', WAIT, values.priority, entry)
            end
          end
        end
      end
    end
  end
end

return { examined, rewritten, unchanged, skippedExplicit, skippedUnmarked, moved, exhausted,
  lastScore, lastMember, more and 1 or 0 }
`;

/**
 * Appends a line to a job's log, and caps it at its most recent lines.
 *
 * The existence check is in the same script as the push: a job removed in
 * between would otherwise be left an orphan log that nothing ever deletes.
 *
 * KEYS: job hash, log list. ARGV: line, keep (`0` keeps every line).
 * Returns how many lines the log keeps, or 0 when there is no such job.
 */
export const ADD_JOB_LOG = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end

redis.call('RPUSH', KEYS[2], ARGV[1])

local keep = tonumber(ARGV[2])
if keep > 0 then
  redis.call('LTRIM', KEYS[2], -keep, -1)
end

return redis.call('LLEN', KEYS[2])
`;

/**
 * A page of a job's log, and how many lines it keeps.
 *
 * A script rather than `LLEN` and `LRANGE` side by side, so the count and the
 * page describe the same list — a line appended in between would otherwise
 * shift a `desc` page by one.
 *
 * KEYS: log list. ARGV: offset, limit, order. Returns the count, then the
 * lines in the order asked for.
 */
export const GET_JOB_LOGS = `
local offset, limit = tonumber(ARGV[1]), tonumber(ARGV[2])
local count = redis.call('LLEN', KEYS[1])
local reply = { count }

if limit <= 0 or offset >= count then
  return reply
end

if ARGV[3] == 'desc' then
  -- Newest first: count the offset back from the tail.
  local stop = count - 1 - offset
  local start = math.max(0, stop - limit + 1)
  local lines = redis.call('LRANGE', KEYS[1], start, stop)
  for i = #lines, 1, -1 do
    reply[#reply + 1] = lines[i]
  end
else
  local lines = redis.call('LRANGE', KEYS[1], offset, offset + limit - 1)
  for _, line in ipairs(lines) do
    reply[#reply + 1] = line
  end
end

return reply
`;

/**
 * Empties a job's log, unless a worker is running it.
 *
 * The state check and the delete are one script, as they are in
 * {@link REMOVE_JOB}: a claim is a script too, so it lands wholly before this
 * (and the answer is `active`, nothing removed) or wholly after (and the
 * worker starts on an empty log). The count every read answers with is
 * `LLEN`, so deleting the list is what starts the next line from one.
 *
 * KEYS: job hash, log list. Returns `{ 'cleared', removed }`, `{ 'active' }`
 * or `{ 'missing' }`.
 */
export const CLEAR_JOB_LOGS = `
local current = redis.call('HGET', KEYS[1], 'state')

if not current then
  return { 'missing' }
end

if current == 'active' then
  return { 'active' }
end

local removed = redis.call('LLEN', KEYS[2])
redis.call('DEL', KEYS[2])
return { 'cleared', removed }
`;

/**
 * Replaces a named queue value, but only at the version the caller read.
 *
 * The comparison and the write are one script, which is the whole guarantee:
 * two callers naming the same version cannot both get past the check. The
 * versions are compared as the strings they are stored as, both being integers
 * the driver formatted; an absent entry compares as the empty string, which is
 * what the driver sends for "only if there is none". A delete removes the hash
 * outright, so a re-created entry starts again from 1.
 *
 * The names set is maintained here too, for `listQueueState`: a name joins it
 * when its entry is created and leaves when the entry is deleted. Doing both
 * in the script that writes the hash is what keeps the two from disagreeing.
 *
 * KEYS: state hash, names sorted set. ARGV: expected version (`''` for none),
 * delete (`1`/`0`), value as JSON, the entry's name. Returns the new version,
 * 0 after a delete, or nothing when the version had moved on.
 */
export const SET_QUEUE_STATE = `
local current = redis.call('HGET', KEYS[1], 'version')
if (current or '') ~= ARGV[1] then
  return nil
end

if ARGV[2] == '1' then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[4])
  return 0
end

if not current then
  redis.call('ZADD', KEYS[2], 0, ARGV[4])
end

local version = (tonumber(current) or 0) + 1
redis.call('HSET', KEYS[1], 'version', tostring(version), 'value', ARGV[3])
return version
`;

/* ------------------------------------------------------------------ *
 * Runner scripts
 * ------------------------------------------------------------------ */

/**
 * Shared by the lock scripts: a lock is stored as `token|expiresAt`.
 *
 * Redis could expire the key by itself, and the `PX` below still does as a
 * backstop, but the contract says times arrive as parameters — a caller
 * reasoning about a lock at some instant must get the same answer from every
 * driver. So the expiry that decides anything is compared against the `now`
 * the caller passed, and Redis's own clock only cleans up afterwards.
 *
 * The split is at the **last** `|`, as `getLock` splits the reply: the expiry
 * is a number and never holds one, but the token is the caller's string and
 * may. Splitting at the first would read a token `a|b` as the owner `a` with
 * no expiry, which every other token then takes as free to steal, and which
 * its own holder can neither renew nor release.
 */
const LOCK_PRELUDE = `
local function held(key)
  local stored = redis.call('GET', key)
  if not stored then
    return nil, nil
  end
  local owner, expiry = string.match(stored, '^(.*)|([^|]*)$')
  if not owner then
    return stored, 0
  end
  return owner, tonumber(expiry)
end
`;

/**
 * Takes a lock when it is free, expired, or already ours.
 *
 * KEYS: lock. ARGV: token, now, expiresAt, ttlMs. Returns 1 when it is ours.
 */
export const ACQUIRE_LOCK = `${LOCK_PRELUDE}
local token, now = ARGV[1], tonumber(ARGV[2])
local expiresAt, ttl = ARGV[3], tonumber(ARGV[4])

local owner, until_ = held(KEYS[1])
if owner and owner ~= token and until_ and until_ > now then
  return 0
end

redis.call('SET', KEYS[1], token .. '|' .. expiresAt, 'PX', ttl)
return 1
`;

/**
 * Extends a lock, but only for a holder whose lock has not lapsed.
 *
 * KEYS: lock. ARGV: token, now, expiresAt, ttlMs. Returns 1 when it was ours.
 */
export const RENEW_LOCK = `${LOCK_PRELUDE}
local token, now = ARGV[1], tonumber(ARGV[2])
local expiresAt, ttl = ARGV[3], tonumber(ARGV[4])

local owner, until_ = held(KEYS[1])
if owner ~= token or not until_ or until_ <= now then
  return 0
end

redis.call('SET', KEYS[1], token .. '|' .. expiresAt, 'PX', ttl)
return 1
`;

/**
 * Releases a lock, but only for whoever holds it.
 *
 * KEYS: lock. ARGV: token. Returns 1 when it was ours.
 */
export const RELEASE_LOCK = `${LOCK_PRELUDE}
local owner = held(KEYS[1])
if owner ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
`;

/**
 * Who holds a lock, as `token|expiresAt`, or nothing when it has lapsed on
 * the caller's clock.
 *
 * KEYS: lock. ARGV: now.
 */
export const GET_LOCK = `${LOCK_PRELUDE}
local owner, until_ = held(KEYS[1])
if not owner or not until_ or until_ <= tonumber(ARGV[1]) then
  return nil
end
return owner .. '|' .. tostring(until_)
`;

/**
 * Queues a trigger, unless the list is already full.
 *
 * The bound and the push are one operation, so two processes racing cannot
 * both find room.
 *
 * KEYS: queued list. ARGV: trigger, max. Returns 1 when it was queued.
 */
export const PUSH_QUEUED = `
local max = tonumber(ARGV[2])
if max > 0 and redis.call('LLEN', KEYS[1]) >= max then
  return 0
end
redis.call('RPUSH', KEYS[1], ARGV[1])
return 1
`;

/**
 * Takes the head of the queued triggers only if its id is the expected one.
 *
 * The read of the head, the comparison and the `LPOP` are one script, so no
 * other client's pop or push can land between them. A head that does not
 * decode is left alone, as is a missing key, which `LINDEX` does not create.
 *
 * KEYS: queued list. ARGV: expected id. Returns the popped element, or `nil`.
 */
export const POP_QUEUED_IF = `
local head = redis.call('LINDEX', KEYS[1], 0)
if not head then
  return false
end
local ok, decoded = pcall(cjson.decode, head)
if not ok or type(decoded) ~= 'table' or decoded.id ~= ARGV[1] then
  return false
end
return redis.call('LPOP', KEYS[1])
`;

/**
 * Prepends a run record and trims the history in one step.
 *
 * KEYS: history list. ARGV: record, keep.
 */
export const APPEND_HISTORY = `
redis.call('LPUSH', KEYS[1], ARGV[1])
local keep = tonumber(ARGV[2])
if keep > 0 then
  redis.call('LTRIM', KEYS[1], 0, keep - 1)
end
return 1
`;

/**
 * Appends captured output to one run's log, applies every cap, and reports
 * what the log holds afterwards.
 *
 * All of it in one script, because the caps only mean anything if they are
 * applied with the append: two flushes racing an `RPUSH` and an `LTRIM` from
 * outside would interleave into a log over its cap, or trim lines the other
 * had just added.
 *
 * **No line carries its own number.** The list is the order, and the meta
 * hash counts what has been dropped from the front — so line `i` of the list
 * is line `dropped + i + 1` of the run, and `RPUSH`/`LPOP` alone keep that
 * true. Numbering each line instead would mean decoding and re-encoding every
 * one of them here, and `cjson` is not a round trip worth taking on a hot
 * path.
 *
 * `#text` in Lua is the string's byte length, and Redis strings are bytes, so
 * the byte cap counts exactly the UTF-8 bytes the other drivers count.
 *
 * KEYS: meta hash, lines list, the runner's run index.
 * ARGV: runId, maxLines, maxBytes, keepRuns, the batch's byte total, the meta
 * key prefix, the lines key prefix, then the encoded lines.
 * Returns: count, dropped, lastSeq.
 */
export const APPEND_RUN_LOG = `
local meta, lines, runs = KEYS[1], KEYS[2], KEYS[3]
local runId = ARGV[1]
local maxLines, maxBytes = tonumber(ARGV[2]), tonumber(ARGV[3])
local keepRuns, added = tonumber(ARGV[4]), tonumber(ARGV[5])
local metaPrefix, linesPrefix = ARGV[6], ARGV[7]

-- The run joins the index the first time it logs, which makes the index the
-- order the runs first spoke — what \`keepRuns\` evicts by.
if redis.call('EXISTS', lines) == 0 and redis.call('HEXISTS', meta, 'dropped') == 0 then
  redis.call('RPUSH', runs, runId)
end

for i = 8, #ARGV do
  redis.call('RPUSH', lines, ARGV[i])
end

local bytes = tonumber(redis.call('HINCRBY', meta, 'bytes', added))
local dropped = tonumber(redis.call('HGET', meta, 'dropped')) or 0
local count = redis.call('LLEN', lines)

-- Both caps drop the oldest, and both have to account for what left, so they
-- pop one at a time rather than \`LTRIM\`ing in bulk.
local function dropOldest()
  local gone = redis.call('LPOP', lines)
  if not gone then
    return false
  end
  local ok, entry = pcall(cjson.decode, gone)
  if ok and entry and entry.text then
    bytes = bytes - #entry.text
  end
  dropped = dropped + 1
  count = count - 1
  return true
end

if maxLines > 0 then
  while count > maxLines and dropOldest() do end
end

-- One line always survives, however long: an empty log says less than an
-- over-long one.
if maxBytes > 0 then
  while bytes > maxBytes and count > 1 and dropOldest() do end
end

redis.call('HSET', meta, 'dropped', dropped, 'bytes', bytes)

if keepRuns > 0 then
  local known = redis.call('LLEN', runs)
  for _ = 1, known - keepRuns do
    local stale = redis.call('LPOP', runs)
    if not stale then
      break
    end
    redis.call('DEL', metaPrefix .. stale, linesPrefix .. stale)
  end
end

return { count, dropped, dropped + count }
`;

/**
 * A page of one run's log, with the run's own totals.
 *
 * A script rather than an `LLEN`, an `HGETALL` and an `LRANGE` side by side,
 * so the page and the numbers describe the same list: a flush landing between
 * two of those calls would shift a `desc` page by one and report a `dropped`
 * that never applied to the lines returned.
 *
 * Filtering happens in the driver rather than here. Both filters need the
 * decoded line, and Lua would have to \`cjson.decode\` the whole log to apply
 * them — the same work, but inside the one thread the whole server shares.
 *
 * KEYS: meta hash, lines list. Returns: dropped, then the lines, oldest first.
 */
export const GET_RUN_LOG = `
local dropped = tonumber(redis.call('HGET', KEYS[1], 'dropped')) or 0
local reply = { dropped }

for _, line in ipairs(redis.call('LRANGE', KEYS[2], 0, -1)) do
  reply[#reply + 1] = line
end

return reply
`;

/**
 * Replaces the history entry for one run.
 *
 * An entry is matched on its decoded `runId`, never a substring of its JSON:
 * another run's `result` or `error.message` can quote this run's id, and one
 * id can be a prefix of another, so a text search would overwrite a different
 * run's record and leave this one unsettled. Decoding every entry is bounded
 * by the list's cap, the runner's `keepHistory` (50 by default), which
 * {@link APPEND_HISTORY} enforces on every append; only `keepHistory: 0`
 * leaves the list uncapped.
 *
 * KEYS: history list. ARGV: runId, record. Returns 1 when it was found.
 */
export const UPDATE_HISTORY = `
local entries = redis.call('LRANGE', KEYS[1], 0, -1)
for index, entry in ipairs(entries) do
  local ok, record = pcall(cjson.decode, entry)
  if ok and type(record) == 'table' and record.runId == ARGV[1] then
    redis.call('LSET', KEYS[1], index - 1, ARGV[2])
    return 1
  end
end
return 0
`;

/**
 * Removes the named runs' history entries and their logs, and nothing else.
 *
 * One script, so a history entry cannot be settled back in by
 * {@link UPDATE_HISTORY} half way through, and every key is named by the
 * caller — all under the runner's hash tag — so nothing here walks the
 * keyspace. An entry is matched on its decoded `runId`, never a substring of
 * its JSON: one run's id can be a substring of another's, and the run not
 * named must stay whole. A named run's log goes whether or not it still had a
 * record. The index entry goes with its keys, so `keepRuns` never counts a
 * run that is no longer there.
 *
 * KEYS: history list, the runner's run index, then each named run's meta hash
 * and lines list, in pairs. ARGV: the run ids, in the same order as the pairs.
 * Returns how many history entries went.
 */
export const REMOVE_RUNS = `
local named = {}
for i = 1, #ARGV do
  named[ARGV[i]] = true
end

local removed = 0
for _, entry in ipairs(redis.call('LRANGE', KEYS[1], 0, -1)) do
  local ok, record = pcall(cjson.decode, entry)
  if ok and type(record) == 'table' and type(record.runId) == 'string' and named[record.runId] then
    removed = removed + redis.call('LREM', KEYS[1], 1, entry)
  end
end

for i = 1, #ARGV do
  redis.call('DEL', KEYS[1 + 2 * i], KEYS[2 + 2 * i])
  redis.call('LREM', KEYS[2], 0, ARGV[i])
end

return removed
`;

/* --- analytics (§4 of the analytics design) --------------------------- */

/**
 * Adds to the counters of one metrics hash.
 *
 * KEYS: the hash. ARGV: the expiry as an absolute epoch-ms time, then
 * field/delta pairs — a flush merges every bucket of one hash into a single
 * call, so a second's worth of counting for one entity is one round trip
 * however many buckets and counters it touched.
 *
 * **No retention is interpolated here**, unlike the throughput prelude: the
 * driver knows the bucket's width when it flushes, so the expiry is an
 * argument and this text is the same for every configuration. Retention only
 * has to reach the script text where the script computes the expiry itself,
 * which is exactly the case the design calls out (§9.10).
 */
export const METRIC_COUNT = `
for i = 2, #ARGV, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call('PEXPIREAT', KEYS[1], ARGV[1])
return 1
`;

/**
 * Adds to the duration statistics of one metrics hash.
 *
 * KEYS: the hash. ARGV: the expiry, then per bucket — offset, count, sumMs,
 * minMs, maxMs, how many histogram bins follow, then that many bin/delta pairs.
 * Only the bins that actually counted something are sent, which is typically
 * one or two of the 25 rather than an array of zeros.
 *
 * **Redis is where a per-bin increment is the right answer.** Every other
 * backend gives each writer its own row and writes the 25 bins wholesale,
 * because it has no cheap atomic increment of one element; here the writers
 * share the row and `HINCRBY` is free, which keeps the row count at one per
 * bucket instead of one per bucket per process.
 *
 * `minMs` and `maxMs` are read and compared rather than incremented, so they
 * stay exact across every writer; `sumMs` uses `HINCRBYFLOAT`, since a duration
 * need not be a whole millisecond.
 */
export const METRIC_DURATION = `
local key = KEYS[1]
local i = 2

while i <= #ARGV do
  local at = ARGV[i]
  redis.call('HINCRBY', key, at .. ':count', ARGV[i + 1])
  redis.call('HINCRBYFLOAT', key, at .. ':sumMs', ARGV[i + 2])

  local held = redis.call('HGET', key, at .. ':minMs')
  if not held or tonumber(held) > tonumber(ARGV[i + 3]) then
    redis.call('HSET', key, at .. ':minMs', ARGV[i + 3])
  end

  held = redis.call('HGET', key, at .. ':maxMs')
  if not held or tonumber(held) < tonumber(ARGV[i + 4]) then
    redis.call('HSET', key, at .. ':maxMs', ARGV[i + 4])
  end

  local bins = tonumber(ARGV[i + 5])
  local first = i + 6
  for bin = 0, bins - 1 do
    redis.call('HINCRBY', key, at .. ':b' .. ARGV[first + bin * 2], ARGV[first + bin * 2 + 1])
  end

  i = first + bins * 2
end

redis.call('PEXPIREAT', key, ARGV[1])
return 1
`;

/**
 * Adds busyness samples to one metrics hash.
 *
 * KEYS: the hash. ARGV: the expiry, then per bucket — offset, samples,
 * activeSum, activeMax, concurrency, lastAt.
 *
 * `concurrency` is not a sum and not an extreme: it is what the worker was
 * allowed to run at once **as of the latest sample**, so it is written together
 * with `lastAt` and only when this sample is at least as new as the one stored.
 * Without `lastAt` beside it, two writers in one bucket would leave it
 * undefined which of them won.
 */
export const METRIC_BUSYNESS = `
local key = KEYS[1]

for i = 2, #ARGV, 6 do
  local at = ARGV[i]
  redis.call('HINCRBY', key, at .. ':samples', ARGV[i + 1])
  redis.call('HINCRBY', key, at .. ':activeSum', ARGV[i + 2])

  local held = redis.call('HGET', key, at .. ':activeMax')
  if not held or tonumber(held) < tonumber(ARGV[i + 3]) then
    redis.call('HSET', key, at .. ':activeMax', ARGV[i + 3])
  end

  held = redis.call('HGET', key, at .. ':lastAt')
  if not held or tonumber(held) <= tonumber(ARGV[i + 5]) then
    redis.call('HSET', key, at .. ':lastAt', ARGV[i + 5], at .. ':concurrency', ARGV[i + 4])
  end
end

redis.call('PEXPIREAT', key, ARGV[1])
return 1
`;

/**
 * Names entities in a namespace's metrics index, and ages out the ones whose
 * buckets have all expired.
 *
 * KEYS: the index (a sorted set). ARGV: now, the score below which a member is
 * dropped, the index's expiry as an absolute epoch-ms time, then member/score
 * pairs.
 *
 * - `ZADD GT`: a member's score only ever moves later, so a retried flush of an
 *   older second cannot pull an entity's latest instant back.
 * - The trim runs on every write, so the set holds only entities with a bucket
 *   retention may still keep — its size is bounded by what is live, not by
 *   every entity that ever existed.
 * - The expiry only moves later too (a batch of second-wide rows must not
 *   shorten what a minute-wide one set), so a namespace nobody records in any
 *   more loses its index with its last hash. `PTTL` rather than
 *   `PEXPIRE … GT`: `GT` treats a key with no expiry as infinite, which a
 *   freshly created set is, and would never set one.
 *
 * One key, no hash tag needed — see `RedisKeys.metricsIndex`.
 */
export const METRIC_INDEX = `
local key = KEYS[1]

for i = 4, #ARGV, 2 do
  redis.call('ZADD', key, 'GT', ARGV[i + 1], ARGV[i])
end

redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. ARGV[2])

local left = redis.call('PTTL', key)
if left == -1 or (left >= 0 and left < tonumber(ARGV[3]) - tonumber(ARGV[1])) then
  redis.call('PEXPIREAT', key, ARGV[3])
end
return 1
`;

/**
 * What a driver instance's scripts are rendered against.
 *
 * Only the two retentions, because they are the only configuration a script
 * computes with rather than receives.
 */
export interface ScriptOptions {
  /**
   * How long per-second buckets are kept, ms. **`0` turns the per-second block
   * off entirely** — it is not rendered, so a minute-only driver's `COMPLETE`
   * is the script it always was.
   */
  secondRetentionMs: number;
  /** How long minute buckets are kept, ms. */
  minuteRetentionMs: number;
}

/** The scripts whose text depends on how the driver was configured. */
export interface RenderedScripts {
  /** Completes a job and counts it. */
  COMPLETE: string;
  /** Completes several jobs under one token, counting each. */
  COMPLETE_MANY: string;
  /** Fails an attempt and counts it. */
  FAIL: string;
  /** Buries a job and counts the failure. */
  BURY: string;
  /** Recovers stalled jobs, counting each burial as a failure. */
  RECOVER_STALLED: string;
  /** Records a child's outcome, counting a burial as a failure. */
  RECORD_CHILD: string;
}

/**
 * Renders the configuration-dependent scripts for one driver instance.
 *
 * **§9.10, and the reason this function exists at all.** These five embed the
 * retention in a `PEXPIREAT`, so a configurable retention changes their *text*
 * and with it their SHA. Rendered once per module and cached by name, a second
 * driver with a different retention would be served the first one's script and
 * silently write the first one's expiries — no error anywhere. So they are
 * rendered per instance, they are not exported as constants (nothing can reach
 * an unrendered one), and the driver's script cache is keyed by the **source
 * text**, never by a name.
 */
export function renderScripts(options: ScriptOptions): RenderedScripts {
  const count = throughputCount(options);

  return {
    COMPLETE: complete(count),
    COMPLETE_MANY: completeMany(count),
    FAIL: fail(count),
    BURY: bury(count),
    RECOVER_STALLED: recoverStalled(count),
    RECORD_CHILD: recordChild(count),
  };
}
