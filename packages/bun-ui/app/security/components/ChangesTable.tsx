/** A diff's changes as a table (a policy diff, an audit entry's): where, before, after. */

/** One change. */
export interface ChangeRow {
  /** Where (`limits[id=x].limit`). */
  readonly path: string;
  /** The value before; absent when added. */
  readonly before?: unknown;
  /** The value after; absent when removed. */
  readonly after?: unknown;
}

/** A value of a diff, in one line. */
function shown(value: unknown): string {
  return value === undefined ? "—" : JSON.stringify(value);
}

/** Props of {@link ChangesTable}. */
export interface ChangesTableProps {
  /** The changes. */
  changes: readonly ChangeRow[];
  /** Its test id. */
  testId: string;
}

/** See the module's description. */
export function ChangesTable({ changes, testId }: ChangesTableProps) {
  return (
    <table
      className="table"
      data-testid={testId}
    >
      <thead>
        <tr>
          <th scope="col">Where</th>
          <th scope="col">Before</th>
          <th scope="col">After</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change) => (
          <tr key={change.path}>
            <td>
              <code>{change.path}</code>
            </td>
            <td>
              <code>{shown(change.before)}</code>
            </td>
            <td>
              <code>{shown(change.after)}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
