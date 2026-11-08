/**
 * How an embedding app answers "does the caller hold this permission": `true`
 * held, `false` lacked, `undefined` not a permission it knows. A standalone
 * viewer passes no probe and every permission renders plainly.
 */
export type PermissionProbe = (action: string) => boolean | undefined;
