import { EmptyState } from "../components/EmptyState";

/** Props of {@link PlaceholderScreen}. */
export interface PlaceholderScreenProps {
  /** The screen's heading. */
  title: string;
  /** The milestone it arrives in. */
  milestone: number;
}

/** A screen that is routed and gated, but not built yet. */
export function PlaceholderScreen({
  title,
  milestone,
}: PlaceholderScreenProps) {
  return (
    <div
      className="screen"
      data-testid="placeholder"
    >
      <h1 className="screen-title">{title}</h1>
      <EmptyState
        title="Coming in a later milestone"
        description={`This screen arrives in milestone ${milestone}.`}
      />
    </div>
  );
}
