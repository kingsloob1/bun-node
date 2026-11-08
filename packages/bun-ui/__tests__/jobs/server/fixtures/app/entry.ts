/**
 * A stand-in for `app/main.tsx`, so the server tests build something small
 * and do not depend on the real app: one CSS import (so the build emits a
 * stylesheet) and one dynamic import (so it emits a split chunk).
 */
import "./entry.css";

/** Marks the page as booted, for anything that loads this bundle. */
(globalThis as { bunJobsUiFixture?: string }).bunJobsUiFixture = "entry";

void import("./lazy").then((lazy) => lazy.markLazy());
