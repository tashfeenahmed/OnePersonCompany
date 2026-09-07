/**
 * The rules the watchlist rests on, tested where they can be tested without a
 * database. Everything else in watch.ts is SQL and a call into another area's
 * dispatch, and neither is a thing a unit test tells the truth about.
 *
 * `attaches` and `composeBrief` are two halves of one mechanism and they are
 * tested together for that reason: the brief decides what the run's title
 * becomes, and `attaches` decides which titles come back.
 *
 * The round trip in the middle is the one that matters: brief → title →
 * attaches. Either function could be changed on its own and stay correct by
 * its own lights while the pair stopped working.
 *
 * THE FOUR AT THE BOTTOM ARE THE FILE'S OWN PURE RULES, and they are here for
 * the same reason: each is a small function whose failure is a WRONG ANSWER
 * rather than a crash. A handle normaliser that leaves the @ on produces a 404
 * that looks like "this person has no GitHub". A feed parser that stamps
 * undated items with the time of the fetch puts a post from 2019 at the top of
 * today. A name key that folds too hard attaches a stranger's mail to somebody
 * on the watchlist. A merge rule that lets an import win overwrites, silently
 * and in bulk, the notes this whole table exists to hold. None of them touch
 * the database, so all of them can be checked exactly.
 *
 * THE LAST GROUP — the series, the deltas and the signals — is there for the
 * reason the avatar ones are, one step sharper. Every rule in it decides
 * whether a SENTENCE IS SAID ABOUT SOMEBODY, and each fails as a plausible
 * wrong answer rather than as a crash: a delta computed against the wrong base
 * row is a number nobody can check by looking; a spike threshold that fires
 * too easily fills the timeline until nobody reads it, and one that never
 * fires makes the feature look broken while working perfectly; a bio rule that
 * treats a first sighting as a rewrite announces "Bio changed" about every
 * person on the day they are added. None of them touch the database, so all of
 * them can be checked exactly.
 *
 * THE THREE ABOUT THE AVATAR ARE THERE FOR A DIFFERENT REASON: they are the
 * rules that decide whether this box makes a request to somebody else's server
 * and what it agrees to store when it does. A preference order that fell
 * through to a stale imported URL would put last year's face on a card; a
 * freshness rule that always answered yes would re-download every picture on
 * the list every twenty hours; a gate that let a `text/html` body through
 * would store somebody's 404 page and serve it back as an image. All three are
 * pure, and none of them can be checked by pointing the box at a real server.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DELTA_DAYS,
  MAX_AVATAR_BYTES,
  MAX_HISTORY,
  attaches,
  avatarDue,
  avatarGate,
  bioSignal,
  changeKey,
  composeBrief,
  dayOf,
  deltasFrom,
  eventKey,
  handle,
  mergeWatchFields,
  nameKey,
  pickAvatar,
  repoSignal,
  rowAgo,
  spikeSignal,
  type MetricHistoryRow,
  type Metrics,
  type WatchRow,
} from "./watch.ts";
import { SWEEP_AFTER_MS, due, parseFeed, sweepState } from "./activity.ts";
import { dossierTitle } from "../runs/kinds.ts";

/* --------------------------------------------------------------- attaches */

test("a dossier attaches to the person it is titled after", () => {
  assert.ok(attaches("Dossier — Jane Doe", "Jane Doe"));
  /* Casing is not identity: the owner types a name twice and gets it slightly
     different, and the record must not split in half over it. */
  assert.ok(attaches("Dossier — jane doe", "JANE DOE"));
  assert.ok(attaches("Dossier — Jane Doe", "  Jane Doe  "));
});

test("the qualifying clause after a comma is kept and still attaches", () => {
  /* `dossierTitle` deliberately keeps the comma clause, because it is how one
     Jane Doe is told from another. A watch row named for the person alone must
     still find those runs. */
  assert.ok(attaches("Dossier — Jane Doe, founder of Acme", "Jane Doe"));
  assert.ok(attaches("Dossier — Jane Doe, CTO", "Jane Doe"));
});

test("a longer name that merely starts the same is a different person", () => {
  /* The reason the prefix rule ends at a COMMA and not at any character: a
     `startsWith` on the bare name would file every Doe-Smith dossier under
     Doe. */
  assert.ok(!attaches("Dossier — Jane Doe-Smith", "Jane Doe"));
  assert.ok(!attaches("Dossier — Jane Doerr", "Jane Doe"));
  assert.ok(!attaches("Dossier — Janet Doe", "Jane Doe"));
});

test("a title without the prefix is compared whole, and an empty name matches nothing", () => {
  /* A run titled from somewhere else is not silently reinterpreted. */
  assert.ok(attaches("Jane Doe", "Jane Doe"));
  assert.ok(!attaches("Research — Jane Doe", "Jane Doe"));
  /* The one that would otherwise attach EVERY dossier to a blank row. */
  assert.ok(!attaches("Dossier — Jane Doe", ""));
  assert.ok(!attaches("Dossier — Jane Doe", "   "));
});

/* ----------------------------------------------------------- the composer */

test("the first line is the name and nothing else", () => {
  const brief = composeBrief({ name: "Jane Doe", role: "Founder", company: "Acme" });
  assert.equal(brief.split("\n")[0], "Jane Doe");
  /* And a blank line under it, so the identity lines are their own paragraph
     and `dossierTitle` cannot reach them. */
  assert.equal(brief.split("\n")[1], "");
});

test("only the lines that were typed appear — nothing says “unknown”", () => {
  const brief = composeBrief({ name: "Jane Doe", company: "Acme", note: "Met at a conference." });
  assert.equal(
    brief,
    ["Jane Doe", "", "Company: Acme", "Note: Met at a conference."].join("\n"),
  );
  assert.ok(!brief.includes("Role:"));
  assert.ok(!brief.includes("Email:"));
  assert.ok(!/unknown/i.test(brief));
});

test("a person with nothing but a name is a brief of one line", () => {
  assert.equal(composeBrief({ name: "Jane Doe" }), "Jane Doe");
});

test("the links are labelled the way a person writes them, in a fixed order", () => {
  const brief = composeBrief({
    name: "Jane Doe",
    links: {
      bluesky: "jane.bsky.social",
      website: "https://jane.example",
      x: "@jane",
      github: "janedoe",
      linkedin: "in/janedoe",
    },
  });
  assert.deepEqual(brief.split("\n").slice(2), [
    "Website: https://jane.example",
    "GitHub: janedoe",
    "X: @jane",
    "LinkedIn: in/janedoe",
    "Bluesky: jane.bsky.social",
  ]);
});

test("an empty link or a blank field is left out rather than written empty", () => {
  const brief = composeBrief({
    name: "Jane Doe",
    company: "   ",
    email: "",
    links: { website: "  ", github: "janedoe" },
  });
  assert.equal(brief, ["Jane Doe", "", "GitHub: janedoe"].join("\n"));
});

test("the focus is a paragraph of its own at the end, never a first-line clause", () => {
  const brief = composeBrief({ name: "Jane Doe", role: "Founder" }, "What has she shipped since March?");
  assert.equal(
    brief,
    ["Jane Doe", "", "Role: Founder", "", "Look into: What has she shipped since March?"].join("\n"),
  );
  /* A blank focus adds nothing at all — no dangling heading. */
  assert.equal(composeBrief({ name: "Jane Doe" }, "   "), "Jane Doe");
});

/* ------------------------------------------------------- the round trip */

test("the brief a watch entry composes titles a run that attaches back to it", () => {
  /* THE PAIR. This is the whole feature: compose, title, find again. Either
     half could be changed alone and stay correct by its own lights while the
     dossiers stopped appearing on the person's card. */
  for (const person of [
    { name: "Jane Doe" },
    { name: "Jane Doe", company: "Acme", role: "Founder", email: "jane@acme.io" },
    { name: "Jane Doe, founder of Acme", note: "Introduced by Peter." },
  ]) {
    const title = dossierTitle(composeBrief(person, "Anything new this quarter?"));
    assert.ok(attaches(title, person.name), `${title} did not attach to ${person.name}`);
  }
  /* And the name as typed on the row finds the run titled after the longer
     form, which is the case the comma rule exists for. */
  const longer = dossierTitle(composeBrief({ name: "Jane Doe, founder of Acme" }));
  assert.equal(longer, "Dossier — Jane Doe, founder of Acme");
  assert.ok(attaches(longer, "Jane Doe"));
});

/* --------------------------------------------------- the handle normaliser */

test("a handle is stored as typed and used stripped", () => {
  /* The three ways one person writes the same fact, all reduced to the
     argument an API will accept. */
  assert.equal(handle("@t3dotgg"), "t3dotgg");
  assert.equal(handle("https://github.com/pc"), "pc");
  assert.equal(handle("karpathy"), "karpathy");
  assert.equal(handle("  @levelsio  "), "levelsio");
  /* A trailing slash and a tracking parameter are not part of a name. */
  assert.equal(handle("https://x.com/theo/"), "theo");
  assert.equal(handle("https://github.com/pc?tab=repositories"), "pc");
  assert.equal(handle("github.com/karpathy"), "karpathy");
  /* The deep path case: the handle is the LAST segment, not the first. */
  assert.equal(handle("https://bsky.app/profile/karpathy.bsky.social"), "karpathy.bsky.social");
});

test("a bare hostname survives, because a Bluesky handle is one", () => {
  /* The rule that would break this feature for Theo: "t3.gg" is his Bluesky
     handle, not a website to strip down to nothing. */
  assert.equal(handle("t3.gg"), "t3.gg");
  assert.equal(handle("jane.bsky.social"), "jane.bsky.social");
});

test("nothing typed is nothing used", () => {
  assert.equal(handle(""), "");
  assert.equal(handle("   "), "");
  assert.equal(handle(undefined), "");
  assert.equal(handle(null), "");
});

/* --------------------------------------------------------- the feed parser */

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>The channel's own title, which is not an item</title>
  <item>
    <title><![CDATA[Shipped &amp; deployed]]></title>
    <link>https://levels.io/shipped/</link>
    <pubDate>Wed, 03 Sep 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>An item nobody dated</title>
    <link>https://levels.io/undated/</link>
  </item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <title>A feed</title>
  <entry>
    <title>An entry with the link in an attribute</title>
    <link rel="alternate" href="https://example.com/one"/>
    <published>2026-09-01T08:30:00Z</published>
  </entry>
</feed>`;

test("the feed parser reads a title, a link and a date out of an item", () => {
  const items = parseFeed(RSS);
  assert.equal(items.length, 2);
  /* CDATA unwrapped and the entity decoded — a title full of &amp; is a title
     nobody typed. */
  assert.equal(items[0]!.title, "Shipped & deployed");
  assert.equal(items[0]!.url, "https://levels.io/shipped/");
  assert.equal(items[0]!.at, "2026-09-03T10:00:00.000Z");
});

test("an item with no parseable date carries a null date, never the time of the fetch", () => {
  /* The whole reason the parser answers null: stamping an undated item with
     "now" would put it at the top of the timeline as today's news. The pull
     drops these; the parser's job is only to refuse to invent one. */
  assert.equal(parseFeed(RSS)[1]!.at, null);
});

test("Atom entries are read too, and the href attribute wins over a bare tag", () => {
  const items = parseFeed(ATOM);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, "An entry with the link in an attribute");
  assert.equal(items[0]!.url, "https://example.com/one");
  assert.equal(items[0]!.at, "2026-09-01T08:30:00.000Z");
});

test("the channel's own title is not an item, and a feed that cannot be read is empty", () => {
  /* Only <item> and <entry> blocks are looked at, so the channel heading above
     them never becomes a post. */
  assert.ok(!parseFeed(RSS).some((i) => i.title.includes("channel's own")));
  /* A blog that changed its software produces no events and no exception. */
  assert.deepEqual(parseFeed("<html><body>Not a feed at all</body></html>"), []);
  assert.deepEqual(parseFeed(""), []);
});

test("the feed parser stops at the cap", () => {
  const many = `<rss>${'<item><title>x</title><pubDate>Wed, 03 Sep 2026 10:00:00 GMT</pubDate></item>'.repeat(60)}</rss>`;
  assert.equal(parseFeed(many, 40).length, 40);
});

/* ------------------------------------------------------------ the name key */

test("the name key is first word and last word, folded", () => {
  assert.equal(nameKey("Andrej Karpathy"), "andrej karpathy");
  assert.equal(nameKey("andrej  karpathy"), "andrej karpathy");
  /* A middle name or an initial is not an identity and must not stop a match:
     the same human signs their mail three ways. */
  assert.equal(nameKey("Andrej J. Karpathy"), "andrej karpathy");
  /* Accents folded, because "José García" and "Jose Garcia" are one person
     typed by two keyboards. */
  assert.equal(nameKey("José García"), nameKey("Jose Garcia"));
  /* The comma clause `dossierTitle` keeps is cut off here, or the key would be
     "jane acme". */
  assert.equal(nameKey("Jane Doe, founder of Acme"), "jane doe");
  /* One word is one word, not half a key. */
  assert.equal(nameKey("Theo"), "theo");
  assert.equal(nameKey(""), "");
  assert.equal(nameKey(null), "");
});

test("the name key does not merge two different people into one", () => {
  assert.notEqual(nameKey("Jane Doe"), nameKey("Janet Doe"));
  assert.notEqual(nameKey("Jane Doe"), nameKey("Jane Doe-Smith"));
});

/* ---------------------------------------------------------- the merge rule */

const held = {
  company: "Stripe",
  role: "",
  email: "",
  note: "Introduced by Peter.",
  links: { github: "pc", website: "" } as Record<string, string>,
  tags: ["fintech"],
};

test("an import fills empty fields and never overwrites a full one", () => {
  const merged = mergeWatchFields(held, {
    company: "Stripe, Inc.",
    role: "Co-founder & CEO",
    email: "someone@example.com",
    note: "Imported note.",
    links: {},
    tags: [],
  });
  /* THE RULE. What he typed wins; the file only fills gaps. */
  assert.equal(merged.company, "Stripe");
  assert.equal(merged.note, "Introduced by Peter.");
  /* And the empty ones are filled, which is the whole point of importing. */
  assert.equal(merged.role, "Co-founder & CEO");
  assert.equal(merged.email, "someone@example.com");
});

test("links merge one key at a time and tags are a union", () => {
  const merged = mergeWatchFields(held, {
    company: "",
    role: "",
    email: "",
    note: "",
    links: { github: "patrickcollison", website: "patrickcollison.com", hn: "pc" },
    tags: ["Fintech", "watchlist"],
  });
  /* A typed GitHub survives an imported one; an empty website is filled; a key
     nobody had before arrives. */
  assert.equal(merged.links.github, "pc");
  assert.equal(merged.links.website, "patrickcollison.com");
  assert.equal(merged.links.hn, "pc");
  /* Tags are shelves, not values: adding one takes nothing away, and "Fintech"
     is the same shelf as "fintech". */
  assert.deepEqual(merged.tags, ["fintech", "watchlist"]);
});

test("importing the same row twice is a no-op", () => {
  const incoming = {
    company: "Stripe",
    role: "Co-founder",
    email: "",
    note: "",
    links: { github: "pc" },
    tags: ["fintech"],
  };
  const once = mergeWatchFields(held, incoming);
  const twice = mergeWatchFields({ ...held, ...once }, incoming);
  assert.deepEqual(twice, once);
});

/* --------------------------------------------------------------- the avatar */

test("GitHub's avatar wins, then Bluesky, then whatever an import wrote down", () => {
  /* The order is the argument in `pickAvatar`: the face most of these people
     actually maintain is the one on their commits. */
  assert.deepEqual(
    pickAvatar({
      github: "https://avatars.githubusercontent.com/u/6983?v=4",
      bluesky: "https://cdn.bsky.app/img/avatar/x@jpeg",
      imported: "https://example.com/old.png",
    }),
    { url: "https://avatars.githubusercontent.com/u/6983?v=4", from: "GitHub" },
  );
  /* Bluesky is second, and it is reached whenever GitHub offered nothing —
     including a GitHub call that failed this time round. */
  assert.deepEqual(
    pickAvatar({ github: null, bluesky: "https://cdn.bsky.app/img/avatar/x@jpeg", imported: "https://example.com/old.png" }),
    { url: "https://cdn.bsky.app/img/avatar/x@jpeg", from: "Bluesky" },
  );
  /* THE IMPORTED URL IS A FALLBACK AND NOT A SOURCE. It is only reached when
     neither live profile yielded one, which is what keeps a third party's
     older record of somebody's face from beating a profile read this minute. */
  assert.deepEqual(pickAvatar({ imported: "https://example.com/old.png" }), {
    url: "https://example.com/old.png",
    from: "the import",
  });
});

test("no address anywhere is no picture, and a non-web address is no address", () => {
  assert.equal(pickAvatar({}), null);
  assert.equal(pickAvatar({ github: "", bluesky: "   ", imported: null }), null);
  /* A `data:` or `file:` URL in this position would point the fetcher at this
     box's own disk. There is no avatar for which that is the right answer. */
  assert.equal(pickAvatar({ imported: "file:///etc/passwd" }), null);
  assert.equal(pickAvatar({ github: "data:image/png;base64,iVBOR" }), null);
  assert.equal(pickAvatar({ github: "avatars.githubusercontent.com/u/1" }), null);
});

test("nothing is downloaded again unless the address, the bytes or the week changed", () => {
  const at = Date.parse("2026-09-07T12:00:00.000Z");
  const url = "https://avatars.githubusercontent.com/u/6983?v=4";
  const fresh = { source: url, at: "2026-09-05T12:00:00.000Z", stored: true };

  /* The common case, and it must cost no traffic at all. */
  assert.equal(avatarDue(fresh, url, at), false);
  /* They changed their photo and the URL changed with it — which is what both
     GitHub and Bluesky do. */
  assert.equal(avatarDue(fresh, `${url}&v=5`, at), true);
  /* A source recorded by an import with nothing ever fetched against it. */
  assert.equal(avatarDue({ source: url, at: null, stored: false }, url, at), true);
  /* A week old, so it is worth asking whether the same URL now holds a
     different picture. */
  assert.equal(
    avatarDue({ source: url, at: "2026-08-20T12:00:00.000Z", stored: true }, url, at),
    true,
  );
  /* A stamp nothing can parse is not a claim about freshness. */
  assert.equal(avatarDue({ source: url, at: "not a date", stored: true }, url, at), true);
});

test("only an image of a sane size is stored, and the reason is a sentence", () => {
  assert.deepEqual(avatarGate("image/png", 40_000), { mime: "image/png" });
  /* Real headers carry parameters, and the mime is stored and compared, so it
     is cut at the semicolon and folded. */
  assert.deepEqual(avatarGate("IMAGE/JPEG; charset=binary", 40_000), { mime: "image/jpeg" });

  /* THE FAILURE THIS GATE EXISTS FOR: a source that answered 200 with an error
     page. Storing it would launder somebody else's HTML into an <img>. */
  assert.deepEqual(avatarGate("text/html; charset=utf-8", 4_000), {
    error: "it answered text/html, which is not an image",
  });
  assert.deepEqual(avatarGate(null, 4_000), {
    error: "it did not say what kind of file it was sending",
  });
  assert.deepEqual(avatarGate("image/png", 0), { error: "it answered an empty body" });
  assert.deepEqual(avatarGate("image/png", MAX_AVATAR_BYTES + 1), {
    error: "it is larger than 2 MB",
  });
  /* Exactly at the cap is inside it. */
  assert.deepEqual(avatarGate("image/png", MAX_AVATAR_BYTES), { mime: "image/png" });
});

/* ------------------------------------------------- the series and the deltas */

const metrics = (m: Partial<Metrics>): Metrics => ({
  ghFollowers: null,
  ghRepos: null,
  bskyFollowers: null,
  bskyPosts: null,
  hnKarma: null,
  at: null,
  ...m,
});

const point = (at: string, m: Partial<MetricHistoryRow> = {}): MetricHistoryRow => ({
  day: at.slice(0, 10),
  at,
  ghFollowers: null,
  ghRepos: null,
  bskyFollowers: null,
  bskyPosts: null,
  hnKarma: null,
  ...m,
});

test("the day is the UTC day, so a box that moves timezone cannot write two", () => {
  assert.equal(dayOf("2026-09-07T23:59:59.000Z"), "2026-09-07");
  assert.equal(dayOf("2026-09-08T00:00:01.000Z"), "2026-09-08");
  /* A stamp nobody can parse is not a day. It must not become "1970-01-01",
     which would key every unreadable pull onto one row at the far end of the
     series and put a spike in every chart. */
  assert.equal(dayOf("not a date"), "");
});

test("ISO days sort lexicographically, which is what the prune rests on", () => {
  /* `writeHistory` keeps the newest MAX_HISTORY rows with ORDER BY day DESC
     over a TEXT column. That is only the newest rows if string order is date
     order — true for zero-padded ISO days and for nothing else. */
  const days = ["2026-01-09", "2025-12-31", "2026-10-02", "2026-01-10"];
  assert.deepEqual([...days].sort(), ["2025-12-31", "2026-01-09", "2026-01-10", "2026-10-02"]);
  assert.ok(MAX_HISTORY > 366, "a cap under a year could not draw a year");
});

test("the base row is the newest one old enough, not the oldest on file", () => {
  const at = Date.parse("2026-09-07T12:00:00.000Z");
  const rows = [
    point("2026-06-01T12:00:00.000Z", { ghFollowers: 10 }),
    point("2026-08-28T12:00:00.000Z", { ghFollowers: 90 }),
    point("2026-08-31T12:00:00.000Z", { ghFollowers: 100 }),
    point("2026-09-07T12:00:00.000Z", { ghFollowers: 140 }),
  ];
  /* Seven days back is the 31st. The 28th is also old enough and is the wrong
     answer: quoting a ten-day movement as a week's is a confident lie. */
  assert.equal(rowAgo(rows, DELTA_DAYS, at)?.ghFollowers, 100);
});

test("a person watched for four days has no seven-day base at all", () => {
  const at = Date.parse("2026-09-07T12:00:00.000Z");
  const rows = [point("2026-09-04T12:00:00.000Z"), point("2026-09-07T12:00:00.000Z")];
  /* Falling back to the oldest available row would report four days of
     movement as a week's, which is the quietest wrong answer here. */
  assert.equal(rowAgo(rows, DELTA_DAYS, at), null);
});

test("a delta exists only where BOTH readings are numbers, and 0 is a reading", () => {
  const base = point("2026-08-31T12:00:00.000Z", { ghFollowers: 100, ghRepos: 12, hnKarma: null });
  const d = deltasFrom(base, metrics({ ghFollowers: 140, ghRepos: 12, hnKarma: 400 }));
  assert.equal(d.ghFollowers, 40);
  /* Present and zero: they gained nobody this week, which is a measurement. */
  assert.ok("ghRepos" in d);
  /* Absent: there is no karma reading from a week ago to subtract. Writing it
     as 0 would put "no change" under a figure nobody has ever measured. */
  assert.ok(!("hnKarma" in d));
  assert.ok(!("bskyFollowers" in d));
});

test("no base row at all is an empty object, never a set of zeroes", () => {
  assert.deepEqual(deltasFrom(null, metrics({ ghFollowers: 140 })), {});
  assert.deepEqual(deltasFrom(undefined, metrics({ ghFollowers: 140 })), {});
});

/* ------------------------------------------------------------- the signals */

test("a follower move must clear ten AND one per cent, in either direction", () => {
  /* A small account: ten is the binding half. Nine is noise. */
  assert.equal(spikeSignal("GitHub followers", 49, 40), null);
  assert.ok(spikeSignal("GitHub followers", 50, 40)?.startsWith("GitHub followers +10"));
  /* A large one: one per cent is the binding half, and without it this row
     would be filed every single day about a count that wobbles by hundreds. */
  assert.equal(spikeSignal("GitHub followers", 200_100, 200_000), null);
  assert.ok(spikeSignal("GitHub followers", 203_000, 200_000));
  /* Downwards is the more interesting direction and must not be dropped. */
  const lost = spikeSignal("Bluesky followers", 8_000, 12_000);
  assert.ok(lost?.includes("-4,000"), lost ?? "nothing was said");
  assert.ok(lost?.includes("now 8,000"));
});

test("a spike needs both readings, and a first pull has only one", () => {
  assert.equal(spikeSignal("HN karma", 4_000, null), null);
  assert.equal(spikeSignal("HN karma", null, 4_000), null);
  assert.equal(spikeSignal("HN karma", null, null), null);
});

test("new public repos are announced going up and never going down", () => {
  assert.equal(repoSignal(13, 12), "A new public repo on GitHub");
  assert.equal(repoSignal(15, 12), "3 new public repos on GitHub");
  assert.equal(repoSignal(12, 12), null);
  /* A repository made private or renamed is housekeeping, not news. */
  assert.equal(repoSignal(11, 12), null);
  assert.equal(repoSignal(13, null), null);
});

test("a bio seen for the first time has not changed, it has become known", () => {
  assert.equal(bioSignal("Building things", null), null);
  assert.equal(bioSignal("Building things", ""), null);
  /* And a bio that vanished is a source that did not answer, not a rewrite. */
  assert.equal(bioSignal(null, "Building things"), null);
});

test("a line break moved is not a rewrite, and a rewrite is quoted", () => {
  assert.equal(bioSignal("Building  things\n", "Building things"), null);
  const said = bioSignal("Building other things", "Building things");
  assert.ok(said?.startsWith("Bio changed — now: "));
  assert.ok(said?.includes("Building other things"));
  /* Long ones are cut rather than pasted whole onto a timeline row. */
  const long = bioSignal("x".repeat(400), "something else");
  assert.ok((long ?? "").length < 200 && long?.endsWith("…"));
});

test("a signal is keyed by its sentence AND its day", () => {
  /* Twice in one afternoon is one row: the sweep and the refresh button must
     not both file it. */
  assert.equal(changeKey("Bio changed", "2026-09-07"), changeKey("Bio changed", "2026-09-07"));
  /* Next month is a new row: a bio can be rewritten more than once, and under
     `eventKey` the second rewrite would silently overwrite the first. */
  assert.notEqual(changeKey("Bio changed", "2026-09-07"), changeKey("Bio changed", "2026-10-07"));
  assert.notEqual(changeKey("Bio changed", "2026-09-07"), eventKey("watch", null, "Bio changed"));
});

/* --------------------------------------------------------------- the sweep */

const watched = (activity_at: string | null): WatchRow => ({ activity_at }) as WatchRow;

test("a row nobody can date is due, rather than never due again", () => {
  const at = Date.parse("2026-09-07T12:00:00.000Z");
  /* `Date.parse(junk) < cutoff` is false, so before `pulledAt` a single row
     with a hand-written stamp fell out of every sweep from then on, silently,
     for as long as the box ran. */
  assert.equal(due([watched("yesterday-ish")], at).length, 1);
  assert.equal(due([watched(null)], at).length, 1);
  assert.equal(due([watched(new Date(at - 3_600_000).toISOString())], at).length, 0);
  assert.equal(due([watched(new Date(at - SWEEP_AFTER_MS - 1).toISOString())], at).length, 1);
});

test("the list-level stamp is the OLDEST pull, because that is when everyone had been read", () => {
  const at = Date.parse("2026-09-07T12:00:00.000Z");
  const state = sweepState(
    [
      watched(new Date(at - 3_600_000).toISOString()),
      watched(new Date(at - 3 * 3_600_000).toISOString()),
      watched(new Date(at - 2 * 3_600_000).toISOString()),
    ],
    at,
  );
  assert.equal(state.everyonePulled, true);
  /* Not "a second ago" because one person was just refreshed. */
  assert.equal(state.lastAt, new Date(at - 3 * 3_600_000).toISOString());
  assert.equal(state.nextDueAt, new Date(at - 3 * 3_600_000 + SWEEP_AFTER_MS).toISOString());
});

test("one never-pulled person means there was no moment the list was complete", () => {
  const at = Date.parse("2026-09-07T12:00:00.000Z");
  const state = sweepState([watched(new Date(at - 3_600_000).toISOString()), watched(null)], at);
  assert.deepEqual(state, { lastAt: null, nextDueAt: null, everyonePulled: false });
});

test("somebody due already is a null next, not a stamp in the past", () => {
  const at = Date.parse("2026-09-07T12:00:00.000Z");
  const state = sweepState([watched(new Date(at - SWEEP_AFTER_MS - 60_000).toISOString())], at);
  assert.equal(state.everyonePulled, true);
  assert.equal(state.nextDueAt, null);
});

test("an empty watchlist has not been pulled for everyone", () => {
  /* Vacuously true and a lie on a page: "pulled for everyone" about nobody. */
  assert.deepEqual(sweepState([]), { lastAt: null, nextDueAt: null, everyonePulled: false });
});
