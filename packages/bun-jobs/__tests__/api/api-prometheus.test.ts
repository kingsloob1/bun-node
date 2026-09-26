import type { QueueDemandDto } from "../../lib/api/contract/types";
import { describe, expect, it } from "bun:test";
import {
  escapeHelp,
  escapeLabelValue,
  formatValue,
  PROMETHEUS_CONTENT_TYPE,
  renderDemandExposition,
  renderPrometheus,
} from "../../lib/api/prometheus";

/**
 * The text exposition renderer, against the format's specification
 * (<https://prometheus.io/docs/instrumenting/exposition_formats/>): escaping,
 * names, values, grouping and the trailing line feed. The routes' use of it is
 * `api-demand.test.ts`.
 */

/** A demand body with every figure distinct, so a crossed wire shows. */
function demand(queue: string): QueueDemandDto {
  return {
    queue,
    at: 1,
    paused: true,
    waiting: 3,
    dueNow: 4,
    stalled: 5,
    active: 6,
    workers: 7,
    nextDueAt: null,
    demand: 0,
    outstanding: 0,
    capped: true,
    exact: true,
  };
}

describe("escaping", () => {
  it("escapes a label value's backslash, double quote and line feed, and nothing else", () => {
    expect(escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
    expect(escapeLabelValue("tab\there, ümlaut, {braces}")).toBe(
      "tab\there, ümlaut, {braces}",
    );
    // Order matters: the backslash first, or an escape would be escaped again.
    expect(escapeLabelValue('\\"')).toBe('\\\\\\"');
  });

  it("escapes help text's backslash and line feed, but not a double quote", () => {
    expect(escapeHelp('one\\two\nthree "quoted"')).toBe(
      'one\\\\two\\nthree "quoted"',
    );
  });

  it("escapes a hostile queue label in the demand exposition", () => {
    const text = renderDemandExposition("n\\s", [demand('q"x\ny')]);
    expect(text).toContain(
      'bunjobs_queue_waiting{ns="n\\\\s",queue="q\\"x\\ny"} 3\n',
    );
    // Every line is one line: the line feed in the value did not split it.
    for (const line of text.slice(0, -1).split("\n")) {
      expect(line.startsWith("#") || line.startsWith("bunjobs_")).toBe(true);
    }
  });
});

describe("renderPrometheus", () => {
  it("writes HELP then TYPE then the samples per family, and ends with a line feed", () => {
    const text = renderPrometheus([
      {
        name: "x_total",
        help: "An x.",
        type: "counter",
        samples: [
          { labels: { a: "1" }, value: 2 },
          { labels: {}, value: 3 },
        ],
      },
      { name: "y", help: "A y.", type: "gauge", samples: [] },
    ]);
    expect(text).toBe(
      [
        "# HELP x_total An x.",
        "# TYPE x_total counter",
        'x_total{a="1"} 2',
        "x_total 3",
        "# HELP y A y.",
        "# TYPE y gauge",
        "",
      ].join("\n"),
    );
    expect(renderPrometheus([])).toBe("");
  });

  it("formats values as Go's ParseFloat reads them", () => {
    expect(formatValue(Number.NaN)).toBe("NaN");
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe("+Inf");
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe("-Inf");
    expect(formatValue(0)).toBe("0");
    expect(formatValue(-1.5)).toBe("-1.5");
    expect(formatValue(1e21)).toBe("1e+21");
  });

  it("refuses an illegal metric or label name, a reserved label, and a family named twice", () => {
    const family = (name: string, label = "ok") => ({
      name,
      help: "h",
      type: "gauge" as const,
      samples: [{ labels: { [label]: "v" }, value: 1 }],
    });
    expect(() => renderPrometheus([family("1bad")])).toThrow(TypeError);
    expect(() => renderPrometheus([family("bad-name")])).toThrow(TypeError);
    expect(() => renderPrometheus([family("ok", "bad-label")])).toThrow(
      TypeError,
    );
    expect(() => renderPrometheus([family("ok", "__reserved")])).toThrow(
      TypeError,
    );
    expect(() => renderPrometheus([family("ok"), family("ok")])).toThrow(
      /twice/,
    );
    // Control: the legal spellings, colons in a metric name included.
    expect(() =>
      renderPrometheus([family("ns:ok_total", "_ok1")]),
    ).not.toThrow();
  });
});

describe("renderDemandExposition", () => {
  it("reports each figure under its own family, booleans as 0 or 1, one sample per queue", () => {
    const text = renderDemandExposition(
      "shop",
      [
        demand("a"),
        {
          ...demand("b"),
          paused: false,
          capped: false,
          exact: false,
          demand: 9,
        },
      ],
      { truncated: true },
    );
    const samples = text
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    expect(samples).toEqual([
      'bunjobs_queue_demand{ns="shop",queue="a"} 0',
      'bunjobs_queue_demand{ns="shop",queue="b"} 9',
      'bunjobs_queue_outstanding{ns="shop",queue="a"} 0',
      'bunjobs_queue_outstanding{ns="shop",queue="b"} 0',
      'bunjobs_queue_waiting{ns="shop",queue="a"} 3',
      'bunjobs_queue_waiting{ns="shop",queue="b"} 3',
      'bunjobs_queue_due{ns="shop",queue="a"} 4',
      'bunjobs_queue_due{ns="shop",queue="b"} 4',
      'bunjobs_queue_stalled{ns="shop",queue="a"} 5',
      'bunjobs_queue_stalled{ns="shop",queue="b"} 5',
      'bunjobs_queue_active{ns="shop",queue="a"} 6',
      'bunjobs_queue_active{ns="shop",queue="b"} 6',
      'bunjobs_queue_workers{ns="shop",queue="a"} 7',
      'bunjobs_queue_workers{ns="shop",queue="b"} 7',
      'bunjobs_queue_paused{ns="shop",queue="a"} 1',
      'bunjobs_queue_paused{ns="shop",queue="b"} 0',
      'bunjobs_queue_demand_capped{ns="shop",queue="a"} 1',
      'bunjobs_queue_demand_capped{ns="shop",queue="b"} 0',
      'bunjobs_queue_demand_exact{ns="shop",queue="a"} 1',
      'bunjobs_queue_demand_exact{ns="shop",queue="b"} 0',
      'bunjobs_demand_truncated{ns="shop"} 1',
    ]);
    expect(text.endsWith("\n")).toBe(true);
    // Truncation defaults to 0, and is present even with no queue at all.
    expect(renderDemandExposition("shop", [])).toContain(
      'bunjobs_demand_truncated{ns="shop"} 0\n',
    );
    expect(PROMETHEUS_CONTENT_TYPE).toBe(
      "text/plain; version=0.0.4; charset=utf-8",
    );
  });
});
