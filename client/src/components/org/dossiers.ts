/**
 * WHICH PERSON A RUN IS ABOUT, AND WHICH DAY IT HAPPENED ON.
 *
 * ---------------------------------------------------------------------------
 * THE ATTACHMENT RULE IS THE SERVER'S AND IT IS MIRRORED HERE ON PURPOSE. The
 * server composes a dossier's title as `Dossier — <name>` when the watchlist
 * asks for one, and it decides which watched person a run belongs to by taking
 * that prefix off and comparing what is left with the person's name. This
 * client draws the same grouping — a person's page shows that person's runs —
 * so it has to answer the same question about the same strings. It is a
 * DUPLICATED RULE and that is the honest cost: there is no person id on a run.
 * A run's only link to a human is the words somebody typed, and inventing an
 * identity out of free text is how two spellings of one name become two people
 * who have never met. Grouping on the typed words is exactly as strong as the
 * typed words, which is the claim this file is prepared to make.
 *
 * `, ` IS THE ONE PIECE OF SLACK. `Dossier — Jane Doe, founder of Acme` is
 * still Jane Doe: the composer sends the name on the first line and whatever
 * the owner typed after it, and a brief that qualifies a name with a comma is
 * the ordinary way somebody writes one. Anything else — a middle name, a
 * different spelling, a nickname — is a different person as far as this is
 * concerned, and lands in the unfiled pile rather than being guessed into
 * somebody's file.
 *
 * NO IMPORTS. A leaf that a node test can strip types from and run, which is
 * what `dossiers.test.ts` does: this is the one rule on this side of the wire
 * that has a second implementation somewhere else, so it is the one that earns
 * a test.
 */

/**
 * `Dossier — Jane Doe` → `Jane Doe`.
 *
 * The em dash is what the server writes. The en dash and the hyphen are
 * accepted too because a title typed or migrated by hand is exactly the case
 * where this quietly stops matching — a superset of the contract, never a
 * narrower reading of it. A title that is ONLY the prefix keeps the whole
 * string rather than becoming "", so it groups as itself instead of as
 * everybody.
 */
const PREFIX = /^dossier\s*[—–-]\s*/i;

export function dossierWho(title: string): string {
  return title.replace(PREFIX, "").trim() || title.trim();
}

/**
 * Does this run's title name this watched person?
 *
 * An empty name matches NOTHING rather than everything. A person row with no
 * name should not swallow the whole ledger while somebody is still typing one.
 */
export function attaches(title: string, name: string): boolean {
  const person = name.trim().toLowerCase();
  if (!person) return false;
  const who = dossierWho(title).toLowerCase();
  return who === person || who.startsWith(`${person},`);
}

/**
 * A RUN TITLE WITH ITS KIND OFF THE FRONT: `Dossier — Jane Doe` → `Jane Doe`.
 *
 * The rail is one worker's runs, so the kind is the same on every row and
 * printing it 40 times down a 264px column spends the width on the half that
 * never differs. It is stripped by SHAPE rather than from a table of kinds:
 * this client has been wrong before about which kinds exist (see
 * `runAddress`), and a kind added by the server should lose its prefix here
 * without anybody editing a list. A short leading phrase followed by a dash is
 * the shape every kind's title actually has; a title with a long clause before
 * a dash is left whole, because that dash is punctuation rather than a prefix.
 */
export function runLabel(title: string): string {
  const trimmed = title.trim();
  const match = /^(.{1,24}?)\s[—–]\s(.+)$/.exec(trimmed);
  return match ? match[2]!.trim() : trimmed;
}

/**
 * WHICH DAY A STAMP FELL ON, IN THE READER'S OWN ZONE: "Today", "Yesterday",
 * or the date.
 *
 * Local midnights rather than a 24-hour subtraction, which is the difference
 * between "yesterday" meaning the day before this one and it meaning "somewhere
 * between 24 and 48 hours ago" — a run at 23:00 and a run at 01:00 are two
 * days apart to a reader and two hours apart to a subtraction.
 *
 * The date itself is NOT formatted here. `@/lib/format`'s `day` is the only
 * thing on this client that writes one, and a second implementation in a file
 * with no imports is how the two start disagreeing. Null means "the caller
 * should print the date", which is what the rail does.
 */
export function dayLabel(
  value: string | number | Date | null | undefined,
  now: Date = new Date(),
): string | null {
  if (value === null || value === undefined || value === "") return "Undated";
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return "Undated";
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(new Date(ms))) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return null;
}
