/**
 * THE FOUR CARDS THAT SHOULD NOT HAVE BEEN FILED, as tests.
 *
 * Every case here is one the pass actually produced on 6 September, and every
 * one of them passed a gate that was reading titles and nothing else:
 *
 *   - three cards for one venture, all three resting on the SAME revenue line.
 *     The titles share about one word, so the similarity rule saw three
 *     different actions and the owner saw one fact three times;
 *   - a card asking him to review a noindex tag, quoting a line that says the
 *     noindex is defensible — his own analyst's caveat, filed back at him with
 *     a checkbox on it;
 *   - "Analyze subscription data for growth opportunities", which is not an
 *     instruction: nothing after the verb appears in the evidence it cites.
 *
 * And the fourth is upstream of all of them: a run's report cut at 400
 * characters mid-word, so the model read "…returned" without the 404 and
 * invented a server error. The gate cannot be better than the evidence it is
 * given, which is why `headline` is tested here beside it.
 *
 * All of it is pure: no database, no clock, no provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { HEADLINE_CHARS, HEADLINE_LINES, headline } from "./evidence.ts";
import { evidenceKey, gate, type Proposal, type ProposalVerdict } from "./synthesis.ts";

/* Same fixture shape as pipeline.test.ts, with the evidence line always named:
   in here it is the thing under test. */
const proposal = (title: string, evidence: string, evidenceLine: string, why = "because"): Proposal => ({
  title,
  why,
  evidence,
  evidenceLine,
});

/* THE JUDGE SAID "file" TO EVERYTHING, unless a test says otherwise.
   Since 2026-09-21 three of the refusals are a model's verdict rather than a
   word list, and `gate()` takes that verdict as an argument so it stays pure.
   Every test below is about a DETERMINISTIC rule — the caps, the measured
   evidence, one-finding-one-card — so the judge is stubbed permissive and those
   rules are tested in isolation, which is what they were always testing. The
   tests for the judged refusals pass their own map. */
const allFiled = (proposals: Proposal[]) =>
  new Map(proposals.map((_, i) => [String(i), { verdict: "file" as ProposalVerdict, why: "a real action" }]));

const gateInput = (over: Partial<Parameters<typeof gate>[0]> = {}) => {
  const proposals = over.proposals ?? [];
  return {
    proposals,
    measured: ["revenue", "traffic", "tasks", "runs"],
    openCardTitles: [],
    openEvidenceKeys: [],
    recentProposalTitles: [],
    judgements: allFiled(proposals),
    perVenture: 3,
    remainingTonight: 6,
    now: Date.parse("2026-09-06T00:00:00.000Z"),
    ...over,
  };
};

const reasonOf = (v: unknown) => (v as { reason: string }).reason;

/* ------------------------------------------------- one finding, one card */

/** The line all three of the 6 September cards rested on, verbatim. */
const MRR_LINE =
  "MRR now $589.83 across 372 active subscription(s); $248.58 thirty days ago; change $341.25";

test("three actions off one evidence line become one card", () => {
  const verdicts = gate(
    gateInput({
      proposals: [
        proposal("Analyze subscription data for growth opportunities", "revenue", MRR_LINE),
        proposal("Update revenue collector to track subscription price changes", "revenue", MRR_LINE),
        proposal("Create alert rules for MRR milestones and anomalies", "revenue", MRR_LINE),
      ],
    }),
  );
  assert.deepEqual(verdicts.map((v) => v.accept), [true, false, false]);
  assert.match(reasonOf(verdicts[1]), /evidence already carries/);
  assert.match(reasonOf(verdicts[2]), /evidence already carries/);
  /* The refusal names the action that spent the finding, so the owner can see
     the card he DID get rather than only the two he did not. */
  assert.match(reasonOf(verdicts[1]), /Analyze subscription data/);
});

test("a finding an open card already rests on buys nothing tonight", () => {
  const [v] = gate(
    gateInput({
      proposals: [proposal("Create alert rules for MRR milestones", "revenue", MRR_LINE)],
      openEvidenceKeys: [evidenceKey({ evidence: "revenue", evidenceLine: MRR_LINE })],
    }),
  );
  assert.equal(v!.accept, false);
  assert.match(reasonOf(v), /evidence already carries an open card/);
});

test("two different findings in one section are two actions, not one", () => {
  const verdicts = gate(
    gateInput({
      proposals: [
        proposal("Raise the price of the Pro plan", "revenue", MRR_LINE),
        proposal("Win back the two customers who cancelled in August", "revenue", "Products: Pro, Team. 2 subscriptions ended in the window."),
      ],
    }),
  );
  assert.deepEqual(verdicts.map((v) => v.accept), [true, true]);
});

test("the same fact quoted with different rounding is the same finding", () => {
  assert.equal(
    evidenceKey({ evidence: "revenue", evidenceLine: "MRR now $589.83; $248.58 thirty days ago" }),
    evidenceKey({ evidence: "revenue", evidenceLine: "MRR now $590; $249 thirty days ago." }),
  );
  /* …and two sections are never one finding, however alike the sentences. */
  assert.notEqual(
    evidenceKey({ evidence: "revenue", evidenceLine: "pageviews fell 40%" }),
    evidenceKey({ evidence: "traffic", evidenceLine: "pageviews fell 40%" }),
  );
});

/* ------------------------------------------- what the judge decides, applied */

/* THE VERDICTS THEMSELVES ARE A MODEL'S and are not asserted here. A test
   pinning "Analyze subscription data" to `shrug` would be testing the model and
   would pass against a stub while the live gate did something else. What is
   tested is that `gate()` APPLIES each verdict, says which one it applied, and
   refuses when nothing judged — the part that is this file's job. */

const judged = (...verdicts: (ProposalVerdict | "unjudged")[]) =>
  new Map(verdicts.map((verdict, i) => [String(i), { verdict, why: "the judge's reason" }]));

test("a shrug is refused and the reason asks for the thing to change", () => {
  const [v] = gate(
    gateInput({
      proposals: [proposal("Analyze subscription data for growth opportunities", "revenue", MRR_LINE)],
      judgements: judged("shrug"),
    }),
  );
  assert.equal(v!.accept, false);
  assert.match(reasonOf(v), /names nothing to change/);
  assert.match(reasonOf(v), /the judge's reason/);
});

test("a dismissed proposal is refused and the reason quotes the line that dismissed it", () => {
  const [v] = gate(
    gateInput({
      proposals: [
        proposal(
          "Review the noindex tag on the /manage page",
          "runs",
          "on a logged-in surface the noindex is defensible, but it should be deliberate",
        ),
      ],
      judgements: judged("dismissed"),
    }),
  );
  assert.equal(v!.accept, false);
  assert.match(reasonOf(v), /evidence dismisses itself/);
  assert.match(reasonOf(v), /noindex is defensible/);
});

test("a duplicate is refused as one", () => {
  const [v] = gate(
    gateInput({
      proposals: [proposal("Reply to the outstanding reviews", "tasks", "12 reviews are unanswered")],
      judgements: judged("duplicate"),
    }),
  );
  assert.equal(v!.accept, false);
  assert.match(reasonOf(v), /already proposed or on the board/);
});

test("nothing is filed unjudged, and the refusal says the pass runs again tomorrow", () => {
  /* The lean here is the opposite of the run-card gate's, on purpose: a nightly
     that proposes nothing costs nothing, while a night's worth of unjudged
     proposals is exactly the board noise this gate exists to prevent. */
  const [absent] = gate(
    gateInput({
      proposals: [proposal("Rewrite the pricing page", "revenue", MRR_LINE)],
      judgements: new Map(),
    }),
  );
  assert.equal(absent!.accept, false);
  assert.match(reasonOf(absent), /not judged/);
  assert.match(reasonOf(absent), /again tomorrow/);

  const [explicit] = gate(
    gateInput({
      proposals: [proposal("Rewrite the pricing page", "revenue", MRR_LINE)],
      judgements: judged("unjudged"),
    }),
  );
  assert.equal(explicit!.accept, false);
  assert.match(reasonOf(explicit), /not judged/);
});

test("a verdict of file still has to pass every deterministic rule after it", () => {
  /* The judge is not a bypass: it answers three of the refusals, and the caps,
     the measured-evidence rule and one-finding-one-card still fire. */
  const [unmeasured] = gate(
    gateInput({
      proposals: [proposal("Rewrite the pricing page", "memory", "a note about pricing")],
      judgements: judged("file"),
    }),
  );
  assert.equal(unmeasured!.accept, false);
  assert.match(reasonOf(unmeasured), /not measured for this venture/);

  const capped = gate(
    gateInput({
      proposals: [
        proposal("Rewrite the pricing page", "revenue", MRR_LINE),
        proposal("Add a plan comparison", "traffic", "pageviews fell 40%"),
        proposal("Fix the broken links", "runs", "nine pages 404"),
        proposal("Publish the FAQ", "tasks", "12 reviews are unanswered"),
      ],
      judgements: judged("file", "file", "file", "file"),
      perVenture: 2,
    }),
  );
  assert.deepEqual(capped.map((v) => v.accept), [true, true, false, false]);
  assert.match(reasonOf(capped[2]), /cap of 2/);
});

/* ------------------------------------------------- the evidence it is given */

const FINDING = "- [error] page-error — one URL (`/'%20+%20href%20+%20'`) returned 404, not a server error.";

test("a finding line is never cut in the middle of itself", () => {
  const report = ["#".repeat(380), FINDING].join("\n");
  const out = headline(report);
  assert.ok(out.includes(FINDING), "the whole finding survives the cut that used to land inside it");
  assert.ok(!out.includes("retu\n") && !out.endsWith("retu"));
});

test("a long report keeps whole lines, up to six, and says that it stopped", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `- finding ${i + 1}: something happened here`);
  const out = headline(lines.join("\n"));
  const kept = out.replace(/ …$/, "").split("\n");
  assert.equal(kept.length, HEADLINE_LINES);
  assert.deepEqual(kept, lines.slice(0, HEADLINE_LINES));
  assert.match(out, / …$/);
});

test("the character budget stops between lines, never inside one", () => {
  const line = "- finding: " + "x".repeat(300);
  const out = headline(Array.from({ length: 6 }, () => line).join("\n"));
  const kept = out.replace(/ …$/, "").split("\n");
  assert.ok(out.length <= HEADLINE_CHARS + 2, `headline was ${out.length} characters`);
  for (const l of kept) assert.equal(l, line, "a kept line is the whole line");
  assert.match(out, / …$/);
});

test("a report that is one paragraph is cut at a space, never mid-word", () => {
  const out = headline("alpha beta gamma delta ".repeat(200).trim());
  assert.match(out, / …$/);
  assert.ok(out.length <= HEADLINE_CHARS + 2);
  for (const word of out.replace(/ …$/, "").split(" "))
    assert.ok(["alpha", "beta", "gamma", "delta"].includes(word), `"${word}" was cut in half`);
});

test("an empty report is an empty headline rather than an ellipsis", () => {
  assert.equal(headline(""), "");
  assert.equal(headline("\n\n  \n"), "");
});
