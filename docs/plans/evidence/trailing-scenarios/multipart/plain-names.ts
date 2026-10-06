import { parse } from "picoquery";
const opts = { nesting: true, nestingSyntax: "js", arrayRepeat: true, arrayRepeatSyntax: "repeat" } as const;
const names = ["a","field","Field_1","x-y","0","12","__proto__","constructor","prototype","hasOwnProperty","toString","_","-","a b","a.b","a[b]","a+b","a%20b","é","a]","valueOf","__defineGetter__"];
for (const n of names) {
  const out = parse(`${n}=${encodeURIComponent("v&=+%")}`, opts as any) as any;
  const same = Object.keys(out).length === 1 && Object.hasOwn(out, n) && out[n] === "v&=+%";
  console.log(JSON.stringify(n), same, JSON.stringify(out), Object.getPrototypeOf(out) === Object.prototype);
}
