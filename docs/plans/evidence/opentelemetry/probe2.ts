import { context, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor, InMemorySpanExporter, AlwaysOnSampler, AlwaysOffSampler } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

const N = 500_000;
const bench = (label: string, fn: (i: number) => void, n = N) => {
  for (let i = 0; i < 20_000; i++) fn(i);          // warm
  const s = Bun.nanoseconds();
  for (let i = 0; i < n; i++) fn(i);
  console.log(label.padEnd(46), (((Bun.nanoseconds() - s) / n)).toFixed(1).padStart(8), "ns/op");
};

// --- SDK ABSENT (the default: no provider registered) ---
const noop = trace.getTracer("noop");
bench("noop: startSpan + end", (i) => { const sp = noop.startSpan("x"); sp.end(); });
bench("noop: startSpan + 6 attrs + end", (i) => {
  const sp = noop.startSpan("x");
  sp.setAttribute("http.request.method", "GET");
  sp.setAttribute("url.path", "/users/1");
  sp.setAttribute("http.route", "/users/:id");
  sp.setAttribute("server.address", "localhost");
  sp.setAttribute("http.response.status_code", 200);
  sp.setAttribute("network.protocol.version", "1.1");
  sp.end();
});
bench("noop: startActiveSpan (sync cb)", (i) => { noop.startActiveSpan("x", (sp) => { sp.end(); }); });
bench("context.active()", () => { context.active(); });
bench("trace.getSpan(context.active())", () => { trace.getSpan(context.active()); });
const off = { enabled: false } as { enabled: boolean };
bench("baseline: `if (!t.enabled) return` branch", () => { if (!off.enabled) return; });

// --- context manager installed ---
const cm = new AsyncLocalStorageContextManager(); cm.enable();
context.setGlobalContextManager(cm);
bench("ALS cm: context.with(ROOT, sync fn)", () => { context.with(context.active(), () => {}); });

// --- SDK PRESENT, AlwaysOn, BatchSpanProcessor ---
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  sampler: new AlwaysOnSampler(),
  spanProcessors: [new BatchSpanProcessor(exporter, { maxQueueSize: 4_000_000, scheduledDelayMillis: 3_600_000 })],
});
trace.setGlobalTracerProvider(provider);
const tracer = trace.getTracer("probe");
bench("SDK on: startSpan + 6 attrs + end (batch)", (i) => {
  const sp = tracer.startSpan("GET /users/:id", { kind: SpanKind.SERVER });
  sp.setAttribute("http.request.method", "GET");
  sp.setAttribute("url.path", "/users/1");
  sp.setAttribute("http.route", "/users/:id");
  sp.setAttribute("server.address", "localhost");
  sp.setAttribute("http.response.status_code", 200);
  sp.setAttribute("network.protocol.version", "1.1");
  sp.setStatus({ code: SpanStatusCode.UNSET });
  sp.end();
}, 200_000);
bench("SDK on: startActiveSpan + end (batch)", () => {
  tracer.startActiveSpan("GET /x", (sp) => { sp.end(); });
}, 200_000);

// --- SDK PRESENT but sampled OUT ---
const provider2 = new BasicTracerProvider({ sampler: new AlwaysOffSampler(), spanProcessors: [] });
trace.disable(); trace.setGlobalTracerProvider(provider2);
const t2 = provider2.getTracer("probe");
bench("SDK on, AlwaysOff sampler: startSpan+6attrs+end", (i) => {
  const sp = t2.startSpan("GET /users/:id", { kind: SpanKind.SERVER });
  sp.setAttribute("http.request.method", "GET");
  sp.setAttribute("url.path", "/users/1");
  sp.setAttribute("http.route", "/users/:id");
  sp.setAttribute("server.address", "localhost");
  sp.setAttribute("http.response.status_code", 200);
  sp.setAttribute("network.protocol.version", "1.1");
  sp.end();
}, 200_000);
