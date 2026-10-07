/** A queue's Summon tab: the queue screen with `panel=summon`, relative to the app's base. */
export function summonTabPath(queue: string): string {
  return `/queues/${encodeURIComponent(queue)}?panel=summon`;
}
