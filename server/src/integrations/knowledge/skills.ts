/**
 * THE `knowledge` SKILL — what the product is, handed to an agent with the
 * evidence attached and the rules that make the evidence mean something.
 *
 * IT IS THE ONE SKILL ON THIS BOX WHOSE SUBJECT IS NOT A MEASUREMENT. Every
 * other entry answers "what is the number"; this one answers "what is the
 * thing". That difference is why its rules are longer than most: a figure
 * quoted without its window is wrong by a bit, and a capability asserted from
 * an unconfirmed proposal is wrong to a customer.
 *
 * IT WRITES, AND ONLY INTO ONE TIER. `propose_fact` files a suggestion in the
 * `proposed` tier and there is no parameter that could put it anywhere else.
 * An agent cannot promote its own proposal, cannot correct an owner fact, and
 * cannot retire anything — those three are the owner's, on the page. The gap
 * analysis asked for owner corrections to supersede; an agent that could
 * confirm its own guess would make that promise meaningless in a week.
 */
import type { Skill } from "../../skills/registry.ts";
import { KINDS, MAX_STATEMENT, TIERS } from "./store.ts";

export const SKILLS: Skill[] = [
  {
    id: "knowledge",
    title: "Product knowledge — what each venture actually is, with the evidence",
    /* No credential makes this live or dark. The owner's own statements need
       none, and a venture with a GitHub link and a model gets the repository
       tier on top — but a box with neither still holds whatever the owner
       typed, and going dark would hide that. */
    plugins: [],
    about:
      "Evidence-tiered facts about each venture's PRODUCT — what it does, what " +
      "it costs, what it integrates with, what it cannot do — as opposed to the " +
      "figures every other skill here reports. Each fact carries the tier it " +
      `came from (${TIERS.join(", ")}), the exact source (a file and a line in ` +
      "the product's own repository, a plugin id, or the owner), the commit it " +
      "was read at where there is one, and the date it was observed. Kinds are " +
      `${KINDS.join(", ")}. Views: the facts for a venture with filters, where ` +
      "two tiers disagree, coverage across the portfolio, and the full history " +
      "including corrected and retired sentences.",
    rules: [
      "NEVER STATE A `proposed` FACT AS TRUE. It is a suggestion an agent made " +
        "that the owner has not confirmed. Say 'it has been suggested that…, " +
        "unconfirmed' or do not mention it. It is deliberately excluded from " +
        "every block of context this box hands a model, and repeating one back " +
        "as knowledge is how an invention becomes a record.",
      "CITE THE TIER AND THE DATE with any fact you use. 'Read out of the " +
        "source on 3 September' and 'the owner said so in June' are different " +
        "claims and a reader is entitled to know which one they are being " +
        "given. A fact quoted bare is a fact presented as current and verified.",
      "FOR WHAT THE PRODUCT IS: owner beats repo beats measured. The owner's " +
        "sentence is the only source that is not a reading of something else; " +
        "the repository is what the code does; a Stripe product is a " +
        "configuration and a configuration can describe a plan nobody shipped.",
      "FOR A NUMBER: measured beats everything, always. A price in a constants " +
        "file is what a developer typed once; a live Stripe price is what " +
        "customers are charged. Where a `pricing` or `metric` fact exists at " +
        "the measured tier, quote that one.",
      "A `repo` FACT IS WHAT THE CODE SAID AT THAT COMMIT, and the commit is on " +
        "the fact. A repository that has moved since has not made the fact " +
        "false, it has made it dated — say when it was read rather than " +
        "asserting it is still so.",
      "A `claim` IS WHAT THE PRODUCT SAYS ABOUT ITSELF and is never evidence " +
        "that the thing is true. A README tagline and a working feature are " +
        "different kinds of object; do not turn one into the other by " +
        "paraphrasing it as a capability.",
      "ABSENCE IS NOT A LIMITATION. No fact about a capability means nobody has " +
        "recorded one, not that the product lacks it. Only a `limitation` fact " +
        "says a product cannot do something, and 'I have no fact about X' is " +
        "the honest answer to everything else.",
      "WHEN TWO TIERS DISAGREE, SAY SO. The `contradictions` view names the " +
        "pairs. Do not silently pick one and do not average two figures; give " +
        "the precedence rule above and the two sentences, and let the owner " +
        "settle it.",
      "PROPOSE SPARINGLY AND NEVER ABOUT AUDIENCE. Every proposal costs the " +
        "owner a decision. A route called /teachers is not evidence that " +
        "teachers use the product, and audience, pain and willingness to pay " +
        "cannot be read out of a codebase at all — those need a measurement or " +
        "the owner. `request_refresh` re-reads the repository and is the right " +
        "move when the facts look old; proposing what you think the code " +
        "probably does is not.",
    ],
    views: [
      {
        key: "facts",
        path: "/api/knowledge",
        about:
          "The active facts, newest and highest-tier first. Without `venture` " +
          "it is the whole portfolio, which is rarely the question. Also " +
          "returns the repository this venture's facts are read from and when " +
          "it was last read.",
        params: [
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture's slug, id, name or host. Absent means every venture.",
            exampled: true,
          },
          {
            name: "kind",
            type: "string",
            required: false,
            about: `One of ${KINDS.join(", ")}. Absent means all seven.`,
          },
          {
            name: "tier",
            type: "string",
            required: false,
            about: `One of ${TIERS.join(", ")}. Absent means all four, ordered by precedence.`,
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 200,
            about: "Facts returned. Clamped to 1–500.",
          },
        ],
      },
      {
        key: "contradictions",
        path: "/api/knowledge/contradictions",
        about:
          "Where two tiers disagree about one venture: the owner's corrections " +
          "(resolved) and pairs of live facts carrying different figures about " +
          "the same subject (unresolved). A pointer at a pair, never a verdict.",
        params: [
          {
            name: "venture",
            type: "string",
            required: true,
            about: "A venture's slug or id.",
            exampled: true,
          },
        ],
      },
      {
        key: "coverage",
        path: "/api/knowledge/coverage",
        about:
          "Every venture: how many facts, split by tier and kind, which kinds it " +
          "has NONE of, whether a repository is mapped, when it was last read, " +
          "and how many proposals are waiting for the owner.",
        params: [],
      },
      {
        key: "history",
        path: "/api/knowledge/history",
        about:
          "One venture's whole record including corrected and retired facts, so " +
          "'what did we used to believe about this' has an answer. Nothing here " +
          "is deleted.",
        params: [
          {
            name: "venture",
            type: "string",
            required: true,
            about: "A venture's slug or id.",
            exampled: true,
          },
        ],
      },
    ],
    actions: [
      {
        key: "propose_fact",
        method: "POST",
        path: "/api/knowledge/proposals",
        about:
          "Suggest a fact about a product. It lands in the `proposed` tier and " +
          "nowhere else: it is not given to any other agent as context, it is " +
          "not exported to Studio or a research brief, and it is not true until " +
          "the owner confirms it on the Knowledge tab.",
        params: [
          {
            name: "venture",
            type: "string",
            required: true,
            about: "A venture's slug or id.",
            exampled: true,
          },
          {
            name: "kind",
            type: "string",
            required: true,
            about: `One of ${KINDS.join(", ")}. Not audience — that cannot be proposed here.`,
            exampled: true,
          },
          {
            name: "statement",
            type: "string",
            required: true,
            about: `One plain sentence, at most ${MAX_STATEMENT} characters.`,
            exampled: true,
          },
          {
            name: "basis",
            type: "string",
            required: true,
            about:
              "One sentence saying what you read that made you propose this. " +
              "Required: a proposal the owner cannot judge will sit unconfirmed for ever.",
            exampled: true,
          },
        ],
      },
      {
        key: "request_refresh",
        method: "POST",
        path: "/api/knowledge/refresh",
        about:
          "Re-read the venture's repository and re-file its `repo` facts. Costs " +
          "a handful of GitHub reads and one completion, and does nothing when " +
          "the repository's HEAD has not moved and nothing has expired. Every " +
          "fact it files cites a file and a line that was checked to exist.",
        params: [
          {
            name: "venture",
            type: "string",
            required: true,
            about: "A venture's slug or id.",
            exampled: true,
          },
        ],
      },
    ],
    asks: [
      "What does this product actually do, and how do we know?",
      "Do the repository and Stripe disagree about what this venture sells?",
    ],
  },
];

/* `product-knowledge` rather than `knowledge`: a pack name has to survive
   beside whatever a managed agent already ships, and a bare noun is the most
   likely of all names to collide. It also says what it is — this is not the
   agent's memory, which is a different pack with a different meaning. */
export const PACKS: Record<string, { name: string; category: string }> = {
  knowledge: { name: "product-knowledge", category: "research" },
};
