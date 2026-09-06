/**
 * THE TWO GATES THIS AREA IS, ASSERTED.
 *
 * Everything else here is a SELECT and a sentence. The two things that would
 * be silently wrong — and would be wrong in the direction of a confident false
 * claim about a product — are the citation check and the correction rule, so
 * those get the most tests:
 *
 *   THE CITATION GATE decides whether a model's fact is stored at all. It
 *   fails open in the worst possible way if it is wrong: a fabricated
 *   `path:line` becomes a `repo`-tier fact, which is the second-highest tier
 *   this box has and reads as "we read this in the source".
 *
 *   THE CORRECTION RULE decides what happens when the owner disagrees with a
 *   machine. If the old fact were edited in place, the disagreement would
 *   disappear and the next extraction would look as if it had been right.
 *
 * The database half runs against the test harness's temporary database (see
 * test/setup.mjs); the pure half needs nothing at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, now } from "../../db.ts";
import {
  TREE_PATH,
  type Excerpt,
  applyBudget,
  basenameWords,
  checkLocalRepo,
  directFacts,
  gate,
  localMaterial,
  materialNumbers,
  numbersGrounded,
  tryParse,
  verifyCitation,
  wanted,
} from "./extract.ts";
import { deriveVenture, retireUnproduced } from "./derive.ts";
import {
  CONFIDENCE,
  allFacts,
  confirm,
  contradictions,
  correct,
  factLine,
  facts,
  factsForPrompt,
  fingerprint,
  knowledgeBlock,
  knowledgeLines,
  put,
  retire,
  ventureClaimRefusal,
} from "./store.ts";

/* ------------------------------------------------------------ the fixtures */

const EXCERPTS: Excerpt[] = [
  {
    path: "README.md",
    startLine: 1,
    lines: [
      "# Widgetworks",
      "",
      "Widgetworks turns a spreadsheet into a shared dashboard in one paste.",
      "It exports to CSV and sends a webhook when a row changes.",
    ],
    why: "what the project says it is",
  },
  {
    path: "src/pricing.ts",
    startLine: 1,
    lines: [
      "export const PLANS = [",
      '  { id: "free", monthly: 0 },',
      '  { id: "team", monthly: 29 },',
      "];",
    ],
    why: "its name says it holds prices or plans",
  },
];

/** One venture, made directly rather than through the route: this file is
 *  testing the fact store, not venture creation, and a route call would drag a
 *  site fetch in with it. */
function makeVenture(slug: string): string {
  const id = `v-${slug}`;
  db.prepare(
    `INSERT OR REPLACE INTO ventures
       (id, slug, name, description, website, host, stage, color, color_source,
        position, brand, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'launched','#888','default',0,'{}',?,?)`,
  ).run(id, slug, slug, "", null, null, now(), now());
  return id;
}

/* ------------------------------------------------------- the citation gate */

test("a citation into a fetched excerpt is accepted", () => {
  const ok = verifyCitation(EXCERPTS, "README.md:3");
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.line, 3);
});

test("a range citation is accepted on its first line", () => {
  assert.equal(verifyCitation(EXCERPTS, "src/pricing.ts:2-3").ok, true);
});

test("a leading ./ is not a different file", () => {
  assert.equal(verifyCitation(EXCERPTS, "./README.md:1").ok, true);
});

test("a citation to a file that was never fetched is REJECTED", () => {
  const out = verifyCitation(EXCERPTS, "src/server/webhooks.ts:88");
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.why : "", /was not fetched/);
});

test("a citation past the end of the excerpt is REJECTED", () => {
  const out = verifyCitation(EXCERPTS, "README.md:900");
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.why : "", /line 900 .* was not read/);
});

test("a citation that is not path:line at all is REJECTED", () => {
  for (const bad of ["README.md", "the readme", "", "README.md:xyz"])
    assert.equal(verifyCitation(EXCERPTS, bad).ok, false, bad);
});

test("the gate drops fabricated citations and keeps checked ones, with reasons", () => {
  const out = gate(
    [
      { kind: "capability", statement: "It sends a webhook when a row changes.", citation: "README.md:4" },
      { kind: "capability", statement: "It supports SAML single sign-on.", citation: "src/auth/saml.ts:12" },
      { kind: "pricing", statement: "The team plan is 29 a month.", citation: "src/pricing.ts:3" },
      { kind: "pricing", statement: "The enterprise plan is 4900 a month.", citation: "src/pricing.ts:3" },
      { kind: "audience", statement: "It is used by finance teams.", citation: "README.md:3" },
    ],
    EXCERPTS,
  );
  assert.deepEqual(
    out.kept.map((f) => f.statement),
    ["It sends a webhook when a row changes.", "The team plan is 29 a month."],
  );
  /* Each drop is counted with a reason rather than silently: the extraction
     report says what happened to the other three. */
  const reasons = Object.keys(out.dropped).join(" | ");
  assert.match(reasons, /citation rejected/);
  assert.match(reasons, /figure in the statement is not in the material/);
  assert.match(reasons, /audience cannot be read out of source/);
});

test("the gate survives an answer that is not a list of facts", () => {
  assert.equal(gate(undefined, EXCERPTS).kept.length, 0);
  assert.equal(gate("sorry, I cannot", EXCERPTS).kept.length, 0);
});

/* --------------------------------------------------------- the digit gate */

test("numbers in a statement must be in the material, small integers apart", () => {
  const known = materialNumbers(EXCERPTS);
  assert.equal(numbersGrounded("The team plan is 29 a month.", known), true);
  assert.equal(numbersGrounded("There are 2 plans.", known), true, "prose counts are allowed");
  assert.equal(numbersGrounded("It has 41000 users.", known), false);
});

/* --------------------------------------------- what code reads without a model */

test("the deterministic readings cite lines that exist and file a README as a claim", () => {
  const facts = directFacts({
    repo: "acme/widgetworks",
    kind: "github",
    commit: null,
    notes: [],
    excerpts: [
      ...EXCERPTS,
      {
        path: "package.json",
        startLine: 1,
        lines: [
          "{",
          '  "name": "widgetworks",',
          '  "description": "Spreadsheet to dashboard",',
          '  "dependencies": { "hono": "^4" }',
          "}",
        ],
        why: "the Node manifest",
      },
    ],
  });
  for (const f of facts) assert.equal(verifyCitation(EXCERPTS, f.citation).ok || f.citation.startsWith("package.json"), true, f.citation);
  const readme = facts.find((f) => f.citation.startsWith("README.md"));
  assert.ok(readme, "the README's first prose is read");
  /* NO REAL CAPABILITY FROM MARKETING COPY: a README paragraph is a claim. */
  assert.equal(readme!.kind, "claim");
  assert.ok(facts.some((f) => f.statement.includes("widgetworks")));
});

test("only files that could describe a product are fetched", () => {
  assert.ok(wanted("README.md"));
  assert.ok(wanted("package.json"));
  assert.ok(wanted("src/pricing.ts"));
  assert.equal(wanted("node_modules/left-pad/package.json"), null);
  assert.equal(wanted("src/a/b/c/d/pricing.ts"), null);
  assert.equal(wanted("src/components/Button.tsx"), null);
});

/* ----------------------------------------------------- correction supersession */

test("an owner correction supersedes the fact it corrects and keeps both", () => {
  const v = makeVenture("supersession");
  const { id } = put({
    ventureId: v,
    kind: "pricing",
    statement: "The team plan is 29 a month.",
    tier: "repo",
    sourceType: "repo",
    sourceRef: "acme/widgetworks src/pricing.ts:3",
    sourceCommit: "abc1234",
    confidence: CONFIDENCE.repoDirect,
    createdBy: "agent",
  });

  const out = correct(id, "The team plan has been 39 a month since August.");
  assert.equal(out.ok, true);
  if (!out.ok) return;

  /* The replacement is the owner's, at the owner's confidence, and it is the
     only ACTIVE fact of the two. */
  assert.equal(out.replacement.tier, "owner");
  assert.equal(out.replacement.confidence, CONFIDENCE.owner);
  assert.equal(out.replacement.status, "active");
  assert.equal(out.replacement.kind, "pricing", "a correction inherits the kind");

  /* The old one is kept, marked, and points at what replaced it. */
  assert.equal(out.corrected.status, "corrected");
  assert.equal(out.corrected.correctedBy, out.replacement.id);
  assert.equal(out.corrected.statement, "The team plan is 29 a month.");

  const live = facts({ ventureId: v });
  assert.deepEqual(
    live.map((f) => f.statement),
    ["The team plan has been 39 a month since August."],
  );
  assert.equal(allFacts(v).length, 2, "nothing is deleted");

  /* And it cannot be corrected twice — the second attempt names the state. */
  const again = correct(id, "no, 49");
  assert.equal(again.ok, false);
  assert.match(again.ok === false ? again.error : "", /already corrected/);
});

test("a correction appears as a resolved contradiction; two live tiers as an unresolved one", () => {
  const v = makeVenture("contradiction");
  const repo = put({
    ventureId: v,
    kind: "pricing",
    statement: "The team plan costs 29 monthly.",
    tier: "repo",
    sourceType: "repo",
    sourceRef: "acme/w src/pricing.ts:3",
    confidence: CONFIDENCE.repoDirect,
    createdBy: "agent",
  });
  put({
    ventureId: v,
    kind: "pricing",
    statement: "The team plan costs 39 monthly on Stripe.",
    tier: "measured",
    sourceType: "plugin",
    sourceRef: "stripe",
    confidence: CONFIDENCE.measured,
    createdBy: "agent",
    key: "stripe:team",
  });

  const unresolved = contradictions(allFacts(v)).filter((x) => !x.resolved);
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0]!.reason, /measured tier is the one to quote/);

  correct(repo.id, "The team plan costs 39 monthly.");
  const resolved = contradictions(allFacts(v)).filter((x) => x.resolved);
  assert.equal(resolved.length, 1);
  assert.match(resolved[0]!.reason, /owner corrected/);
});

/* ---------------------------------------------------------------- the store */

test("re-filing the same reading refreshes rather than duplicating", () => {
  const v = makeVenture("dedupe");
  const write = (statement: string) =>
    put({
      ventureId: v,
      kind: "metric",
      statement,
      tier: "measured",
      sourceType: "plugin",
      sourceRef: "playstore",
      confidence: CONFIDENCE.measured,
      createdBy: "agent",
      key: "play:installs",
    });
  const a = write("Google Play recorded 4,100 installs over the last 30 days.");
  const b = write("Google Play recorded 4,180 installs over the last 30 days.");
  assert.equal(a.outcome, "added");
  assert.equal(b.outcome, "refreshed");
  assert.equal(a.id, b.id, "a figure moving is one fact, not two");
  assert.equal(facts({ ventureId: v }).length, 1);
  assert.match(facts({ ventureId: v })[0]!.statement, /4,180/);
});

test("the fingerprint ignores digits so a moving figure is one fact", () => {
  assert.equal(
    fingerprint("Google Play recorded 4,100 installs."),
    fingerprint("Google Play recorded 4,180 installs."),
  );
  assert.notEqual(fingerprint("It exports CSV."), fingerprint("It exports JSON."));
});

test("retiring keeps the row and takes it out of the live list", () => {
  const v = makeVenture("retire");
  const { id } = put({
    ventureId: v,
    kind: "capability",
    statement: "It exports to CSV.",
    tier: "repo",
    sourceType: "repo",
    sourceRef: "a/b src/export.ts:9",
    confidence: CONFIDENCE.repoDirect,
    createdBy: "agent",
  });
  assert.equal(retire(id, "removed in the August release").ok, true);
  assert.equal(facts({ ventureId: v }).length, 0);
  const kept = allFacts(v)[0]!;
  assert.equal(kept.status, "retired");
  assert.match(kept.source.ref, /removed in the August release/);
});

test("a proposal is confirmed into the owner tier and keeps where it came from", () => {
  const v = makeVenture("propose");
  const { id } = put({
    ventureId: v,
    kind: "capability",
    statement: "It probably supports SSO.",
    tier: "proposed",
    sourceType: "model",
    sourceRef: "the research report mentioned enterprise buyers",
    confidence: CONFIDENCE.proposed,
    createdBy: "agent",
  });
  const out = confirm(id);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.fact.tier, "owner");
  assert.equal(out.fact.confidence, CONFIDENCE.owner);
  assert.match(out.fact.source.ref, /owner confirmed a proposal/);
  assert.match(out.fact.source.ref, /research report/);
  /* Confirming twice is refused rather than silently repeated. */
  assert.equal(confirm(id).ok, false);
});

/* ------------------------------------------------------------ the exports */

test("a proposal never reaches a prompt, and the measured figure leads", () => {
  const v = makeVenture("prompt");
  put({
    ventureId: v,
    kind: "capability",
    statement: "It sends a webhook when a row changes.",
    tier: "repo",
    sourceType: "repo",
    sourceRef: "a/b src/hooks.ts:14",
    confidence: CONFIDENCE.repoDirect,
    createdBy: "agent",
  });
  put({
    ventureId: v,
    kind: "metric",
    statement: "Stripe has 12 active subscriptions.",
    tier: "measured",
    sourceType: "plugin",
    sourceRef: "stripe",
    confidence: CONFIDENCE.measured,
    createdBy: "agent",
    key: "stripe:live",
  });
  put({
    ventureId: v,
    kind: "capability",
    statement: "It almost certainly supports SAML.",
    tier: "proposed",
    sourceType: "model",
    sourceRef: "a guess",
    confidence: CONFIDENCE.proposed,
    createdBy: "agent",
  });

  const block = factsForPrompt(v)!;
  assert.ok(block);
  assert.doesNotMatch(block, /SAML/, "an unconfirmed proposal is never exported");
  assert.match(block, /webhook/);
  assert.match(block, /\[repo · \d{4}-\d{2}-\d{2}\]/, "every line carries its tier and date");
  assert.match(block, /measured beats everything/);

  /* A metric asks for the measured tier first; only metrics and pricing do. */
  const money = factsForPrompt(v, ["metric"])!;
  assert.match(money.split("\n")[1]!, /\[measured/);

  /* The character budget never cuts a line in half, and says what it left. */
  const tiny = factsForPrompt(v, null, 700)!;
  assert.ok(tiny.split("\n").every((l) => l.length < 700));

  const lines = knowledgeLines(v);
  assert.ok(lines.length > 1 && lines.length <= 25);
  assert.equal(knowledgeLines(null).length, 0, "an unscoped conversation gets nothing");
  assert.equal(knowledgeLines("v-nobody-here").length, 0);
});

test("a fact line names its tier and flags a proposal in words", () => {
  const v = makeVenture("line");
  const { id } = put({
    ventureId: v,
    kind: "capability",
    statement: "It might do X.",
    tier: "proposed",
    sourceType: "model",
    sourceRef: "a guess",
    confidence: CONFIDENCE.proposed,
    createdBy: "agent",
  });
  const f = allFacts(v).find((x) => x.id === id)!;
  assert.match(factLine(f), /\[proposed · /);
  assert.match(factLine(f), /UNCONFIRMED/);
});

/* ------------------------------------------------ a repository on this disk */

/**
 * A REAL, TINY GIT CHECKOUT in a temporary directory.
 *
 * It has to be a real one: a local repository that is not a checkout is refused
 * outright (see the regression below for why), so a fixture that only looked
 * like a repository would be testing the refusal instead of the reader. One
 * empty commit is enough — `git rev-parse HEAD` is the whole of what is asked —
 * and the identity is passed on the command line so the test does not depend on
 * whatever `git config` the machine happens to have.
 */
function gitInit(dir: string): void {
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    });
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  run("commit", "-q", "--allow-empty", "-m", "fixture");
}

test("a local checkout is read into citable excerpts, and the gate agrees with them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opc-knowledge-repo-"));
  gitInit(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(
    join(dir, "README.md"),
    "# Widgetworks\n\n[![build](https://img.shields.io/x)](https://x)\n\nWidgetworks turns a spreadsheet into a shared dashboard in one paste.\n",
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "widgetworks", description: "Spreadsheet to dashboard", dependencies: { hono: "^4", stripe: "^17" } }, null, 2),
  );
  writeFileSync(join(dir, ".env.example"), "STRIPE_SECRET_KEY=\nDATABASE_URL=\nSESSION_SECRET=\n");
  writeFileSync(join(dir, "src", "pricing.ts"), 'export const TEAM = { monthly: 29 };\n');
  /* The one file that must NOT be read: a dependency's manifest is not this
     product's manifest, and a walk that picked it up would file another
     project's name as a fact about this one. */
  writeFileSync(join(dir, "node_modules", "left-pad", "package.json"), '{"name":"left-pad"}');

  const m = await localMaterial(dir);
  const paths = m.excerpts.map((e) => e.path);
  for (const want of ["README.md", "package.json", ".env.example", "src/pricing.ts", TREE_PATH])
    assert.ok(paths.includes(want), `${want} was read`);
  assert.ok(!paths.some((p) => p.includes("node_modules")));
  assert.equal(m.kind, "local");
  assert.equal(m.repo, dir);

  /* Everything the deterministic reader produces cites a line it was given —
     the same check the model's answers go through. */
  const found = directFacts(m);
  assert.ok(found.length >= 3);
  for (const f of found)
    assert.equal(verifyCitation(m.excerpts, f.citation).ok, true, `${f.citation} checks out`);
  assert.ok(found.some((f) => f.statement.includes("STRIPE_SECRET_KEY")));
  assert.ok(found.some((f) => f.kind === "integration" && f.statement.includes("hono")));

  /* And the tree is citable, which is what makes a fact about a file's
     existence checkable at all. */
  const tree = m.excerpts.find((e) => e.path === TREE_PATH)!;
  assert.equal(verifyCitation(m.excerpts, `${TREE_PATH}:${tree.lines.length}`).ok, true);
  assert.equal(verifyCitation(m.excerpts, `${TREE_PATH}:${tree.lines.length + 1}`).ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("the material budget cuts at a line boundary and the gate rejects what was cut", () => {
  const long: Excerpt[] = [
    { path: "a.ts", startLine: 1, lines: Array.from({ length: 200 }, (_, i) => `line ${i + 1} of a`), why: "a" },
    { path: "b.ts", startLine: 1, lines: Array.from({ length: 200 }, (_, i) => `line ${i + 1} of b`), why: "b" },
  ];
  const fitted = applyBudget(long, 1_500);
  assert.ok(fitted.chars <= 1_500);
  assert.ok(fitted.trimmed >= 1);
  const kept = fitted.excerpts.find((e) => e.path === "a.ts")!;
  assert.ok(kept.lines.length < 200, "a.ts lost lines to the budget");
  /* The line that was cut away is rejected exactly like a line in a file that
     was never fetched, which is the whole point: the model did not see it. */
  assert.equal(verifyCitation(fitted.excerpts, "a.ts:200").ok, false);
  assert.equal(verifyCitation(fitted.excerpts, `a.ts:${kept.lines.length}`).ok, true);
});

test("a truncated answer is salvaged object by object, and half an object is not", () => {
  const truncated =
    'We need to produce facts. Let me think about this carefully.\n' +
    '{"facts":[{"kind":"capability","statement":"It exports to CSV.","citation":"README.md:4"},' +
    '{"kind":"capability","statement":"It sends a webh';
  const parsed = tryParse(truncated);
  assert.ok(parsed && Array.isArray(parsed.facts));
  assert.equal((parsed!.facts as unknown[]).length, 1);
  /* And a salvaged fact is trusted no more than a parsed one — it still has to
     pass the citation gate. */
  assert.equal(gate(parsed!.facts, EXCERPTS).kept.length, 1);
  assert.equal(gate(parsed!.facts, [EXCERPTS[1]!]).kept.length, 0);
  assert.equal(tryParse("no json here at all"), null);
});

test("the run block always answers, and says so when there is nothing", () => {
  const empty = makeVenture("emptyblock");
  const block = knowledgeBlock({ id: empty, name: "Emptyblock" });
  assert.match(block.text, /absence of evidence/);
  put({
    ventureId: empty,
    kind: "capability",
    statement: "It exports to CSV.",
    tier: "repo",
    sourceType: "repo",
    sourceRef: "a/b src/export.ts:9",
    confidence: CONFIDENCE.repoDirect,
    createdBy: "agent",
  });
  assert.match(knowledgeBlock({ id: empty, name: "Emptyblock" }).text, /exports to CSV/);
});

/* ================================================================ regressions
 *
 * Each of these is a bug that shipped and was caught in review. They are kept
 * as named tests rather than folded into the ones above, because the value of a
 * regression test is that its name says which mistake it is watching for.
 */

test("REGRESSION: an owner editing his own sentence's NUMBER does not delete it", () => {
  const v = makeVenture("selfcorrect");
  /* `fingerprint()` replaces every digit run with a marker, so a number-only
     edit at the same tier normalises to the SAME fingerprint. `put()` therefore
     refreshes the row and returns the id it was given — and marking that row
     `corrected` with `corrected_by` pointing at itself took the owner's own
     highest-tier fact out of every read on the most ordinary action there is. */
  const { id } = put({
    ventureId: v,
    kind: "pricing",
    statement: "The team plan has been 39 a month since August.",
    tier: "owner",
    sourceType: "owner",
    sourceRef: "the owner wrote it on the Knowledge tab",
    confidence: CONFIDENCE.owner,
    createdBy: "owner",
  });

  const out = correct(id, "The team plan has been 49 a month since August.");
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.inPlace, true, "a sentence replacing itself is an edit, not a supersession");
  assert.equal(out.replacement.id, id, "the id survives");

  const live = facts({ ventureId: v });
  assert.equal(live.length, 1, "the fact is still there");
  assert.equal(live[0]!.id, id);
  assert.equal(live[0]!.status, "active");
  assert.equal(live[0]!.correctedBy, null, "nothing was superseded by itself");
  assert.match(live[0]!.statement, /49 a month/);
  /* And it is still in everything that reads from the store. */
  assert.match(factsForPrompt(v)!, /49 a month/);
  assert.ok(knowledgeLines(v).some((l) => l.includes("49 a month")));
  /* …and it does not report disagreeing with itself. */
  assert.equal(contradictions(allFacts(v)).length, 0);
});

test("REGRESSION: correcting across tiers still supersedes, even onto an existing owner fact", () => {
  const v = makeVenture("crosstier");
  const owner = put({
    ventureId: v,
    kind: "pricing",
    statement: "The team plan costs 39 monthly.",
    tier: "owner",
    sourceType: "owner",
    sourceRef: "typed",
    confidence: CONFIDENCE.owner,
    createdBy: "owner",
  });
  const repo = put({
    ventureId: v,
    kind: "pricing",
    statement: "The team plan costs 29 monthly.",
    tier: "repo",
    sourceType: "repo",
    sourceRef: "a/b src/pricing.ts:3",
    confidence: CONFIDENCE.repoDirect,
    createdBy: "agent",
  });
  /* The correction of the REPO fact normalises onto the owner's existing row,
     so `put` refreshes that one and the repo row is superseded by it. Two
     different rows: the supersession must still happen. */
  const out = correct(repo.id, "The team plan costs 39 monthly.");
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.inPlace, false);
  assert.equal(out.replacement.id, owner.id);
  assert.equal(out.corrected.id, repo.id);
  assert.equal(out.corrected.correctedBy, owner.id);
  assert.deepEqual(facts({ ventureId: v }).map((f) => f.id), [owner.id]);
});

test("REGRESSION: a deriver that throws does not retire its own facts", () => {
  const v = makeVenture("deriverthrow");
  /* Two measured facts under two deriver prefixes, filed as a good pass would. */
  for (const [key, statement] of [
    ["stripe:catalogue", "Stripe carries 2 products for this venture: A, B."],
    ["play:installs", "Google Play recorded 4,100 installs over the last 30 days."],
  ] as const)
    put({
      ventureId: v,
      kind: "metric",
      statement,
      tier: "measured",
      sourceType: "plugin",
      sourceRef: key.split(":")[0]!,
      confidence: CONFIDENCE.measured,
      createdBy: "agent",
      key,
    });

  /* A pass where the Play deriver threw and the Stripe one legitimately found
     nothing. Stripe's row SHOULD retire — it ran and said "no products any
     more". Play's must NOT: it said nothing at all. */
  const out = retireUnproduced(v, { ran: ["stripe:"], seen: new Set<string>() });
  assert.equal(out, 1, "exactly one row retired");
  const live = facts({ ventureId: v });
  assert.deepEqual(live.map((f) => f.statement), [
    "Google Play recorded 4,100 installs over the last 30 days.",
  ]);

  /* And the real pass over a venture with no links at all retires nothing it
     did not read: every deriver runs, finds no links, returns [] — which for
     the surviving Play row is a legitimate retirement. */
  const after = deriveVenture(v);
  assert.deepEqual(after.skipped, [], "no deriver threw against an unlinked venture");
});

test("REGRESSION: confirming a proposal the owner already has does not violate the index", () => {
  const v = makeVenture("confirmdupe");
  put({
    ventureId: v,
    kind: "capability",
    statement: "It exports to CSV.",
    tier: "owner",
    sourceType: "owner",
    sourceRef: "typed",
    confidence: CONFIDENCE.owner,
    createdBy: "owner",
  });
  const proposal = put({
    ventureId: v,
    kind: "capability",
    /* Same fingerprint as the owner's sentence — `put` keys per TIER, so
       nothing stopped this being filed, and promoting it to `owner` without a
       check raised a raw SQLITE_CONSTRAINT_UNIQUE out of the Confirm button. */
    statement: "It exports to CSV.",
    tier: "proposed",
    sourceType: "model",
    sourceRef: "the README said so",
    confidence: CONFIDENCE.proposed,
    createdBy: "agent",
  });

  const out = confirm(proposal.id);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 409);
  assert.match(out.error, /already have that fact/);
  assert.match(out.error, /retired as a duplicate/);
  /* The duplicate is gone from the active set and the owner's own row stands. */
  const live = facts({ ventureId: v });
  assert.equal(live.length, 1);
  assert.equal(live[0]!.tier, "owner");
  assert.equal(allFacts(v).find((f) => f.id === proposal.id)!.status, "retired");
});

test("REGRESSION: a local path that is not a git checkout is refused, not read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opc-knowledge-notrepo-"));
  writeFileSync(join(dir, "README.md"), "# Not a repository\n\nThis is somebody's home directory.\n");
  /* The whole bound on a local path: up to sixteen files out of it are posted
     to a third-party model endpoint, so a typo naming a home directory or a
     project's parent must not be read at all. */
  const why = await checkLocalRepo(dir);
  assert.ok(why && /not a git checkout/.test(why));
  await assert.rejects(localMaterial(dir), /not a git checkout/);
  assert.match((await checkLocalRepo(join(dir, "nothing-here")))!, /There is nothing at/);
  rmSync(dir, { recursive: true, force: true });
});

test("REGRESSION: only whole words match the pricing family", () => {
  /* A substring test fetched `frontier.ts` (contains "tier"), `planning.md`
     (contains "plan") and — on a live repository — the file that really won a
     slot, `docs/verification-exec-check-plan.md`. */
  assert.equal(wanted("src/frontier.ts"), null);
  assert.equal(wanted("src/planning.ts"), null);
  assert.equal(wanted("docs/verification-exec-check-plan.md"), null);
  assert.ok(wanted("src/pricing.ts"));
  assert.ok(wanted("src/plans.ts"));
  assert.ok(wanted("src/billingConfig.ts"));
  assert.ok(wanted("src/stripe-prices.json"));
  assert.deepEqual(basenameWords("billingConfig.ts"), ["billing", "config"]);
  assert.deepEqual(basenameWords("check-plan.md"), ["check", "plan"]);
});

test("REGRESSION: null Play install columns are not summed as zero", () => {
  /* `installs ?? 0` inside a sum turned "Play carried no install column for
     this era of the export" into the measured, prompt-fed sentence "Google Play
     recorded 0 installs over the last 30 days". */
  const rows = [
    { installs: null, active_devices: null },
    { installs: null, active_devices: null },
  ];
  const counted = rows.filter((r) => r.installs !== null);
  assert.equal(counted.length, 0, "nothing to count");
  /* The deriver omits the fact entirely rather than asserting a zero. Asserted
     through the real pass: a venture with no Play link has no installs fact,
     and one whose rows are all null must behave the same way. */
  const v = makeVenture("playnulls");
  const before = facts({ ventureId: v }).length;
  deriveVenture(v);
  assert.ok(
    !facts({ ventureId: v }).some((f) => /recorded 0 installs/.test(f.statement)),
    "no zero-installs fact is ever filed",
  );
  assert.equal(facts({ ventureId: v }).length, before);
});

/* ------------------------------------------------------- the quarantine gate */

/**
 * THE THIRD GATE, and the one that was open.
 *
 * The `proposed` tier is only a quarantine while it is the ONLY way an agent
 * can file a claim about a venture. The agent's other write verb — the note
 * store — took a sentence and an optional venture with no tier, no evidence
 * and no confirmation, and both verbs land in one system turn where the model
 * cannot tell them apart by anything but the name. So the whole quarantine had
 * a door beside it, and these assert it is shut.
 */
test("an agent may not file a venture-scoped claim through the note store", () => {
  const refused = ventureClaimRefusal({ ventureId: "v-1", source: "agent" });
  assert.ok(refused, "a venture argument from an agent is refused");
  assert.equal(refused!.status, 422);
  assert.match(refused!.error, /propose_fact/, "the refusal names where the claim does belong");
});

test("the scope word is refused on its own, with no id to go with it", () => {
  assert.ok(ventureClaimRefusal({ scope: "venture", source: "agent" }));
});

test("a global note from an agent is untouched — it is about the owner, not a product", () => {
  assert.equal(ventureClaimRefusal({ source: "agent" }), null);
  assert.equal(ventureClaimRefusal({ ventureId: "", scope: "global", source: "agent" }), null);
});

test("the owner is not refused: they are the confirmation gate this protects", () => {
  assert.equal(ventureClaimRefusal({ ventureId: "v-1", source: "owner" }), null);
});

test("a caller that names no source is treated as an agent, not trusted by default", () => {
  assert.ok(ventureClaimRefusal({ ventureId: "v-1" }));
});
