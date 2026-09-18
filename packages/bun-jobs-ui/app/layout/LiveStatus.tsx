import { Badge } from "../components/Badge";
import { useLiveStatus } from "../live";
import { liveStatusInfo } from "./liveStatusInfo";

/** The header's live-status badge: live, connecting, reconnecting, or polling (see {@link liveStatusInfo}). */
export function LiveStatus() {
  const status = useLiveStatus();
  const info = liveStatusInfo(status);
  return (
    <span
      className="live-status"
      data-testid="live-status"
      data-state={status.state}
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
