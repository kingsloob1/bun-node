/** The screens loaded on demand (the kit's `onDemand`): the first load carries the shell and the Overview. */
import { onDemand } from "../../kit/onDemand";

/** `/api`, on demand: the reference viewer is the largest part of the app. */
export const ApiReferenceScreen = onDemand(
  async () => (await import("./ApiReference")).ApiReference,
  "Loading the API reference",
);
