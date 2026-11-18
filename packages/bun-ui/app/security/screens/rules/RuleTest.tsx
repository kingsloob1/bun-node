/**
 * Test a request (ui.md §4.5, `POST /rules/test`, `rules:test`): a request
 * described in a form, or pasted as a raw HTTP request or a `curl` command,
 * with the socket peer and the service's trust-proxy setting, the caller's
 * identity, what to assume of the address and of the counters, run through
 * a service's effective policy (or with the scope's draft in its place),
 * with no side effect. The result: the decision, every rule that matched,
 * how the client was resolved and through which hops, the keys it counts
 * against, the crawler verdict, every step in order, and what the test
 * could not evaluate. The control plane keeps nothing of it.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "../../../kit/components/Badge";
import { Button } from "../../../kit/components/Button";
import { dataOf } from "../../api/client";
import type { Routes } from "../../api/routes.gen";
import { ErrorView } from "../../components/ErrorView";
import { useSecurityClient } from "../../context";
import { Link } from "../../router";
import { scopeLabel } from "../../scope/scope";
import { serviceOf } from "../lists/policy";
import { headersOf, parseCurl, parseRawRequest } from "./requestParse";

/** `POST /rules/test`'s body. */
type RuleTestBody = Routes["POST /rules/test"]["body"];
/** Its answer. */
type RuleTestResult = Routes["POST /rules/test"]["responses"][200];

/** Props of {@link RuleTest}. */
export interface RuleTestProps {
  /** The scope on screen: a service's pre-fills the service; its draft may stand in. */
  scope: string;
}

/** The form, as typed. */
interface TestForm {
  service: string;
  useDraft: boolean;
  method: string;
  path: string;
  headers: string;
  peer: string;
  trust: "off" | "on" | "hops" | "ranges";
  trustValue: string;
  clientIpHeader: string;
  user: string;
  apiKey: string;
  tenant: string;
  session: string;
  routeKey: string;
  profile: string;
  country: string;
  asn: string;
  classes: string;
  score: string;
  limits: string;
}

/** The form's start. */
function emptyForm(service: string): TestForm {
  return {
    service,
    useDraft: false,
    method: "GET",
    path: "/",
    headers: "user-agent: Mozilla/5.0",
    peer: "203.0.113.10",
    trust: "off",
    trustValue: "",
    clientIpHeader: "",
    user: "",
    apiKey: "",
    tenant: "",
    session: "",
    routeKey: "",
    profile: "",
    country: "",
    asn: "",
    classes: "",
    score: "",
    limits: "",
  };
}

/** The request body for `form`, or the first reason it cannot be sent. */
function testBody(form: TestForm, scope: string): RuleTestBody | string {
  if (form.service.trim() === "")
    return "Choose the service whose policy decides";
  if (!form.path.startsWith("/")) return "The path starts with /";
  const headers = headersOf(form.headers);
  if (typeof headers === "string") return headers;
  let trustProxy: RuleTestBody["trustProxy"];
  if (form.trust === "on") trustProxy = true;
  else if (form.trust === "hops") {
    const hops = Number(form.trustValue);
    if (!Number.isInteger(hops) || hops < 0)
      return "The hop count is a whole number";
    trustProxy = hops;
  } else if (form.trust === "ranges") {
    const ranges = form.trustValue
      .split(/[\s,]+/)
      .filter((item) => item !== "");
    if (ranges.length === 0) return "Give the trusted ranges";
    trustProxy = ranges;
  }
  const identity = {
    ...(form.user.trim() === "" ? {} : { user: form.user.trim() }),
    ...(form.apiKey.trim() === "" ? {} : { apiKey: form.apiKey.trim() }),
    ...(form.tenant.trim() === "" ? {} : { tenant: form.tenant.trim() }),
    ...(form.session.trim() === "" ? {} : { session: form.session.trim() }),
  };
  const intel: { country?: string; asn?: number; classes?: string[] } = {};
  if (form.country.trim() !== "")
    intel.country = form.country.trim().toUpperCase();
  if (form.asn.trim() !== "") {
    const asn = Number(form.asn);
    if (!Number.isInteger(asn) || asn < 0) return "The ASN is a whole number";
    intel.asn = asn;
  }
  const classes = form.classes.split(/[\s,]+/).filter((item) => item !== "");
  if (classes.length > 0) intel.classes = classes;
  const assume: { score?: number; limits?: Record<string, number> } = {};
  if (form.score.trim() !== "") {
    const score = Number(form.score);
    if (!Number.isFinite(score) || score < 0)
      return "The score is a number of 0 or more";
    assume.score = score;
  }
  const limits: Record<string, number> = {};
  for (const line of form.limits.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = /^\s*([\w.-]+)\s*=\s*(\d+)\s*$/.exec(line);
    if (match === null) return `“${line.trim()}” is not limit=count`;
    limits[match[1]!] = Number(match[2]);
  }
  if (Object.keys(limits).length > 0) assume.limits = limits;
  return {
    service: form.service.trim(),
    ...(form.useDraft ? { draft: scope } : {}),
    method: form.method.trim().toUpperCase(),
    path: form.path,
    headers,
    peer: form.peer.trim(),
    ...(trustProxy === undefined ? {} : { trustProxy }),
    ...(form.clientIpHeader.trim() === ""
      ? {}
      : { clientIpHeader: form.clientIpHeader.trim() }),
    ...(Object.keys(identity).length === 0 ? {} : { identity }),
    ...(form.routeKey.trim() === "" ? {} : { routeKey: form.routeKey.trim() }),
    ...(form.profile.trim() === "" ? {} : { profile: form.profile.trim() }),
    ...(Object.keys(intel).length === 0 ? {} : { intel }),
    ...(Object.keys(assume).length === 0 ? {} : { assume }),
  };
}

/** A decision's badge tone. */
function tone(action: string) {
  if (action === "allow" || action === "log" || action === "tag")
    return "success";
  if (action === "challenge" || action === "delay") return "warning";
  return "danger";
}

/** See the module's description. */
export function RuleTest({ scope }: RuleTestProps) {
  const { client } = useSecurityClient();
  const [form, setForm] = useState<TestForm>(() =>
    emptyForm(serviceOf(scope) ?? ""),
  );
  const [paste, setPaste] = useState("");
  const [error, setError] = useState<string | null>(null);
  const services = useQuery({
    queryKey: ["rules", "services"],
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      dataOf(client.get("/services", { query: { limit: 200 }, signal })),
  });
  const test = useMutation({
    mutationFn: (body: RuleTestBody) =>
      dataOf(client.post("/rules/test", { body })),
  });
  const set = <K extends keyof TestForm>(key: K, value: TestForm[K]) =>
    setForm((old) => ({ ...old, [key]: value }));
  const field = (
    label: string,
    key: Exclude<keyof TestForm, "useDraft" | "trust">,
    hint?: string,
  ) => (
    <label>
      {label}{" "}
      <input
        className="input"
        value={form[key]}
        data-testid={`test-${key}`}
        {...(hint === undefined ? {} : { placeholder: hint })}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  );
  const readPaste = () => {
    setError(null);
    const text = paste.trim();
    const read = text.startsWith("curl")
      ? parseCurl(text)
      : parseRawRequest(text);
    if (typeof read === "string") {
      setError(`The pasted request: ${read}`);
      return;
    }
    setForm((old) => ({
      ...old,
      method: read.method,
      path: read.path,
      headers: Object.entries(read.headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n"),
    }));
  };
  const run = () => {
    setError(null);
    const body = testBody(form, scope);
    if (typeof body === "string") {
      setError(body);
      return;
    }
    test.mutate(body);
  };
  return (
    <div
      className="screen"
      data-testid="rule-test"
    >
      <p>
        <Link to={`/rules?scope=${encodeURIComponent(scope)}`}>
          Request rules
        </Link>
      </p>
      <h1>Test a request</h1>
      <p className="muted">
        Nothing is counted, banned or kept: the control plane runs the request
        through the policy and forgets it.
      </p>
      <section aria-label="Paste a request">
        <label>
          Paste a raw HTTP request or a curl command{" "}
          <textarea
            className="input"
            rows={4}
            value={paste}
            data-testid="test-paste"
            onChange={(e) => setPaste(e.target.value)}
          />
        </label>
        <Button
          size="sm"
          data-testid="test-read-paste"
          onClick={readPaste}
        >
          Fill the form from it
        </Button>
      </section>
      <form
        className="filters"
        aria-label="The request"
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        <label>
          Service{" "}
          <input
            className="input"
            list="test-services"
            value={form.service}
            data-testid="test-service"
            onChange={(e) => set("service", e.target.value)}
          />
          <datalist id="test-services">
            {(services.data?.items ?? []).map((item) => (
              <option
                key={item.id}
                value={item.id}
              />
            ))}
          </datalist>
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.useDraft}
            data-testid="test-use-draft"
            onChange={(e) => set("useDraft", e.target.checked)}
          />{" "}
          With {scopeLabel(scope)}'s draft in place of its published policy
        </label>
        {field("Method", "method")}
        {field("Path and query", "path", "/login?next=/")}
        <label>
          Headers (Name: value, one a line){" "}
          <textarea
            className="input"
            rows={4}
            value={form.headers}
            data-testid="test-headers"
            onChange={(e) => set("headers", e.target.value)}
          />
        </label>
        {field("Socket peer", "peer")}
        <label>
          The service trusts proxies{" "}
          <select
            className="input"
            value={form.trust}
            data-testid="test-trust"
            onChange={(e) => set("trust", e.target.value as TestForm["trust"])}
          >
            <option value="off">No (the default)</option>
            <option value="on">Yes, every hop</option>
            <option value="hops">A number of hops</option>
            <option value="ranges">Proxies in these ranges</option>
          </select>
        </label>
        {form.trust === "hops" || form.trust === "ranges"
          ? field(form.trust === "hops" ? "Hops" : "Ranges", "trustValue")
          : null}
        {field(
          "Client-IP header (optional)",
          "clientIpHeader",
          "cf-connecting-ip",
        )}
        {field("User id", "user")}
        {field("API key id", "apiKey")}
        {field("Tenant", "tenant")}
        {field("Session", "session")}
        {field("Route", "routeKey", "POST /login")}
        {field("Profile", "profile", "login")}
        {field("Assume country", "country", "DE")}
        {field("Assume ASN", "asn")}
        {field("Assume classes", "classes", "tor, hosting")}
        {field("Assume offence score", "score")}
        <label>
          Assume limits have counted (limit=count, one a line){" "}
          <textarea
            className="input"
            rows={2}
            value={form.limits}
            data-testid="test-limits"
            onChange={(e) => set("limits", e.target.value)}
          />
        </label>
        <div className="filters-actions">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={test.isPending}
            data-testid="test-run"
          >
            {test.isPending ? "Testing…" : "Test"}
          </Button>
        </div>
      </form>
      {error === null ? null : (
        <p
          role="alert"
          data-testid="test-error"
        >
          {error}
        </p>
      )}
      {test.isError ? (
        <ErrorView
          error={test.error}
          title="The test failed"
        />
      ) : null}
      {test.data === undefined ? null : <TestResult result={test.data} />}
    </div>
  );
}

/** The test's result. */
function TestResult({ result }: { result: RuleTestResult }) {
  const { decision, client } = result;
  return (
    <section
      aria-label="The result"
      data-testid="test-result"
    >
      <h2>
        Decision: <Badge tone={tone(decision.action)}>{decision.action}</Badge>
        {decision.status === undefined ? "" : ` ${decision.status}`}
        {decision.code === undefined ? "" : ` (${decision.code})`}
      </h2>
      <p className="muted">
        {result.service}'s policy: {result.policy.versions.join(" → ")}
        {result.policy.draft === null
          ? ""
          : ` (with ${result.policy.draft}'s draft)`}
        ; risk {decision.risk}
        {decision.delayMs === undefined
          ? ""
          : `; a delay of ${decision.delayMs} ms`}
        {decision.retryAfter === undefined
          ? ""
          : `; Retry-After ${decision.retryAfter} s`}
        .
      </p>
      <h3>Rules that matched</h3>
      {decision.hits.length === 0 ? (
        <p data-testid="test-no-hits">None.</p>
      ) : (
        <table
          className="table"
          data-testid="test-hits"
        >
          <thead>
            <tr>
              <th scope="col">Layer</th>
              <th scope="col">Rule</th>
              <th scope="col">Did</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {decision.hits.map((hit, index) => (
              <tr key={`${hit.rule}-${index}`}>
                <td>{hit.layer}</td>
                <td>
                  <code>{hit.rule}</code>
                </td>
                <td>
                  {hit.action}
                  {hit.wouldHaveBeen === undefined
                    ? ""
                    : ` (dry run: would have been ${hit.wouldHaveBeen})`}
                </td>
                <td>{hit.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>The client</h3>
      <p data-testid="test-client">
        {client.address ?? "no address"}
        {client.key === undefined || client.key === client.address
          ? ""
          : ` (counted as ${client.key})`}
        , from {client.source}
        {client.service === undefined
          ? ""
          : `; the calling service ${client.service}`}
        .
      </p>
      {client.chain.length === 0 ? null : (
        <ol data-testid="test-chain">
          {client.chain.map((hop, index) => (
            <li key={`${hop.address}-${index}`}>
              {hop.address} ({hop.source}):{" "}
              {hop.trusted ? "trusted proxy" : "not trusted"}
            </li>
          ))}
        </ol>
      )}
      {Object.keys(decision.subject).length === 0 ? null : (
        <>
          <h3>Keys it counts against</h3>
          <ul data-testid="test-keys">
            {Object.entries(decision.subject).map(([kind, key]) => (
              <li key={kind}>
                {kind}: <code>{key}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {decision.crawler === undefined ? null : (
        <p data-testid="test-crawler">
          Claims to be {decision.crawler.id}:{" "}
          {decision.crawler.spoofed
            ? "the claim is false"
            : decision.crawler.verified
              ? `verified by ${decision.crawler.verifiedBy ?? "?"}`
              : "not verified"}
          .
        </p>
      )}
      <h3>Every step</h3>
      <ol data-testid="test-steps">
        {result.steps.map((step, index) => (
          <li key={`${step.layer}-${index}`}>
            {step.layer}: {step.check}
            {step.rule === undefined ? "" : ` (${step.rule})`} → {step.outcome}
            {step.decided === true ? " — decided" : ""}
          </li>
        ))}
      </ol>
      {result.notEvaluated.length === 0 ? null : (
        <p
          className="muted"
          data-testid="test-not-evaluated"
        >
          Not evaluated as an enforcement point would:{" "}
          {result.notEvaluated.join(", ")}.
        </p>
      )}
    </section>
  );
}
