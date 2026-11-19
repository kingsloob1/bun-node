import { Fragment, useEffect, useState } from "react";
import { Dialog } from "../../kit/components/Dialog";
import { isUiEvent, useMountRoot } from "../../kit/frame";
import { findSearchBox, SHORTCUT_HELP, shortcutFor } from "./shortcuts";

/**
 * Listens for the app's shortcuts on the document: `/` focuses the current
 * screen's search box, `?` opens a dialog listing the shortcuts. Neither
 * fires while typing in a field, with a modifier held, or while a dialog is
 * open (the page behind it is inert). When a host mounted the UI, only a key
 * pressed inside the mount element counts, and the search box is looked up
 * inside it (embedding.md §8: two mounts on a page never both react).
 */
export function KeyboardShortcuts() {
  const [helpOpen, setHelpOpen] = useState(false);
  const root = useMountRoot();

  useEffect(() => {
    const scope: ParentNode = root ?? document;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = shortcutFor(event);
      if (
        action === null ||
        !isUiEvent(root, event) ||
        scope.querySelector("dialog[open]")
      ) {
        return;
      }
      if (action === "show-help") {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }
      const main = scope.querySelector<HTMLElement>("#main");
      const search = main && findSearchBox(main);
      if (search) {
        event.preventDefault();
        search.focus();
        search.select();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [root]);

  return (
    <Dialog
      open={helpOpen}
      onClose={() => setHelpOpen(false)}
      title="Keyboard shortcuts"
      description="Shortcuts do nothing while you type in a field."
      size="sm"
    >
      <dl
        className="shortcut-list"
        data-testid="shortcut-list"
      >
        {SHORTCUT_HELP.map((entry) => (
          <div
            key={entry.description}
            className="shortcut-row"
          >
            <dt>
              {entry.keys.map((key, index) => (
                <Fragment key={key}>
                  {index > 0 && " "}
                  <kbd>{key}</kbd>
                </Fragment>
              ))}
            </dt>
            <dd>{entry.description}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
