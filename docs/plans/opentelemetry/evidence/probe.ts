import { context, trace, SpanKind, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

// 1. no-op default cost
const t0 = trace.getTracer("noop");
const N = 200_000;
let s = Bun.nanoseconds();
for (let i = 0; i < N; i++) { const sp = t0.startSpan("x"); sp.setAttribute("a", i); sp.end(); }
console.log("noop span ns/op:", ((Bun.nanoseconds() - s) / N).toFixed(1));

s = Bun.nanoseconds();
for (let i = 0; i < N; i++) { trace.getSpan(context.active()); }
console.log("getSpan(active) ns/op:", ((Bun.nanoseconds() - s) / N).toFixed(1));

// 2. real SDK
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const cm = new AsyncLocalStorageContextManager();
cm.enable();
context.setGlobalContextManager(cm);
trace.setGlobalTracerProvider(provider);

const tracer = trace.getTracer("probe", "1.0.0");
await tracer.startActiveSpan("parent", { kind: SpanKind.SERVER }, async (span) => {
  await new Promise((r) => setTimeout(r, 2));
  const inner = trace.getSpan(context.active());
  console.log("ALS ctx survives timer+await:", inner === span);
  await tracer.startActiveSpan("child", async (c) => { c.end(); });
  span.end();
});
await provider.forceFlush();
const spans = exporter.getFinishedSpans();
console.log("exported:", spans.map((x) => `${x.name}/${x.spanContext().traceId.slice(0,8)}/parent=${x.parentSpanContext?.spanId ?? (x as any).parentSpanId ?? "-"}`));

// 3. W3C propagation without a global propagator
import { W3CTraceContextPropagator } from "@opentelemetry/core";
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
const carrier: Record<string, string> = {};
await tracer.startActiveSpan("inject", async (sp) => {
  propagation.inject(context.active(), carrier);
  sp.end();
});
console.log("carrier:", carrier);
const extracted = propagation.extract(ROOT_CONTEXT, carrier);
console.log("extracted spanctx:", trace.getSpanContext(extracted));

// 4. real SDK span cost
s = Bun.nanoseconds();
for (let i = 0; i < 50_000; i++) { const sp = tracer.startSpan("y"); sp.setAttribute("a", i); sp.end(); }
console.log("recorded span ns/op:", ((Bun.nanoseconds() - s) / 50_000).toFixed(1));
