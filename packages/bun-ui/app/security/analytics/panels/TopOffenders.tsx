/**
 * Top offenders (ui.md §7, PR-U2): the most refused subjects of a kind, the
 * address (or /64) by default; a user, username or API key (their keys)
 * with `events:read`. Each row: the refusals, an hourly sparkline, an
 * address's highest offence score, whether a ban is in force, and links to
 * U3's ban and allow-list forms, pre-filled (their link contract, §17.37).
 */
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { Select } from "../../../kit/components/inputs";
import { Table } from "../../../kit/components/Table";
import { formatCount } from "../../../kit/charts/chart";
import { Sparkline } from "../../../kit/charts/Sparkline";
import { dataOf } from "../../api/client";
import { useSecurityClient } from "../../context";
import type { BannableSubject } from "../../screens/events/prefill";
import { Subject } from "../../components/Subject";
import { SUBJECT_LABELS } from "../../components/subjects";
import { Link } from "../../router";
import { banFormPath, listFormPath } from "../../screens/events/prefill";
import { readScores, readSeries, readTop } from "../api";
import { useAnalyticsView } from "../context";
import { Panel } from "../Panel";
import { ANALYTICS_RANGE } from "../range";
import { ANALYTICS_KEY, usePanelQuery } from "../usePanelQuery";

/** A subject kind. */
type Kind = "ip" | "user" | "username" | "apiKey";

/** Props of {@link TopOffenders}. */
export interface TopOffendersProps {
  /** Whether the operator reads account subjects (`events:read`). */
  canAccounts: boolean;
  /** Whether the operator reads bans (the ban state). */
  canBans: boolean;
  /** Whether the operator may ban (`bans:write`): the ban link. */
  canBan: boolean;
  /** Whether the operator may draft list entries (`policy:draft`): the allow link. */
  canAllow: boolean;
}

/** U3's ban form's parameter for a kind it takes (a username's key is not one). */
const BAN_PARAMS: Partial<Record<Kind, BannableSubject["param"]>> = {
  ip: "ip",
  user: "userHash",
  apiKey: "apiKeyHash",
};

/** See the module's description. */
export function TopOffenders({
  canAccounts,
  canBans,
  canBan,
  canAllow,
}: TopOffendersProps) {
  const { client } = useSecurityClient();
  const { scope, range } = useAnalyticsView();
  const [kind, setKind] = useState<Kind>("ip");
  const top = usePanelQuery(
    "offenders.top",
    (c) => readTop(c, "top.refused", { kind }),
    {
      key: [kind],
      liveMs: 5_000,
    },
  );
  const scores = usePanelQuery("offenders.scores", (c) => readScores(c, 100), {
    enabled: kind === "ip",
    liveMs: 5_000,
  });
  const bans = usePanelQuery(
    "offenders.bans",
    async (c) =>
      await dataOf(
        c.client.get("/bans", {
          query: { scope: c.scope, active: true, limit: 200 },
          ...(c.signal === undefined ? {} : { signal: c.signal }),
        }),
      ),
    { enabled: canBans, liveMs: 5_000 },
  );
  const subjects = (top.data?.rows ?? []).map((row) => row.dims.subject ?? "");
  const sparks = useQueries({
    queries: subjects.map((subject) => ({
      queryKey: [
        ANALYTICS_KEY,
        scope,
        ANALYTICS_RANGE.writeRange(range) ?? "default",
        "offenders.spark",
        kind,
        subject,
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        readSeries(
          { client, scope, range, signal },
          "refused.hourly",
          { kind, subject },
          { tier: "hour" },
        ),
    })),
  });
  const kinds: Kind[] = canAccounts
    ? ["ip", "user", "username", "apiKey"]
    : ["ip"];
  return (
    <Panel
      title="Top offenders"
      testId="panel-offenders"
      states={[
        top,
        ...(kind === "ip" ? [scores] : []),
        ...(canBans ? [bans] : []),
      ]}
      actions={
        kinds.length > 1 ? (
          <Select
            aria-label="Subject kind"
            value={kind}
            onChange={(value) => setKind(value)}
            options={kinds.map((value) => ({
              value,
              label: SUBJECT_LABELS[value],
            }))}
          />
        ) : null
      }
    >
      {() => {
        const rows = top.data!.rows;
        if (rows.length === 0)
          return <p className="chart-empty">No refusals in this range.</p>;
        const best = new Map(
          (scores.data?.rows ?? []).map((row) => [row.subject, row.score]),
        );
        const banned = new Set(
          (bans.data?.items ?? []).map(
            (ban) => `${ban.subject.type}\u0000${ban.subject.value}`,
          ),
        );
        const param = BAN_PARAMS[kind];
        return (
          <Table label="Top offenders">
            <thead>
              <tr>
                <th scope="col">{SUBJECT_LABELS[kind]}</th>
                <th scope="col">Refused</th>
                <th scope="col">By hour</th>
                {kind === "ip" ? <th scope="col">Highest score</th> : null}
                {canBans ? <th scope="col">Ban</th> : null}
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const subject = row.dims.subject ?? "";
                const spark =
                  sparks[index]?.data?.points.map((point) => point.value) ?? [];
                return (
                  <tr key={subject}>
                    <td>
                      <Subject
                        kind={kind}
                        value={subject}
                      />
                    </td>
                    <td>{formatCount(row.value)}</td>
                    <td>
                      <Sparkline
                        values={spark}
                        label={`${subject}: refusals by hour`}
                      />
                    </td>
                    {kind === "ip" ? (
                      <td>
                        {best.has(subject) ? String(best.get(subject)) : "—"}
                      </td>
                    ) : null}
                    {canBans ? (
                      <td>
                        {banned.has(`${kind}\u0000${subject}`) ? "Banned" : "—"}
                      </td>
                    ) : null}
                    <td className="row-actions">
                      {param !== undefined && canBan ? (
                        <Link
                          to={banFormPath(scope, {
                            kind: kind as BannableSubject["kind"],
                            value: subject,
                            param,
                          })}
                        >
                          Ban
                        </Link>
                      ) : null}
                      {kind === "ip" && canAllow ? (
                        <Link
                          to={`${listFormPath(scope, subject)}&action=allow`}
                        >
                          Allow
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        );
      }}
    </Panel>
  );
}
