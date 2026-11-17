/** The header's live-status badge: the kit's, with this app's wording. */
import { LiveStatusBadge } from "../../kit/components/LiveStatusBadge";
import { useLiveStatus } from "./context";
import { liveStatusInfo } from "./statusInfo";

/** See the module's description. */
export function LiveStatus() {
  const status = useLiveStatus();
  return (
    <LiveStatusBadge
      state={status.state}
      info={liveStatusInfo(status)}
    />
  );
}
