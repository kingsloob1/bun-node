/**
 * Makes an input report `text` as its value (and `badInput` as its
 * validity), as a browser would, past happy-dom's sanitising: happy-dom
 * blanks a `datetime-local` value `Date` cannot hold, where a browser keeps
 * a well-formed one, and never flags a half-typed entry. Fire a `change`
 * after it. Returns the values the page wrote to the input meanwhile, and a
 * `restore` putting the element's own value handling back.
 */
export function stubRawValue(
  input: HTMLInputElement,
  text: string,
  badInput = false,
): { written: string[]; restore: () => void } {
  const written: string[] = [];
  Object.defineProperty(input, "value", {
    configurable: true,
    get: () => text,
    set: (value: string) => {
      written.push(value);
    },
  });
  Object.defineProperty(input, "validity", {
    configurable: true,
    get: () => ({ badInput }),
  });
  return {
    written,
    restore: () => {
      Reflect.deleteProperty(input, "value");
      Reflect.deleteProperty(input, "validity");
    },
  };
}
