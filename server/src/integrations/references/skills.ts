/**
 * The references area's one skill entry.
 *
 * Types only from skills/registry.ts: a value-level import would cycle.
 *
 * `update_guide` IS MARKED `destructive` AND THE REASON IS THE FIRST OF THE
 * FOUR IN THAT FILE'S HEADER — the record, and it cannot be undone from here.
 * There is one row per venture, no history, and no undo route: an agent that
 * rewrites the tone of voice has destroyed the paragraph the owner typed, and
 * the fact that the same route could write it back does not help anybody who
 * no longer has the words. The merge semantics soften this and do not remove
 * it: a field that is sent IS overwritten, whole.
 *
 * `openWorld` IS FALSE, and this is one of the few entries where that is
 * unambiguous. Every call is a loopback read or write of a table on this
 * machine. The guide TRAVELS to a model later, inside the Studio's prompt, but
 * that is the Studio spending the Studio's tokens on the Studio's route; a
 * skill that wrote a row is not the thing that made the call.
 *
 * NO PLUGIN GATE. The guide is what the owner typed and the ventures are his
 * own list; neither needs a credential, and a guide that went dark because
 * Replicate was disconnected would be a guide nobody could fix while the
 * generators were broken. The asset list rides along and is the publishing
 * area's; the pictures themselves are files on this box.
 */
import type { Skill } from "../../skills/registry.ts";
import { GUIDE_LIMITS } from "./guide.ts";

export const SKILLS: Skill[] = [
  {
    id: "references",
    title: "References — the style guide and the reference pictures per business",
    plugins: [],
    about:
      "What the generators on this box draw on before they write or draw " +
      "anything for one business. Three things in one document: the STYLE " +
      "GUIDE the owner typed (a summary, a tone of voice, an audience, dos, " +
      "don'ts, a language, colour and font notes), the BRAND as MEASURED off " +
      "the site by the venture enricher (a palette and font stacks, plus what " +
      "could not be measured), and the ASSET LIBRARY (logos, reference photos, " +
      "screenshots) with each picture's own instruction. With no `venture` it " +
      "is one row per venture: asset counts by kind, and whether a guide has " +
      "been written at all.",
    rules: [
      "THE GUIDE IS OPINION AND THE BRAND IS A MEASUREMENT. `guide.colours` is " +
        "a sentence the owner typed; `brand.palette` is what a browser saw on " +
        "the site. They are never merged, they are allowed to disagree, and " +
        "when they do the interesting question is which one is out of date — " +
        "so say which of the two you are quoting, every time.",
      "`guide.written: false` MEANS NOTHING HAS BEEN WRITTEN, and every field " +
        "will be null. It is not a guide that says the business has no tone. " +
        "Do not describe an unwritten guide as empty-by-choice, and do not " +
        "invent one to fill the gap.",
      "A NULL FIELD IS UNWRITTEN. It is never an instruction to do nothing: a " +
        "null `donts` does not mean there is nothing to avoid, it means nobody " +
        "has typed the list.",
      "`brand.enrichedAt: null` MEANS THE SITE HAS NEVER BEEN READ, so an " +
        "empty palette there is “not measured” and never “this site has no " +
        "colours”. `brand.notes` says, one sentence each, what could not be " +
        "measured and why; quote it rather than reporting an absence.",
      "AN ASSET WITH `onDisk: false` IS A ROW WHOSE FILE HAS GONE. It still " +
        "counts in the library and it cannot be handed to an image model. Say " +
        "so rather than listing it as available.",
      "THE GUIDE IS ALREADY IN THE PROMPTS. It is appended to the Studio's " +
        "caption prompt, the faceless script prompt and the reel dialogue " +
        "prompt whenever one exists, labelled as the owner's own instruction. " +
        "Reading it here is for advising him about it — pasting it into a " +
        "brief as well only says the same thing twice.",
      "UPDATING MERGES: a field you do not send is left exactly as it was, and " +
        "a field you DO send is overwritten whole. There is no history and no " +
        "undo. Never rewrite a field the owner did not ask you to touch, and " +
        "quote back what you replaced.",
      "NOTHING HERE UPLOADS A PICTURE. Assets are added on the publishing " +
        "area's own route, from a file the owner chose or a URL this box " +
        "fetches; this skill reads the library and cannot add to it.",
    ],
    views: [
      {
        key: "references",
        path: "/api/references",
        about:
          "One venture's whole reference document: the style guide, the measured brand, and every asset with its kind, its instruction and whether its file is still on disk. With no `venture`, one row per venture with asset counts by kind and whether a guide exists.",
        params: [
          {
            name: "venture",
            type: "string",
            required: false,
            about:
              "A venture's id or slug. Absent gives the overview — every venture, its counts and whether it has a guide — and no guide text.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "update_guide",
        method: "PATCH",
        path: "/api/references/:venture/guide",
        about:
          "Write one or more style-guide fields for one venture. MERGES: a field that is not sent is left alone; a field that IS sent replaces what was there, with no history and no undo. Send an empty string to clear a field deliberately.",
        params: [
          { name: "venture", type: "string", required: true, in: "path", about: "The venture's id or slug." },
          {
            name: "summary",
            type: "string",
            required: false,
            about: `What the business is, in the owner's own words. At most ${GUIDE_LIMITS.summary} characters.`,
          },
          {
            name: "tone",
            type: "string",
            required: false,
            about: `The tone of voice — how it talks, and how it does not. At most ${GUIDE_LIMITS.tone} characters.`,
          },
          {
            name: "audience",
            type: "string",
            required: false,
            about: `Who it is written for. At most ${GUIDE_LIMITS.audience} characters.`,
          },
          {
            name: "dos",
            type: "string",
            required: false,
            about: `What to do — one rule per line reads best. At most ${GUIDE_LIMITS.dos} characters.`,
          },
          {
            name: "donts",
            type: "string",
            required: false,
            about: `What never to do. At most ${GUIDE_LIMITS.donts} characters.`,
          },
          {
            name: "colours",
            type: "string",
            required: false,
            about: `A sentence about colour that the measured palette gets wrong. Prose, not hexes — the hexes are on the venture record. At most ${GUIDE_LIMITS.colours} characters.`,
          },
          {
            name: "fonts",
            type: "string",
            required: false,
            about: `A sentence about type. At most ${GUIDE_LIMITS.fonts} characters.`,
          },
          {
            name: "language",
            type: "string",
            required: false,
            about: `Which language the posts are written in, and for whom. At most ${GUIDE_LIMITS.language} characters.`,
          },
          {
            name: "notes",
            type: "string",
            required: false,
            about: `Anything else the owner wants the generators to know. NOT put in any prompt — it is a note to a person. At most ${GUIDE_LIMITS.notes} characters.`,
          },
        ],
        destructive: true,
      },
    ],
    asks: [
      "What does the Studio actually know about this business before it writes a caption?",
      "Which of my ventures has no style guide and no logo on file?",
    ],
    openWorld: false,
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  references: { name: "brand-references", category: "marketing" },
};
