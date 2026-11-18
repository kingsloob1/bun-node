/**
 * The placeholder rule's scanner (BU-placeholders): reads each app's TSX
 * with TypeScript's parser and names every text field without an example
 * placeholder and every select without an empty first option.
 *
 * - **Text fields**: a raw `<input>` of a text-like type (no `type`, or
 *   `text`, `search`, `email`, `url`, `tel`, `password`, `number`), a
 *   `<textarea>`, and the kit's `TextInput`, `NumberInput` and `JsonEditor`
 *   need a `placeholder` that is not empty. Checkboxes, radios, dates and
 *   times, files, ranges, colours and buttons have none.
 * - **Selects**: a select that can be empty says what to choose: a raw
 *   `<select>` needs an `<option value="">` among its children (a "Choose
 *   a …" one, or an "Any" choice), the kit's `Select` a `placeholder` (it
 *   renders the empty option). A select that always holds a value (a sort,
 *   a page size) opts out, a raw one with `data-always-set`, the kit's with
 *   `alwaysSet`: it shows no "Choose a …" entry (the user's decision of
 *   2026-11-18: a placeholder is for an empty field).
 * - An element spreading props (`{...rest}`) is checked on what it states;
 *   the kit's own controls, which forward `placeholder` through `rest`, are
 *   the definitions, not uses, and are skipped.
 */
import ts from "typescript";

/** One field breaking the rule. */
export interface Finding {
  /** The file, as given. */
  readonly file: string;
  /** Its line, 1-based. */
  readonly line: number;
  /** The element. */
  readonly element: string;
  /** What it lacks. */
  readonly lacks: "placeholder" | "an empty option";
}

/** Input types that take no placeholder. */
const NO_PLACEHOLDER = new Set([
  "checkbox",
  "radio",
  "file",
  "date",
  "datetime-local",
  "time",
  "month",
  "week",
  "hidden",
  "range",
  "color",
  "submit",
  "button",
  "reset",
  "image",
]);

/** The kit's components that take a required placeholder. */
const KIT_TEXT = new Set(["TextInput", "NumberInput", "JsonEditor", "Select"]);

/** An attribute's static string value, `""` for an empty one, or `null` when it is not a string literal. */
function stringOf(attribute: ts.JsxAttribute): string | null {
  const init = attribute.initializer;
  if (init === undefined) return null;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression !== undefined) {
    const expression = init.expression;
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    )
      return expression.text;
    return "\u0000dynamic";
  }
  return null;
}

/** The attribute `name` on an opening element, if any. */
function attributeOf(
  attributes: ts.JsxAttributes,
  name: string,
): ts.JsxAttribute | undefined {
  return attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

/** Whether a `<select>`'s children hold an `<option value="">`, directly or in a conditional. */
function hasEmptyOption(element: ts.JsxElement): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (opening !== undefined && opening.tagName.getText() === "option") {
      const value = attributeOf(opening.attributes, "value");
      if (value !== undefined && stringOf(value) === "") found = true;
    }
    ts.forEachChild(node, visit);
  };
  for (const child of element.children) visit(child);
  return found;
}

/** Every field in `source` (TSX text of `file`) breaking the rule. */
export function scan(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out: Finding[] = [];
  const line = (node: ts.Node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node) => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (opening !== undefined) {
      const tag = opening.tagName.getText(sf);
      const attributes = opening.attributes;
      const placeholder = attributeOf(attributes, "placeholder");
      const filled = placeholder !== undefined && stringOf(placeholder) !== "";
      if (tag === "input") {
        const type = attributeOf(attributes, "type");
        const typeValue = type === undefined ? "text" : stringOf(type);
        const textLike = typeValue === null || !NO_PLACEHOLDER.has(typeValue);
        if (textLike && !filled)
          out.push({
            file,
            line: line(node),
            element: "input",
            lacks: "placeholder",
          });
      } else if (tag === "textarea") {
        if (!filled)
          out.push({
            file,
            line: line(node),
            element: "textarea",
            lacks: "placeholder",
          });
      } else if (tag === "select" && ts.isJsxElement(node)) {
        const alwaysSet =
          attributeOf(attributes, "data-always-set") !== undefined;
        if (!alwaysSet && !hasEmptyOption(node))
          out.push({
            file,
            line: line(node),
            element: "select",
            lacks: "an empty option",
          });
      } else if (KIT_TEXT.has(tag)) {
        // The kit's Select opts out of a placeholder with `alwaysSet`.
        const alwaysSet =
          tag === "Select" &&
          attributeOf(attributes, "alwaysSet") !== undefined;
        if (!filled && !alwaysSet)
          out.push({
            file,
            line: line(node),
            element: tag,
            lacks: "placeholder",
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
