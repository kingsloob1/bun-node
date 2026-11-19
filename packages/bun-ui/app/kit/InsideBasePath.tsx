/** A mounted UI's guard for a URL outside its `basePath` (embedding.md §5). */
import type { ReactNode } from "react";
import { use } from "react";
import { RouterContext } from "./routing";

/** Renders nothing when the URL is outside the UI's `basePath` (the host owns that page), else `children`. */
export function InsideBasePath({ children }: { children: ReactNode }) {
  const router = use(RouterContext);
  return router !== null && router.location.path === null ? null : children;
}
