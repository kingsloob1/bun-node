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
  "queues",
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
 * `blob` is `name`, `maxAttempts`, `data` and `opts` in one JSON value. No Lua
 * in this file reads any of those four, so they are only ever decoded by the
 * driver, and storing them apart bought nothing. Storing them together takes a
 * brand-new job's `HSET` from ten fields to seven, which is worth 83,525/s
 * against 109,828/s on 5,000 jobs: the cost of that statement is dominated by
 * how many fields it names. The one exception is {@link UPDATE_JOB}, which
 * never touches `blob` but writes `data` and `optsPriority` beside it — see
 * there for why, and `#toRecord` for how they win over the blob's copies.
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
] as const;

/** How many leading {@link JOB_FIELDS} a brand-new job carries. */
export const FRESH_JOB_FIELD_COUNT = 6;

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
local META, SEQ, WAKE, QUEUES = KEYS[7], KEYS[8], KEYS[9], KEYS[10]
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

local function wake()
  redis.call('LPUSH', WAKE, '1')
  redis.call('LTRIM', WAKE, 0, 99)
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
    local stale = redis.call('ZREVRANGE', set, keep, -1)
    for _, staleId in ipairs(stale) do
      redis.call('ZREM', set, staleId)
      drop(staleId)
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
local woke = false

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
    for i = 1, fieldCount do
      fields[#fields + 1] = FIELDS[i]
      fields[#fields + 1] = ARGV[at + i]
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
    else
      redis.call('ZADD', WAIT, priority, entry)
      woke = true
    end

    results[#results + 1] = 1
  end
end

-- Once for the batch, not once per job: the wake list is a signal, not a count.
if woke then
  wake()
end

redis.call('SADD', QUEUES, queue)
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
for i = 1, fieldCount do
  fields[#fields + 1] = FIELDS[i]
  fields[#fields + 1] = ARGV[at + i]
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
else
  redis.call('ZADD', WAIT, priority, entry)
  wake()
end

redis.call('SADD', QUEUES, queue)
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
 * ARGV: prefix, now, token, workerId, lockMs, promoteLimit, count, then the
 * names to exclude, if any. Excluding names bounds each claim's scan (see
 * `EXCLUDE_PRELUDE`), so it may claim fewer than `count` while more remain;
 * repeated claims resume from a cursor and work through any pile.
 */
export const CLAIM_MANY = `${QUEUE_PRELUDE}${EXCLUDE_PRELUDE}
local now, token = tonumber(ARGV[2]), ARGV[3]
local workerId, lockMs = ARGV[4], tonumber(ARGV[5])
local limit = tonumber(ARGV[6])
local count = tonumber(ARGV[7])

if redis.call('HGET', META, 'paused') == '1' then
  return {}
end

-- Anything due is claimable, so promote before looking. Once, not per job.
for _, set in ipairs({ DELAYED, FAILED }) do
  local due = redis.call('ZRANGEBYSCORE', set, '-inf', now, 'LIMIT', 0, limit)
  for _, id in ipairs(due) do
    redis.call('ZREM', set, id)
    redis.call('ZADD', WAIT, tonumber(redis.call('HGET', job(id), 'priority')), member(id))
    redis.call('HSET', job(id), 'state', 'waiting')
  end
end

-- Names to skip arrive after count. Without any, this is the plain head read
-- it always was: #ARGV is a length check in the VM, not a call to Redis.
local heads
if #ARGV >= 8 then
  heads = claimableHeads(8, count)
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
    'workerId', workerId)
  redis.call('HINCRBY', job(id), 'attemptsMade', 1)

  claimed[#claimed + 1] = redis.call('HGETALL', job(id))
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
 * ARGV: prefix, now, token, workerId, lockMs, promoteLimit, then the names to
 * exclude, if any. Excluding names bounds each claim's scan (see
 * `EXCLUDE_PRELUDE`), so it may return nothing while a claimable job sits
 * further back; repeated claims resume from a cursor and reach it.
 */
export const CLAIM = `${QUEUE_PRELUDE}${EXCLUDE_PRELUDE}
local now, token = tonumber(ARGV[2]), ARGV[3]
local workerId, lockMs = ARGV[4], tonumber(ARGV[5])
local limit = tonumber(ARGV[6])

if redis.call('HGET', META, 'paused') == '1' then
  return nil
end

-- Anything due is claimable, so promote before looking.
for _, set in ipairs({ DELAYED, FAILED }) do
  local due = redis.call('ZRANGEBYSCORE', set, '-inf', now, 'LIMIT', 0, limit)
  for _, id in ipairs(due) do
    redis.call('ZREM', set, id)
    redis.call('ZADD', WAIT, tonumber(redis.call('HGET', job(id), 'priority')), member(id))
    redis.call('HSET', job(id), 'state', 'waiting')
  end
end

-- Names to skip arrive after promoteLimit. Without any, this is the plain head
-- read it always was: #ARGV is a length check in the VM, not a call to Redis.
local entry
if #ARGV >= 7 then
  entry = claimableHeads(7, 1)[1]
  if not entry then
    return nil
  end
else
  local head = redis.call('ZRANGE', WAIT, 0, 0)
  if #head == 0 then
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
  'workerId', workerId)
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

if state(id) ~= 'active' or redis.call('HGET', job(id), 'lockToken') ~= token then
  return 0
end

redis.call('ZADD', ACTIVE, expiresAt, id)
redis.call('HSET', job(id), 'lockExpiresAt', tostring(expiresAt))
return 1
`;

/**
 * Completes a job, for its lock holder only.
 *
 * ARGV: prefix, id, token, now, returnValue, retention mode, count, ttl.
 */
export const COMPLETE = `${QUEUE_PRELUDE}
local id, token, now = ARGV[2], ARGV[3], tonumber(ARGV[4])
local result, mode, count, ttl = ARGV[5], ARGV[6], ARGV[7], ARGV[8]

if state(id) ~= 'active' or redis.call('HGET', job(id), 'lockToken') ~= token then
  return 0
end

redis.call('ZREM', ACTIVE, id)
redis.call('ZADD', COMPLETED, now, id)
redis.call('HSET', job(id),
  'state', 'completed',
  'finishedOn', tostring(now),
  'returnValue', result,
  'lockToken', '',
  'lockExpiresAt', '',
  'workerId', '')

retain(id, COMPLETED, mode, count, ttl, now)
return 1
`;

/**
 * Fails an attempt, for its lock holder only: either back to `failed` with a
 * retry time, or to `dead` for good.
 *
 * ARGV: prefix, id, token, now, error, stacktrace, retry, runAt, mode, count, ttl.
 */
export const FAIL = `${QUEUE_PRELUDE}
local id, token, now = ARGV[2], ARGV[3], tonumber(ARGV[4])
local err, stacktrace, retry = ARGV[5], ARGV[6], ARGV[7]
local runAt, mode, count, ttl = tonumber(ARGV[8]), ARGV[9], ARGV[10], ARGV[11]

if state(id) ~= 'active' or redis.call('HGET', job(id), 'lockToken') ~= token then
  return 0
end

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
 * Moves whatever has come due into the wait set.
 *
 * ARGV: prefix, now, limit. Returns how many moved.
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
  wake()
end

return moved
`;

/**
 * Recovers jobs whose worker died holding them: back to the queue, or to the
 * dead set once they have stalled too often.
 *
 * ARGV: prefix, now, maxStalled, limit. Returns { requeued… , '|', dead… }.
 */
export const RECOVER_STALLED = `${QUEUE_PRELUDE}
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
    dead[#dead + 1] = id
  else
    redis.call('ZADD', WAIT, tonumber(redis.call('HGET', job(id), 'priority')), member(id))
    redis.call('HSET', job(id), 'state', 'waiting', 'runAt', tostring(now))
    requeued[#requeued + 1] = id
  end
end

if #requeued > 0 then
  wake()
end

-- Lua cannot return nested tables, so the two lists are separated by a
-- marker the driver splits on.
local result = {}
for _, id in ipairs(requeued) do result[#result + 1] = id end
result[#result + 1] = '|'
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

if current == nil or current == false or current == 'active' or current == 'waiting' then
  return 0
end

redis.call('ZREM', DELAYED, id)
redis.call('ZREM', FAILED, id)
redis.call('ZREM', COMPLETED, id)
redis.call('ZREM', DEAD, id)

redis.call('ZADD', WAIT, tonumber(redis.call('HGET', job(id), 'priority')), member(id))
redis.call('HSET', job(id), 'state', 'waiting', 'runAt', tostring(now), 'finishedOn', '', 'expiresAt', '')

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
 * Removes finished jobs older than a cutoff.
 *
 * ARGV: prefix, set name, cutoff, limit. Returns the ids that went.
 */
export const CLEAN = `${QUEUE_PRELUDE}
local which, cutoff, limit = ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])
local sets = { waiting = WAIT, delayed = DELAYED, failed = FAILED, completed = COMPLETED, dead = DEAD }
local set = sets[which]
local removed = {}

if which == 'waiting' then
  -- The wait set is scored by priority, so age lives on the hash.
  local entries = redis.call('ZRANGE', set, 0, limit - 1)
  for _, entry in ipairs(entries) do
    local id = string.sub(entry, 18)
    if tonumber(redis.call('HGET', job(id), 'createdAt')) <= cutoff then
      redis.call('ZREM', set, entry)
      drop(id)
      removed[#removed + 1] = id
    end
  end
  return removed
end

local ids = redis.call('ZRANGEBYSCORE', set, '-inf', cutoff, 'LIMIT', 0, limit)
for _, id in ipairs(ids) do
  redis.call('ZREM', set, id)
  drop(id)
  removed[#removed + 1] = id
end
return removed
`;

/**
 * Removes jobs whose retention has expired.
 *
 * ARGV: prefix, now, limit. Returns how many went.
 */
export const PRUNE_EXPIRED = `${QUEUE_PRELUDE}
local now, limit = tonumber(ARGV[2]), tonumber(ARGV[3])
local removed = 0

for _, set in ipairs({ COMPLETED, DEAD }) do
  local ids = redis.call('ZRANGE', set, 0, limit - 1)
  for _, id in ipairs(ids) do
    local expiresAt = redis.call('HGET', job(id), 'expiresAt')
    if expiresAt and expiresAt ~= '' and tonumber(expiresAt) <= now then
      redis.call('ZREM', set, id)
      drop(id)
      removed = removed + 1
    end
  end
end

return removed
`;

/**
 * Drops pending jobs. Never touches what a worker is running.
 *
 * ARGV: prefix, includeDelayed. Returns how many went.
 */
export const DRAIN = `${QUEUE_PRELUDE}
local includeDelayed = ARGV[2]
local removed = 0

for _, entry in ipairs(redis.call('ZRANGE', WAIT, 0, -1)) do
  drop(string.sub(entry, 18))
  removed = removed + 1
end
redis.call('DEL', WAIT)
-- Exclusion cursors point into the wait set just emptied. See excludeCursors.
redis.call('DEL', string.sub(META, 1, -5) .. 'exclude')

if includeDelayed == '1' then
  for _, set in ipairs({ DELAYED, FAILED }) do
    for _, id in ipairs(redis.call('ZRANGE', set, 0, -1)) do
      drop(id)
      removed = removed + 1
    end
    redis.call('DEL', set)
  end
end

return removed
`;

/**
 * Every job in the given states, as a flat list of ids.
 *
 * ARGV: prefix, offset, limit, order, then one state per remaining argument.
 */
export const LIST_JOBS = `${QUEUE_PRELUDE}
local offset, limit, order = tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
local sets = { waiting = WAIT, delayed = DELAYED, failed = FAILED, active = ACTIVE, completed = COMPLETED, dead = DEAD }
local ids = {}

for i = 5, #ARGV do
  local set = sets[ARGV[i]]
  if set then
    local entries = redis.call('ZRANGE', set, 0, -1)
    for _, entry in ipairs(entries) do
      ids[#ids + 1] = (ARGV[i] == 'waiting') and string.sub(entry, 18) or entry
    end
  end
end

if order == 'desc' then
  local reversed = {}
  for i = #ids, 1, -1 do reversed[#reversed + 1] = ids[i] end
  ids = reversed
end

local page = {}
for i = offset + 1, math.min(#ids, offset + limit) do
  page[#page + 1] = ids[i]
end
return page
`;

/** How many jobs are in each state. ARGV: prefix. */
export const COUNT_JOBS = `${QUEUE_PRELUDE}
return {
  redis.call('ZCARD', WAIT),
  redis.call('ZCARD', DELAYED),
  redis.call('ZCARD', ACTIVE),
  redis.call('ZCARD', COMPLETED),
  redis.call('ZCARD', FAILED),
  redis.call('ZCARD', DEAD),
}
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
 * **Nothing here decodes JSON.** `data` and `opts` live inside `blob`, and
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
 * ARGV: prefix, id, setData, data, setPriority, priority, setRunAt, runAt,
 * nextState, then the allowed states — none at all meaning any state.
 * Returns the job's fields as they now are, or nothing when it was refused.
 */
export const UPDATE_JOB = `${QUEUE_PRELUDE}
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
  redis.call('HSET', job(id), 'priority', priority, 'optsPriority', priority)
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
 * Replaces a named queue value, but only at the version the caller read.
 *
 * The comparison and the write are one script, which is the whole guarantee:
 * two callers naming the same version cannot both get past the check. The
 * versions are compared as the strings they are stored as, both being integers
 * the driver formatted; an absent entry compares as the empty string, which is
 * what the driver sends for "only if there is none". A delete removes the hash
 * outright, so a re-created entry starts again from 1.
 *
 * KEYS: state hash. ARGV: expected version (`''` for none), delete (`1`/`0`),
 * value as JSON. Returns the new version, 0 after a delete, or nothing when
 * the version had moved on.
 */
export const SET_QUEUE_STATE = `
local current = redis.call('HGET', KEYS[1], 'version')
if (current or '') ~= ARGV[1] then
  return nil
end

if ARGV[2] == '1' then
  redis.call('DEL', KEYS[1])
  return 0
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
 */
const LOCK_PRELUDE = `
local function held(key)
  local stored = redis.call('GET', key)
  if not stored then
    return nil, nil
  end
  local sep = string.find(stored, '|', 1, true)
  if not sep then
    return stored, 0
  end
  return string.sub(stored, 1, sep - 1), tonumber(string.sub(stored, sep + 1))
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
 * Replaces the history entry for one run.
 *
 * KEYS: history list. ARGV: runId, record. Returns 1 when it was found.
 */
export const UPDATE_HISTORY = `
local entries = redis.call('LRANGE', KEYS[1], 0, -1)
for index, entry in ipairs(entries) do
  if string.find(entry, ARGV[1], 1, true) then
    redis.call('LSET', KEYS[1], index - 1, ARGV[2])
    return 1
  end
end
return 0
`;
