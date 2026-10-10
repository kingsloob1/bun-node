/**
 * Keeping a summon budget's reads inside the window they were spent in.
 *
 * A summon budget counts attempts per UTC hour and per UTC day, in clock
 * windows: at HH:00:00 the hour's count starts over. An example that spends
 * the budget and then checks what it decided — a check skipped as `budget`,
 * the hour's count in `status()` or `GET /summon` — would see a correct
 * controller look broken if an hour turned between the two. So before such a
 * span it calls {@link withinOneHour}.
 */
import { show } from "./console";

/** One UTC hour, in ms: the budget's hourly window. */
const HOUR_MS = 3_600_000;

/** Milliseconds left in the current UTC hour. */
function hourLeft(): number {
  const now = Date.now();
  return Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS - now;
}

/**
 * Waits for the next UTC hour when less than `neededMs` of this one is left,
 * so the steps after it spend and read a summon budget inside one hourly
 * window — and one daily window, since midnight is an hour boundary too.
 * Returns at once otherwise: a run waits at most `neededMs`, and only when it
 * gets here in an hour's last `neededMs`. Says so when it waits.
 *
 * `neededMs` should be well above how long the guarded steps take on a loaded
 * machine; each caller says what it measured.
 */
export async function withinOneHour(neededMs: number): Promise<void> {
  let left = hourLeft();
  while (left < neededMs) {
    show(
      "a summon budget counts per UTC hour, and this one ends in",
      `${left} ms: waiting for the next`,
    );
    await Bun.sleep(left + 50);
    left = hourLeft();
  }
}
