/* eslint-disable */
import { BunRouter } from "../lib/BunRouter";
import type { BunResponse } from "../lib/BunResponse";
import { toStandardSchema, validate } from "../lib/BunValidate";

interface U { id: string }
const US = toStandardSchema<U>((v) => ({ value: v as U }));
const vv = validate({}, { responses: { 200: US } });
const r = new BunRouter();

// B1: res.send() — is it constrained?
r.get("/b1", vv, (req, res) => res.status(200).send("anything at all"));

// B2: separate statements (status discarded) — still constrained, but only to the union
r.get("/b2", vv, (req, res) => { res.status(200); return res.json({ id: "x" }); });

// B3: res handed to a helper typed as plain BunResponse — escape hatch?
function helper(res: BunResponse) { return res.json({ literally: "anything" }); }
r.get("/b3", vv, (req, res) => helper(res));

// B4: async handler, awaited
r.get("/b4", vv, async (req, res) => { await Promise.resolve(); return res.status(200).json({ id: "y" }); });

// B5: returning a bare object (Nest style) — the router ignores it, so nothing is checked
r.get("/b5", vv, (req, res) => ({ totally: "unchecked" }));

// B6: jsonp / sendFile / redirect / end
r.get("/b6a", vv, (req, res) => res.status(200).jsonp({ whatever: 1 }));
r.get("/b6b", vv, (req, res) => res.status(200).end());
r.get("/b6c", vv, (req, res) => res.redirect("/elsewhere"));

// B7: no declared status ever sent — exhaustiveness is NOT checkable
r.get("/b7", vv, (req, res) => res.status(200).json({ id: "z" })); // 404 never sent: fine

export { r };
