/**
 * CLOSING THE ROWS A KILLED PROCESS LEFT OPEN.
 *
 * Every ledger on this box has the same hole in it. A row is written when work
 * starts and closed when it finishes, the `finally` that closes it cannot run
 * if the process is KILLED, and on a development box that is a routine event
 * rather than a disaster: `node --watch` restarts the server on every source
 * save. An open row reads as "still going", for ever.
 *
 * A LEDGER WITH NO SETTLE IS INVISIBLE UNTIL SOMEBODY READS IT. The chief's
 * rounds went unsettled long enough for a round from weeks earlier to still
 * read as walking. Every table that opens a row calls this at boot; a table
 * that does not is a table with that hole still in it.
 *
 * THE ROW IS CLOSED AND NEVER DELETED. A night that was interrupted is a fact
 * about what happened, and the work it did manage to file is still true. What
 * changes is the claim that it is still going.
 *
 * `failed` RATHER THAN `cancelled`: nobody pressed anything. "The agent
 * failed" and "the server was restarted while it was writing" send an owner to
 * two different places, so the note says which.
 *
 * THIS IS CALLED AT BOOT, BEFORE ANYTHING CAN READ THE TABLE, and it never
 * throws: it runs with nobody to catch it, and a box that will not start
 * because a settle failed is worse than a box with one stale row in it.
 */
import { db, now } from "../db.ts";

/** Write the settling instant into this column. A sentinel rather than a
 *  timestamp passed in, so every row of one settle carries the same instant
 *  and no caller has to remember to ask for it. */
export const NOW = Symbol("settle.now");

export type SettleValue = string | number | null | typeof NOW;

export type SettleSpec = {
  /** The table. An identifier, checked — see `identifier` below. */
  table: string;
  /**
   * What "still open" looks like in this table, as SQL.
   *
   * A LITERAL FROM THE CALLING MODULE AND NEVER SOMETHING AN OWNER TYPED.
   * It is a fragment of a WHERE clause and there is no way to parameterise a
   * predicate; every caller on this box passes a constant string like
   * `"status = 'running'"` or `"finished_at IS NULL"`, and that is the
   * contract. Values that vary belong in `set`, which is parameterised.
   */
  openWhen: string;
  /** The columns that close the row, and what to write into them. */
  set: Record<string, SettleValue>;
  /**
   * An explanation written into a column, only where there is not one already.
   *
   * COALESCE rather than a plain assignment, because a row that already
   * carries a note carries a better one: the process wrote it about the actual
   * failure before it died, and overwriting it with "something restarted"
   * would replace evidence with a guess.
   */
  note?: { column: string; text: string };
};

/** Passed rather than assumed, so a table with a better sentence keeps it. */
export const INTERRUPTED =
  "The process stopped while this was still going — a restart, a crash or a closed lid. " +
  "Whatever had already finished is recorded; the rest never started.";

/**
 * A SQLite identifier this file is willing to interpolate.
 *
 * Table and column names cannot be bound as parameters, so they are spliced
 * into the statement — which is only safe because they are checked here and
 * because every caller passes a literal. A name that is not a bare identifier
 * is a programming error and is refused rather than escaped, since escaping it
 * would mean supporting a case nothing on this box has.
 */
function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error(`“${name}” is not a plain table or column name.`);
  return name;
}

/**
 * Close every open row in one table, and say how many there were.
 *
 * Returns the count so a boot log can report it — "closed 2 interrupted runs"
 * is the difference between a box that had crashed and one that had not.
 * Never throws: a table that does not exist yet, because a migration has not
 * run, settles nothing and reports nothing rather than stopping the boot.
 */
export function settleOpenRows(spec: SettleSpec): number {
  try {
    const table = identifier(spec.table);
    const assignments: string[] = [];
    const values: (string | number | null)[] = [];
    const stamp = now();

    for (const [column, value] of Object.entries(spec.set)) {
      assignments.push(`${identifier(column)} = ?`);
      values.push(value === NOW ? stamp : value);
    }
    if (spec.note) {
      const column = identifier(spec.note.column);
      assignments.push(`${column} = COALESCE(${column}, ?)`);
      values.push(spec.note.text);
    }
    if (!assignments.length) return 0;

    const res = db
      .prepare(`UPDATE ${table} SET ${assignments.join(", ")} WHERE ${spec.openWhen}`)
      .run(...values);
    return Number(res.changes ?? 0);
  } catch {
    /* See the header: this runs at boot with nobody to catch it. */
    return 0;
  }
}
