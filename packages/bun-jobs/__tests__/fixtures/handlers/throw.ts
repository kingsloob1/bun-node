import { defineHandler } from "../../../lib/index";

/** Always fails, with a code so the serialised error can be checked. */
export default defineHandler(() => {
  throw Object.assign(new Error("handler blew up"), { code: "E_BOOM" });
});
