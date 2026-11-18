/**
 * Every text field in bun-ui's apps has an example placeholder, and every
 * select an empty first option (BU-placeholders, the user's rule): the
 * scanner (`scan.ts`) reads each TSX file of `app/jobs`, `app/security`,
 * `app/docs` and `app/kit` with TypeScript's parser. The kit's own controls
 * (`inputs.tsx`) are the definitions that forward `placeholder`, not uses.
 * The negative controls give the scanner one field of each kind without
 * one, and the kinds that take none (an always-set select among them), and
 * require it to tell them apart.
 */
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { expectNone } from "../harness/assert";
import { scan } from "./scan";

const ROOT = join(import.meta.dir, "../..");

/** The kit's control definitions: they forward `placeholder`. */
const DEFINITIONS = new Set(["app/kit/components/inputs.tsx"]);

describe("placeholders", () => {
  it("every text field in the apps has an example placeholder, every select an empty option", async () => {
    const findings = [];
    let files = 0;
    for (const file of new Bun.Glob(
      "app/{jobs,security,docs,kit}/**/*.tsx",
    ).scanSync({ cwd: ROOT })) {
      if (DEFINITIONS.has(file)) continue;
      files++;
      findings.push(...scan(file, await Bun.file(join(ROOT, file)).text()));
    }
    expect(files).toBeGreaterThan(100);
    expectNone(
      findings.map((f) => `${f.file}:${f.line} ${f.element} has no ${f.lacks}`),
      "fields without a placeholder",
    );
  });

  it("negative control: a field of each kind without one is found; the kinds that take none are not", () => {
    const source = `
      export function Form() {
        return (
          <form>
            <input value={a} />
            <input type="search" placeholder="" />
            <textarea rows={3} />
            <TextInput value={b} onChange={setB} />
            <NumberInput value={c} onChange={setC} />
            <JsonEditor value={d} onChange={setD} />
            <Select value={e} options={OPTIONS} onChange={setE} />
            <select value={f}>
              <option value="a">A</option>
            </select>
            <input type="checkbox" checked={g} />
            <input type="date" value={h} />
            <input type="file" />
            <input type="datetime-local" value={i} />
            <input placeholder="e.g. checkout-api" value={j} />
            <TextInput placeholder={example} value={k} onChange={setK} />
            <select value={l}>
              <option value="" disabled>Choose a kind</option>
              <option value="a">A</option>
            </select>
            <select value={m}>
              {cond ? <option value="">Any</option> : null}
            </select>
            <Select alwaysSet value={n} options={SIZES} onChange={setN} />
            <select data-always-set value={o}>
              <option value="10">10</option>
            </select>
          </form>
        );
      }`;
    const found = scan("fixture.tsx", source).map(
      (f) => `${f.element}:${f.lacks}`,
    );
    expect(found).toEqual([
      "input:placeholder",
      "input:placeholder",
      "textarea:placeholder",
      "TextInput:placeholder",
      "NumberInput:placeholder",
      "JsonEditor:placeholder",
      "Select:placeholder",
      "select:an empty option",
    ]);
  });
});
