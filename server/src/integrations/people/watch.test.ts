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
 */
import assert from "node:assert/strict";
import test from "node:test";
import { attaches, composeBrief, handle, mergeWatchFields, nameKey } from "./watch.ts";
import { parseFeed } from "./activity.ts";
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
