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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, now } from "../../db.ts";
import {
  TREE_PATH,
  type Excerpt,
  applyBudget,
  directFacts,
  gate,
  localMaterial,
  materialNumbers,
  numbersGrounded,
  tryParse,
  verifyCitation,
  wanted,
} from "./extract.ts";
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

test("a local checkout is read into citable excerpts, and the gate agrees with them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opc-knowledge-repo-"));
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
