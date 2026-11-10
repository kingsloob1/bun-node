/**
 * The viewer's router: the kit's small history router
 * (`app/kit/routing.ts`), re-exported here because this file is the
 * `./docs/embed/routing` entry a host app imports. Every UI shares the ONE
 * router context through it (the jobs app imports it by that name), so the
 * embedded references' links navigate the host's router.
 */
export * from "../kit/routing";
