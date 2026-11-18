/**
 * The credential-stuffing panel (ui.md §7, PR-AN's sign-in counters,
 * PR-U2): the sign-in failure ratio against its baseline (the same hours on
 * the seven days before, for a range of a day or less; the period before,
 * for a longer one), successes after failures, and the addresses that
 * tried the most distinct usernames in a minute.
 */
import { Table } from "../../../kit/components/Table";
import { formatCount, formatShare } from "../../../kit/charts/chart";
import { rangeBounds } from "../../../kit/range";
import { readSeries, sumBy } from "../api";
import { useAnalyticsView } from "../context";
import { Panel } from "../Panel";
import { usePanelQuery } from "../usePanelQuery";

/** A day, ms. */
const DAY = 86_400_000;

/** The failure ratio of sign-in counts by outcome. */
function ratio(outcomes: Map<string, number>): number | null {
  const failure = outcomes.get("failure") ?? 0;
  const total = failure + (outcomes.get("success") ?? 0);
  return total === 0 ? null : failure / total;
}

/** See the module's description. */
export function CredentialStuffing() {
  const { range } = useAnalyticsView();
  const login = usePanelQuery("login.now", (c) => readSeries(c, "login"));
  const baseline = usePanelQuery("login.baseline", async (c) => {
    const { from, to } = rangeBounds(c.range);
    const span = to - from;
    const windows =
      span <= DAY
        ? [1, 2, 3, 4, 5, 6, 7].map((days) => ({
            from: from - days * DAY,
            to: to - days * DAY,
          }))
        : [{ from: from - span, to: from }];
    const outcomes = new Map<string, number>();
    for (const window of windows) {
      const read = await readSeries(
        c,
        "login",
        {},
        { ...window, tier: span <= DAY ? "hour" : undefined },
      );
      for (const [outcome, value] of sumBy(read, "outcome"))
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + value);
    }
    return outcomes;
  });
  const after = usePanelQuery("login.after", (c) =>
    readSeries(c, "login.success-after-failures"),
  );
  const spread = usePanelQuery("login.spread", (c) =>
    readSeries(c, "top.usernames-per-ip", { kind: "ip" }),
  );
  return (
    <Panel
      title="Credential stuffing"
      testId="panel-login"
      states={[login, baseline, after, spread]}
    >
      {() => {
        const now = ratio(sumBy(login.data!, "outcome"));
        const before = ratio(baseline.data!);
        const successes = sumBy(after.data!, "route");
        const peak = new Map<string, number>();
        for (const point of spread.data!.points) {
          const subject = point.dims.subject ?? "";
          peak.set(subject, Math.max(peak.get(subject) ?? 0, point.value));
        }
        const top = [...peak].sort((a, b) => b[1] - a[1]).slice(0, 10);
        const total = [...successes.values()].reduce((a, b) => a + b, 0);
        return (
          <>
            <dl className="headline">
              <div className="headline-tile">
                <dt>Failure ratio</dt>
                <dd data-testid="login-ratio">
                  {now === null ? "—" : formatShare(now)}
                </dd>
              </div>
              <div className="headline-tile">
                <dt>
                  {range.kind === "preset" && range.seconds <= 86_400
                    ? "Same hours, last 7 days"
                    : "The period before"}
                </dt>
                <dd data-testid="login-baseline">
                  {before === null ? "—" : formatShare(before)}
                </dd>
              </div>
              <div className="headline-tile">
                <dt>Successes after failures</dt>
                <dd data-testid="login-after">{formatCount(total)}</dd>
              </div>
            </dl>
            {top.length === 0 ? null : (
              <Table label="Most usernames tried from one address in a minute">
                <thead>
                  <tr>
                    <th scope="col">Address</th>
                    <th scope="col">Peak distinct usernames a minute</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map(([subject, value]) => (
                    <tr key={subject}>
                      <td className="mono">{subject}</td>
                      <td>{formatCount(value)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        );
      }}
    </Panel>
  );
}
