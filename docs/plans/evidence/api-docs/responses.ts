/* eslint-disable */
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import { toStandardSchema } from "../lib/BunValidate";

interface User { id: string; name: string }
interface Problem { code: string }

const UserS = toStandardSchema<User>((v) => ({ value: v as User }));
const ProblemS = toStandardSchema<Problem>((v) => ({ value: v as Problem }));
const IdParams = toStandardSchema<{ id: string }>((v) => ({ value: v as { id: string } }));

const r = new BunRouter();

// ---- 1. POSITIVE: declared responses reach the handler's `res` ----
const v = validate(
  { params: IdParams },
  { responses: { 200: UserS, 404: ProblemS } },
);

r.get("/u/:id", v, (req, res) => {
  const id: string = req.params.id;              // request shape still narrowed
  return res.status(200).json({ id, name: "a" }); // OK
});

r.get("/u2/:id", v, (req, res) => res.status(404).json({ code: "NOPE" }));

// ---- 2. NEGATIVE: wrong body for the chosen status ----
r.get("/bad1/:id", v, (req, res) =>
  // @ts-expect-error 200 declares User, not Problem
  res.status(200).json({ code: "NOPE" }),
);

// ---- 3. NEGATIVE: undeclared status ----
r.get("/bad2/:id", v, (req, res) =>
  // @ts-expect-error 418 is not a declared status
  res.status(418).json({ id: "x", name: "y" }),
);

// ---- 4. NEGATIVE: bare json() without status must still be constrained ----
r.get("/bad3/:id", v, (req, res) =>
  // @ts-expect-error neither declared body
  res.json({ nope: true }),
);

// ---- 5. CONTROL: no responses declared => unconstrained, as today ----
const plain = validate({ params: IdParams });
r.get("/free/:id", plain, (req, res) => res.status(418).json({ anything: 1 }));
r.get("/free2/:id", (req, res) => res.status(599).json({ anything: 1 }));

// ---- 6. MOUNTED SUB-ROUTER: validator at the mount ----
const sub = new BunRouter<"/users/:uid", { responses: { 200: User } }>();
sub.get("/posts", (req, res) => res.status(200).json({ id: "1", name: "n" }));
sub.get("/posts2", (req, res) =>
  // @ts-expect-error mount declared 200: User
  res.status(200).json({ code: "x" }),
);
const mountV = validate({}, { responses: { 200: UserS } });
r.use("/users/:uid", mountV, sub);

export { r };
