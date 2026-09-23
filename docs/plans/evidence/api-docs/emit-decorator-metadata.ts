/* eslint-disable */
import "reflect-metadata";

function Prop(): PropertyDecorator {
  return () => {};
}
class Inner { x = 1; }
class Dto {
  @Prop() name!: string;
  @Prop() age!: number;
  @Prop() flag!: boolean;
  @Prop() when!: Date;
  @Prop() nested!: Inner;
  @Prop() list!: string[];
  @Prop() maybe?: string;
}
const keys = ["name","age","flag","when","nested","list","maybe"];
for (const k of keys) {
  const t = (Reflect as any).getMetadata?.("design:type", Dto.prototype, k);
  console.log(k.padEnd(8), "->", t ? (t.name ?? String(t)) : String(t));
}
console.log("own metadata keys on prototype.name:",
  JSON.stringify((Reflect as any).getMetadataKeys?.(Dto.prototype, "name") ?? null));
