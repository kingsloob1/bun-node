/** The outcome mix (ui.md §7, PR-U2): each action's share, and each status class's. */
import { BarList } from "../../../kit/charts/BarList";
import { ChartFrame } from "../../../kit/charts/ChartFrame";
import { formatCount, formatShare } from "../../../kit/charts/chart";
import { readSeries, sumBy } from "../api";
import { actionGroup, toneOf } from "../actions";
import { Panel } from "../Panel";
import { usePanelQuery } from "../usePanelQuery";

/** Bars of `counts`, each with its share. */
function shares(
  counts: Map<string, number>,
  tone: (key: string) => ReturnType<typeof toneOf>,
) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  return {
    total,
    items: sorted.map(([key, value]) => ({
      key,
      label: key,
      parts: [{ tone: tone(key), value }],
      text: `${formatShare(total === 0 ? 0 : value / total)} (${formatCount(value)})`,
    })),
  };
}

/** See the module's description. */
export function OutcomeMix() {
  const requests = usePanelQuery("mix.requests", (c) =>
    readSeries(c, "requests"),
  );
  const responses = usePanelQuery("mix.responses", (c) =>
    readSeries(c, "responses"),
  );
  return (
    <Panel
      title="Outcome mix"
      testId="panel-outcomes"
      states={[requests, responses]}
    >
      {() => {
        const actions = shares(sumBy(requests.data!, "action"), (action) =>
          toneOf(actionGroup(action)),
        );
        const classes = shares(sumBy(responses.data!, "class"), (klass) =>
          klass.startsWith("5") || klass.startsWith("4")
            ? "block"
            : klass.startsWith("3")
              ? "log"
              : "allow",
        );
        const table = (items: typeof actions.items) =>
          items.map((item) => [item.label, item.text]);
        return (
          <div className="outcome-mix">
            <ChartFrame
              title="By action"
              summary={
                actions.items
                  .map((item) => `${item.label} ${item.text}`)
                  .join("; ") || "No requests."
              }
              columns={["Action", "Share"]}
              rows={table(actions.items)}
              empty={actions.total === 0}
              testId="mix-actions"
            >
              <BarList items={actions.items} />
            </ChartFrame>
            <ChartFrame
              title="By status class"
              summary={
                classes.items
                  .map((item) => `${item.label} ${item.text}`)
                  .join("; ") || "No answers."
              }
              columns={["Class", "Share"]}
              rows={table(classes.items)}
              empty={classes.total === 0}
              testId="mix-classes"
            >
              <BarList items={classes.items} />
            </ChartFrame>
          </div>
        );
      }}
    </Panel>
  );
}
