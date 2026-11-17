/**
 * The kit's `Pager` walking a cursor list whose trail is in the URL
 * ({@link useUrlCursor}): Next follows the page's `next`, Previous goes back
 * one, the size starts the walk again. The rows are unnumbered (a cursor
 * page does not know what precedes it).
 */
import type { UrlCursor } from "./urlCursor";
import { Pager } from "../../kit/components/Pager";

/** Props of {@link UrlPager}. */
export interface UrlPagerProps {
  /** The list's position in the URL. */
  position: UrlCursor;
  /** The page shown: its rows and the API's `next`. */
  page:
    { readonly items: readonly unknown[]; readonly next?: string } | undefined;
  /** The pager's accessible name. */
  label?: string;
}

/** See the module's description. */
export function UrlPager({ position, page, label }: UrlPagerProps) {
  return (
    <Pager
      offset={0}
      limit={position.limit}
      itemCount={page?.items.length ?? 0}
      hasMore={page?.next !== undefined}
      walk={{
        canNext: page?.next !== undefined,
        canPrev: position.depth > 0,
        unnumbered: true,
      }}
      maxPageSize={200}
      {...(label === undefined ? {} : { label })}
      onChange={(move) => {
        if (move.step === "next" && page?.next !== undefined)
          position.next(page.next);
        else if (move.step === "prev") position.prev();
        else if (move.limit !== position.limit) position.setLimit(move.limit);
      }}
    />
  );
}
