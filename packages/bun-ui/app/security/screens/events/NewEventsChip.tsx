/**
 * The "N new — show" chip of an events list (ui.md §5), over
 * {@link useNewEvents}: absent while nothing new arrived.
 */
import type { NewEvents } from "./useNewEvents";
import { Button } from "../../../kit/components/Button";

/** Props of {@link NewEventsChip}. */
export interface NewEventsChipProps {
  /** The count and how to show them. */
  news: NewEvents;
  /** The chip's test id. */
  testId?: string;
}

/** The chip; absent while nothing new arrived. */
export function NewEventsChip({
  news,
  testId = "events-new",
}: NewEventsChipProps) {
  if (news.count === 0 && !news.gap) return null;
  return (
    <Button
      size="sm"
      data-testid={testId}
      onClick={news.show}
    >
      {news.count === 0
        ? "New events may have arrived — show"
        : `${news.count.toLocaleString()} new${news.gap ? " or more" : ""} — show`}
    </Button>
  );
}
