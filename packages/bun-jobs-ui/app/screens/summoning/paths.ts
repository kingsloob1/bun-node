/** A queue's Summon tab: the queue screen with `panel=summon`, relative to the app's base. */
export function summonTabPath(queue: string): string {
  return `/queues/${encodeURIComponent(queue)}?panel=summon`;
}

/**
 * A summon group's row on the Summoning screen: `/summon?group=<name>`,
 * relative to the app's base, the name encoded.
 */
export function summonGroupPath(name: string): string {
  return `/summon?group=${encodeURIComponent(name)}`;
}
