/**
 * A plugin's accounts.
 *
 * WHY A PLUGIN IS A LIST AND NOT A CREDENTIAL. A Hetzner API token is scoped
 * to a single project, so an account with three projects needs three tokens.
 * The registrars have the same shape for a different reason — two Dynadot
 * logins are two portfolios — and so does almost everything else worth
 * connecting once a person owns more than one of a thing. The old design had
 * exactly one credential set per plugin and coped with Hetzner by storing a
 * newline-separated blob under one entry name: it worked, and it was invisible
 * in the interface, gave no token a name, and reported nothing per token when
 * one of them went bad.
 *
 * So the unit that owns a credential is an ACCOUNT: a label, a connected flag,
 * a last error, a date it last answered, and one vault entry per field. The
 * plugin above it keeps meaning "is any of this connected", which is the only
 * question the index page ever asked of it.
 *
 * THIS FILE SITS BETWEEN THE VAULT AND EVERYTHING THAT WANTS A CREDENTIAL.
 * Providers ask for "the accounts of hetzner that have a token" and get values
 * keyed by field; they never build an entry name, and they never see an
 * account whose credential set is incomplete. The routes ask for the same
 * accounts as rows to draw, without values, because there is no function here
 * that hands one out to a caller that is not a provider.
 */
import {
  accountRow,
  accountRows,
  db,
  deleteAccount,
  insertAccount,
  markAccount,
  now,
  renameAccount,
  setAccountConnected,
  syncPlugin,
  type AccountRow,
} from "./db.ts";
import * as vault from "./vault.ts";

export type Account = {
  id: number;
  pluginId: string;
  label: string;
  connected: boolean;
  createdAt: string;
  updatedAt: string;
  /** When this account last answered its provider — not when it was stored. */
  lastOkAt: string | null;
  lastError: string | null;
};

/** An account with its credential set, for a provider about to make a call. */
export type Credentialed = { account: Account; values: Record<string, string> };

const shape = (r: AccountRow): Account => ({
  id: r.id,
  pluginId: r.plugin_id,
  label: r.label,
  connected: r.connected === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastOkAt: r.last_ok_at,
  lastError: r.last_error,
});

export function list(pluginId: string): Account[] {
  return accountRows(pluginId).map(shape);
}

export function get(id: number): Account | undefined {
  const row = accountRow(id);
  return row && shape(row);
}

/** Names and dates for one account's entries. Never a value; there is no
 *  function in this file, and no route above it, that returns one. */
export const entries = vault.entries;

/* ------------------------------------------------------------------ naming */

/**
 * The vault entry one field of one account lands in.
 *
 * THE FIRST ACCOUNT TAKES THE PLAIN NAME. `hetzner-token`, `dynadot-key`,
 * `spaceship-secret` — the names workdash's own vault uses, which is what
 * makes moving a credential between the two a copy rather than a translation,
 * and the names this project's README tells the owner to look for. Every
 * account after it is suffixed with its own ROW ID rather than with its label
 * or its position: the entry name is the ciphertext's associated data, so it
 * has to be stable for the life of the row, and a label can be renamed while a
 * position moves the moment an earlier account is deleted. The row id is the
 * one thing about an account that never changes.
 *
 * Called only when a field has no row yet. A field being REPLACED keeps the
 * name it already has, because changing it would mean re-sealing a secret to
 * achieve nothing.
 */
function entryName(accountId: number, stem: string, field: string, multi: boolean) {
  const plain = multi ? `${stem}-${field}` : stem;
  return vault.taken(plain) ? `${plain}#${accountId}` : plain;
}

/* ----------------------------------------------------------------- lifecycle */

/**
 * A label nobody has used on this plugin yet.
 *
 * "Account 3" rather than "Account 2" when 2 exists but 1 was deleted: the
 * number is a name, not a count, and reusing a freed one puts an old label on
 * new credentials in a list the owner has already read once.
 */
export function nextLabel(pluginId: string): string {
  const taken = new Set(list(pluginId).map((a) => a.label));
  for (let n = 1; ; n++) {
    const candidate = `Account ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function create(pluginId: string, label: string): Account {
  const id = insertAccount(pluginId, label.trim() || nextLabel(pluginId));
  return get(id)!;
}

export function rename(id: number, label: string) {
  renameAccount(id, label.trim());
}

/**
 * Store a whole credential set against one account, in one transaction.
 *
 * All of it or none of it: a Dynadot account left holding a new key beside the
 * old secret is an account that reads nothing and looks configured, which is
 * the exact failure the pair-verification above it exists to prevent.
 */
export function writeCredentials(
  account: Account,
  stem: string,
  fields: string[],
  values: Record<string, string>,
) {
  const existing = new Map(vault.entries(account.id).map((e) => [e.field, e.name]));
  const multi = fields.length > 1;

  db.exec("BEGIN");
  try {
    for (const field of fields) {
      const value = values[field];
      if (value === undefined) continue;
      const name = existing.get(field) ?? entryName(account.id, stem, field, multi);
      vault.write(name, account.pluginId, account.id, field, value);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  setAccountConnected(account.id, true);
  // A freshly stored credential has no history of failing. Leaving yesterday's
  // error on a value pasted ten seconds ago would put a red line under an
  // account nobody has tested yet.
  markAccount(account.id, false, null);
  syncPlugin(account.pluginId, null);
}

/** Forget one account: the row, and by the foreign key's cascade its
 *  ciphertext with it. The plugin's own flag follows from what is left. */
export function remove(account: Account) {
  deleteAccount(account.id);
  syncPlugin(account.pluginId, null);
}

/** What the provider said, recorded against the account that asked. */
export function markOk(id: number) {
  markAccount(id, true, null);
}

export function markFailed(id: number, error: string) {
  markAccount(id, false, error);
}

/* ----------------------------------------------------------------- reading */

/**
 * The accounts of this plugin that can actually be used, with their values.
 *
 * An account missing a field it needs is left out and reported as a problem
 * rather than handed over half-built: a registrar call with a key and no
 * secret fails at the provider as "bad credentials", which sends the owner to
 * the wrong place entirely. `reader` is written into secret_access, so "what
 * touched the token last night" stays a query.
 */
export function credentialed(
  pluginId: string,
  fields: string[],
  reader: string,
): { ready: Credentialed[]; broken: { account: Account; missing: string[] }[] } {
  const ready: Credentialed[] = [];
  const broken: { account: Account; missing: string[] }[] = [];

  for (const account of list(pluginId)) {
    if (!account.connected) continue;
    const values = vault.readSet(account.id, reader);
    const missing = fields.filter((f) => !(values[f] ?? "").trim());
    if (missing.length) broken.push({ account, missing });
    else ready.push({ account, values });
  }
  return { ready, broken };
}

/* -------------------------------------------------- the one-time data move */

/**
 * SPLITTING THE HETZNER BLOB INTO REAL ACCOUNTS.
 *
 * 005_accounts turned every connected plugin into its first account, which is
 * right for the registrars — one login, one key, one secret. Hetzner is the
 * exception: its single entry held one token PER LINE, so the account the
 * schema migration created holds two projects in one credential and would
 * report them under one label and one error. Splitting it is what makes the
 * promise of this file true for the data that already exists.
 *
 * WHY IT IS NOT IN db.ts's MIGRATION LIST. Splitting means opening a
 * ciphertext and sealing two new ones, and the vault sits above the database
 * in the import graph — a migration in db.ts cannot reach it without a cycle.
 * It is recorded in the same `migrations` table so it runs exactly once, and
 * it runs at import here for the same reason the schema migrations run at
 * import there: everything that could need an account has already imported
 * this file by the time it asks for one.
 *
 * The line splitting is written out again rather than imported from
 * providers/hetzner.ts on purpose. A data migration is a statement about data
 * that existed at one moment, and it must not change meaning later because the
 * provider it borrowed a parser from grew a new rule.
 */
const SPLIT = "005_accounts_split";

function splitHetznerTokens() {
  const done = db.prepare("SELECT 1 FROM migrations WHERE name = ?").get(SPLIT);
  if (done) return;

  const accounts = list("hetzner");
  for (const account of accounts) {
    const entry = vault.entries(account.id).find((e) => e.field === "token");
    if (!entry) continue;

    const blob = vault.read(entry.name, "migrate_005_accounts_split");
    if (blob === null) continue;
    const tokens = blob
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    if (tokens.length < 2) continue;

    // The first token stays in the entry it is already in — the name the
    // README documents, and one fewer ciphertext to move. The rest become
    // accounts of their own, numbered the way the old collector numbered them.
    vault.write(entry.name, "hetzner", account.id, "token", tokens[0]!);
    console.log(
      `[db] ${SPLIT}: ${account.label} held ${tokens.length} tokens — splitting`,
    );

    for (let i = 1; i < tokens.length; i++) {
      const next = create("hetzner", nextLabel("hetzner"));
      writeCredentials(next, "hetzner-token", ["token"], { token: tokens[i]! });

      /*
        The rows the old collector already wrote are re-attributed rather than
        left to the next collection. The mapping is exact: it labelled tokens
        "token 1", "token 2" … in the order they appeared in the blob, which is
        the order they are being split in here. Waiting for the next run would
        leave the fleet page for half an hour showing a label that names no
        account — which is precisely the kind of quietly-wrong figure this
        codebase refuses elsewhere.
      */
      reattribute(`token ${i + 1}`, next.id, next.label);
    }
    reattribute(tokens.length > 1 ? "token 1" : "token", account.id, account.label);
  }

  db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(
    SPLIT,
    now(),
  );
}

function reattribute(oldLabel: string, accountId: number, label: string) {
  for (const table of ["hetzner_servers", "hetzner_volumes"]) {
    db.prepare(
      `UPDATE ${table} SET account_id = ?, token_label = ? WHERE token_label = ?`,
    ).run(accountId, label, oldLabel);
  }
}

splitHetznerTokens();
