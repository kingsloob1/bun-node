import { Badge } from "../components/Badge";
import { useMeta } from "../meta/hooks";
import { liveStatusInfo } from "./liveStatusInfo";

/** The header's live-status badge. */
export function LiveStatus() {
  const meta = useMeta();
  const info = liveStatusInfo(meta.events, meta.publishing);
  return (
    <span
      className="live-status"
      data-testid="live-status"
    >
      <Badge
        tone={info.tone}
        title={info.title}
      >
        <span
          className="live-dot"
          aria-hidden="true"
        />
        {info.text}
      </Badge>
    </span>
  );
}
