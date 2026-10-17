class Router {
  get(path: string): this { void path; return this; }
  post(path: string): this { void path; return this; }
}
declare const router: Router;
declare const verb: "get" | "post";
export const byUnion = router[verb]; // element access with a union-typed key
export const byName = router.get; // both tools report this one
