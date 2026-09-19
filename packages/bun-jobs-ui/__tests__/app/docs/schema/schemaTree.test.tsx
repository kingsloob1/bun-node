import { describe, expect, it, mock } from "bun:test";
import { SchemaTree } from "../../../../app/screens/docs/schema";
import { fireEvent, render, setupDom, within } from "../../dom";

setupDom();

/** A document exercising refs, a cycle, a union, enums and closed objects. */
const doc = {
  components: {
    schemas: {
      Node: {
        type: "object",
        description: "A tree node.",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          children: {
            type: "array",
            items: { $ref: "#/components/schemas/Node" },
          },
          order: { type: "string", enum: ["asc", "desc"], default: "asc" },
          value: {
            oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
};

/** Renders a tree and returns its root element. */
function tree(
  props: Partial<Parameters<typeof SchemaTree>[0]> = {},
): HTMLElement {
  const { container } = render(
    <SchemaTree
      schema={{ $ref: "#/components/schemas/Node" }}
      root={doc}
      label="Node schema"
      {...props}
    />,
  );
  return container.querySelector<HTMLElement>(".schema-tree")!;
}

/** The node of a property, by its shown name. */
function node(root: HTMLElement, name: string): HTMLElement {
  const found = Array.from(
    root.querySelectorAll<HTMLElement>(".schema-node"),
  ).find(
    (item) =>
      item.querySelector(":scope > .schema-row > .schema-name")?.textContent ===
      name,
  );
  if (!found) {
    throw new Error(`no node ${name}`);
  }
  return found;
}

describe("SchemaTree", () => {
  it("renders a $ref by its name, with the target's type, description and fields", () => {
    const root = tree();
    expect(root.getAttribute("aria-label")).toBe("Node schema");
    const top = root.querySelector(".schema-node")!;
    expect(top.querySelector(".schema-ref")!.textContent).toBe("Node");
    expect(top.querySelector(".schema-type")!.textContent).toBe("object");
    expect(top.textContent).toContain("A tree node.");
    expect(node(root, "name").textContent).toContain("required");
    expect(node(root, "order").textContent).not.toContain("required");
  });

  it("marks additionalProperties: false as no other fields", () => {
    const root = tree();
    expect(
      within(root).getAllByTestId("schema-closed")[0]!.textContent,
    ).toContain("No other fields");
  });

  it("lists enums, defaults and bounds as facts", () => {
    const root = tree();
    const order = node(root, "order");
    expect(order.querySelector('[data-fact="enum"]')!.textContent).toBe(
      'one of "asc", "desc"',
    );
    expect(order.querySelector('[data-fact="default"]')!.textContent).toBe(
      'default "asc"',
    );
    const name = node(root, "name");
    expect(name.querySelector('[data-fact="minLength"]')!.textContent).toBe(
      "min length 1",
    );
    expect(name.querySelector('[data-fact="maxLength"]')!.textContent).toBe(
      "max length 200",
    );
  });

  it("labels oneOf alternatives under a heading", () => {
    const root = tree({ depth: 3 });
    const value = node(root, "value");
    expect(value.querySelector(".schema-composition")!.textContent).toBe(
      "Exactly one of",
    );
    expect(node(value, "Option 1").textContent).toContain("integer");
    expect(node(value, "Option 2").textContent).toContain("null");
  });

  it("renders a recursive schema finitely, marking the cycle", () => {
    const root = tree({ depth: 50 });
    const items = node(node(root, "children"), "[]");
    expect(items.querySelector(".schema-ref")!.textContent).toBe("Node");
    expect(items.textContent).toContain("recursive");
    // No toggle: a cycle is never expanded again.
    expect(
      items.querySelector(":scope > .schema-row > .schema-toggle"),
    ).toBeNull();
    expect(root.querySelectorAll(".schema-node").length).toBeLessThan(20);
  });

  it("expands and collapses a node, starting from depth", () => {
    const root = tree({ depth: 0 });
    const toggle = within(root).getByRole("button", { name: "Expand schema" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelectorAll(".schema-node")).toHaveLength(1);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(node(root, "name")).toBeTruthy();
  });

  it("makes ref names buttons calling onRef when given", () => {
    const onRef = mock((_ref: string, _name: string) => {});
    const root = tree({ onRef });
    fireEvent.click(within(root).getAllByRole("button", { name: "Node" })[0]!);
    expect(onRef).toHaveBeenCalledWith("#/components/schemas/Node", "Node");
  });

  it("reports an unresolved $ref instead of failing", () => {
    const root = tree({ schema: { $ref: "#/components/schemas/Missing" } });
    expect(root.textContent).toContain("unresolved $ref");
    expect(root.querySelector(".schema-ref")!.textContent).toBe("Missing");
  });
});
