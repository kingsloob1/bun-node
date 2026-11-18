/**
 * The docs viewer's frame for `chrome: "tabs"` (embedding.md §12 item 8):
 * the kit's compact bar holding the one section of `DOCS_SECTIONS` that
 * matches the document, read from the location (the viewer's `/` sends an
 * OpenAPI document to `/http` and an AsyncAPI one to `/ws`). `"full"` and
 * `"none"` draw nothing: the viewer has no header.
 */
import { FrameBar } from "../../kit/components/FrameBar";
import { Link } from "../router";
import { useLocation } from "../routing";
import { docsSectionAt } from "./sections";

/** See the module's description. */
export function DocsTabs() {
  const section = docsSectionAt(useLocation().path);
  if (section === null) return null;
  return (
    <FrameBar
      tabs={
        <li>
          <Link
            to={section.path}
            activeMatch="prefix"
            className="app-tab"
          >
            {section.label}
          </Link>
        </li>
      }
    />
  );
}
