/**
 * A keyed list of the policy (rate limits, counted rules), hand-built (the
 * user's decision of 2026-11-18): the scope's own items and the ones it
 * inherits, merged by `id` as the control plane merges them
 * (control-plane.md §2.2). An inherited item shows where it comes from and
 * offers **Override** (a copy here, edited) and **Turn off here**
 * (`{ id, mode: "off" }`); one a scope above locked is greyed, "locked by
 * …", with neither. An own item that overrides an inherited one offers
 * **Reset to inherited**; any other, **Remove**. Items are edited in a
 * dialog whose fields come from the item's JSON Schema.
 */
import type { JsonObject } from "./paths";
import type { SchemaNode } from "./schema";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { Dialog } from "../../../kit/components/Dialog";
import { Field } from "../../../kit/components/Field";
import { FieldControl } from "./controls";
import { usePolicyEditor } from "./editorContext";
import { LockedNote, ScopeLink } from "./fields";
import { getAt, isObject, keyedPath, lockedAbove, originOf } from "./paths";
import { controlOf, hintOf, labelOf, propertiesOf } from "./schema";

/** Props of {@link KeyedItems}. */
export interface KeyedItemsProps {
  /** The policy's array, dotted (`limits`, `countedRules`, `requestRules.rules`). */
  section: string;
  /** One item's schema. */
  item: SchemaNode;
  /** A one-line summary of an item. */
  summary: (item: JsonObject) => string;
  /** The noun, singular (`limit`). */
  noun: string;
}

/** One row: an own item, an inherited one, or both (an override). */
interface Row {
  /** The item's id. */
  readonly id: string;
  /** The scope's own item and its index, when it has one. */
  readonly own?: { readonly item: JsonObject; readonly index: number };
  /** The inherited item and the scope it comes from, when there is one. */
  readonly inherited?: { readonly item: JsonObject; readonly origin: string };
  /** The scope above that locked it. */
  readonly lockedBy?: string;
}

/** The items of `value` (an array of objects with ids), with their indexes. */
function itemsOf(value: unknown): { item: JsonObject; index: number }[] {
  return Array.isArray(value)
    ? value.flatMap((item: unknown, index) =>
        isObject(item) && typeof item.id === "string" ? [{ item, index }] : [],
      )
    : [];
}

/** Props of {@link ItemDialog}. */
interface ItemDialogProps {
  /** The item being edited, or `null` when closed. */
  editing: JsonObject | null;
  /** The item's schema. */
  item: SchemaNode;
  /** The noun. */
  noun: string;
  /** Whether its id is fixed (an existing item). */
  fixedId: boolean;
  /** Closes it. */
  onClose: () => void;
  /** Saves the item into the working policy. */
  onSave: (item: JsonObject) => void;
}

/** The item editor: a field per schema property. */
function ItemDialog(props: ItemDialogProps) {
  return props.editing === null ? null : (
    <OpenItemDialog
      {...props}
      editing={props.editing}
    />
  );
}

/** The open dialog: its state lasts one opening. */
function OpenItemDialog({
  editing,
  item,
  noun,
  fixedId,
  onClose,
  onSave,
}: ItemDialogProps & { editing: JsonObject }) {
  const [value, setValue] = useState<JsonObject>(editing);
  const id = typeof value.id === "string" ? value.id : "";
  return (
    <Dialog
      open
      onClose={onClose}
      title={fixedId ? `Edit ${noun} ${id}` : `New ${noun}`}
      size="lg"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="item-apply"
            disabled={id === ""}
            onClick={() => onSave(value)}
          >
            Apply
          </Button>
        </>
      }
    >
      <div
        className="policy-item-form"
        data-testid="item-form"
      >
        {Object.entries(propertiesOf(item) ?? {}).map(([key, node]) => {
          const control = controlOf(node);
          const hint = hintOf(node);
          return (
            <Field
              key={key}
              label={labelOf(key)}
              {...(hint === undefined ? {} : { hint })}
            >
              <FieldControl
                control={control}
                label={control.kind === "boolean" ? "On" : labelOf(key)}
                value={value[key]}
                disabled={key === "id" && fixedId}
                testId={`item-${key}`}
                onChange={(next) =>
                  setValue((old) => {
                    const copy = { ...old };
                    if (next === undefined) delete copy[key];
                    else copy[key] = next;
                    return copy;
                  })
                }
              />
            </Field>
          );
        })}
      </div>
    </Dialog>
  );
}

/** See the module's description. */
export function KeyedItems({ section, item, summary, noun }: KeyedItemsProps) {
  const editor = usePolicyEditor();
  const [editing, setEditing] = useState<{
    item: JsonObject;
    fixedId: boolean;
  } | null>(null);
  const sectionPath = section.split(".");
  const own = itemsOf(getAt(editor.working, sectionPath));
  const inherited = itemsOf(
    getAt(editor.effective?.policy, sectionPath),
  ).flatMap(({ item: found }) => {
    const id = found.id as string;
    const origin =
      editor.effective === undefined
        ? undefined
        : originOf(editor.effective, keyedPath(section, id));
    return origin === undefined || origin === editor.scope
      ? []
      : [{ id, item: found, origin }];
  });
  const rows: Row[] = [];
  for (const { id, item: found, origin } of inherited) {
    const mine = own.find((o) => o.item.id === id);
    const lockedBy = lockedAbove(
      editor.effective,
      editor.scope,
      keyedPath(section, id),
    );
    rows.push({
      id,
      inherited: { item: found, origin },
      ...(mine === undefined ? {} : { own: mine }),
      ...(lockedBy === undefined ? {} : { lockedBy }),
    });
  }
  for (const mine of own) {
    if (!rows.some((row) => row.id === mine.item.id))
      rows.push({ id: mine.item.id as string, own: mine });
  }
  const current = getAt(editor.working, sectionPath);
  const list = Array.isArray(current) ? (current as unknown[]) : [];
  /** Puts `next` in place of the own item with its id, or appends it. */
  const save = (next: JsonObject) => {
    const at = own.find((o) => o.item.id === next.id);
    const copy = [...list];
    if (at === undefined) copy.push(next);
    else copy[at.index] = next;
    editor.set(sectionPath, copy);
    setEditing(null);
  };
  const remove = (index: number) => {
    const copy = list.filter((_, i) => i !== index);
    editor.set(sectionPath, copy.length === 0 ? undefined : copy);
  };
  return (
    <div data-testid={`keyed-${section}`}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Id</th>
            <th scope="col">What</th>
            <th scope="col">Mode</th>
            <th scope="col">Where from</th>
            {editor.canEdit ? (
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const shown = row.own?.item ?? row.inherited!.item;
            const merged = { ...row.inherited?.item, ...row.own?.item };
            const issues = row.own
              ? editor.issuesAt([...sectionPath, row.own.index])
              : [];
            return (
              <tr
                key={row.id}
                data-testid={`item-row-${row.id}`}
                data-state={
                  row.lockedBy !== undefined
                    ? "locked"
                    : row.own === undefined
                      ? "inherited"
                      : row.inherited === undefined
                        ? "own"
                        : "override"
                }
                className={
                  row.lockedBy === undefined ? undefined : "policy-row-locked"
                }
              >
                <td>
                  <code>{row.id}</code>
                </td>
                <td>
                  {summary(merged)}
                  {issues.length === 0 ? null : (
                    <span className="field-error"> {issues.join("; ")}</span>
                  )}
                </td>
                <td>
                  {typeof merged.mode === "string" ? merged.mode : "enforce"}
                </td>
                <td data-testid={`item-origin-${row.id}`}>
                  {row.lockedBy !== undefined ? (
                    <LockedNote by={row.lockedBy} />
                  ) : row.inherited === undefined ? (
                    "Set here"
                  ) : row.own === undefined ? (
                    <>
                      Inherited from <ScopeLink scope={row.inherited.origin} />
                    </>
                  ) : (
                    <>
                      Overrides <ScopeLink scope={row.inherited.origin} />
                    </>
                  )}
                </td>
                {editor.canEdit ? (
                  <td className="policy-row-actions">
                    {row.lockedBy !== undefined ? null : row.own ===
                      undefined ? (
                      <>
                        <Button
                          size="sm"
                          data-testid={`item-override-${row.id}`}
                          onClick={() =>
                            setEditing({ item: { ...shown }, fixedId: true })
                          }
                        >
                          Override
                        </Button>
                        {merged.mode === "off" ? null : (
                          <Button
                            size="sm"
                            variant="ghost"
                            data-testid={`item-off-${row.id}`}
                            onClick={() => save({ id: row.id, mode: "off" })}
                          >
                            Turn off here
                          </Button>
                        )}
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          data-testid={`item-edit-${row.id}`}
                          onClick={() =>
                            setEditing({
                              item: { ...row.own!.item },
                              fixedId: true,
                            })
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid={`item-remove-${row.id}`}
                          onClick={() => remove(row.own!.index)}
                        >
                          {row.inherited === undefined
                            ? "Remove"
                            : "Reset to inherited"}
                        </Button>
                      </>
                    )}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? (
        <p
          className="muted"
          data-testid={`keyed-${section}-empty`}
        >
          No {noun} here or above.
        </p>
      ) : null}
      {editor.canEdit ? (
        <Button
          size="sm"
          data-testid={`item-new-${section}`}
          onClick={() => setEditing({ item: {}, fixedId: false })}
        >
          New {noun}
        </Button>
      ) : null}
      <ItemDialog
        editing={editing?.item ?? null}
        fixedId={editing?.fixedId ?? false}
        item={item}
        noun={noun}
        onClose={() => setEditing(null)}
        onSave={save}
      />
    </div>
  );
}
