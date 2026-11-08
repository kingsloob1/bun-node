import type { RefCallback } from "react";
import { useCallback, useState } from "react";

/**
 * Whether an element has scrolled into view, latched: once `true` it stays
 * `true`, so work it started is not thrown away when it scrolls out again.
 * Without `IntersectionObserver` everything counts as visible.
 */
export function useInView<T extends Element>(
  rootMargin = "200px",
): [RefCallback<T>, boolean] {
  const [inView, setInView] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const ref = useCallback<RefCallback<T>>(
    (element) => {
      if (!element || inView || typeof IntersectionObserver === "undefined") {
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setInView(true);
            observer.disconnect();
          }
        },
        { rootMargin },
      );
      observer.observe(element);
      return () => observer.disconnect();
    },
    [inView, rootMargin],
  );
  return [ref, inView];
}
