import { LiveStatusBadge } from "../../kit/components/LiveStatusBadge";
import { useUiConfig } from "../context";
import { useLiveStatus } from "../live";
import { liveStatusInfo } from "./liveStatusInfo";

/**
 * The header's live-status badge: live, connecting, reconnecting, or polling
 * (see {@link liveStatusInfo}), on the kit's badge, which announces each
 * change of state.
 */
export function LiveStatus() {
  const status = useLiveStatus();
  const { sections } = useUiConfig();
  return (
    <LiveStatusBadge
      state={status.state}
      info={liveStatusInfo(status, { docsOnly: !sections.manage })}
    />
  );
}
