/**
 * PUBLISHING — the area that takes what the Studio made and puts it in front
 * of strangers, once somebody has said it may.
 *
 * TWO NEW CREDENTIALED PLUGINS AND ONE BORROWED ONE. `linkedin` and `tiktok`
 * are new; Facebook and Instagram are reached through the EXISTING `meta`
 * plugin, because a second Meta credential in this vault would be a second
 * thing to rotate and a second thing to be out of date. Instagram in
 * particular is not an API of its own — it is a field on a Facebook Page — so
 * a plugin for it would be a plugin with no credential.
 *
 * AND ONE PSEUDO-PLUGIN THAT IS ONLY SETTINGS. `publishing` holds five
 * decisions this code cannot make for anybody: the public base URL that
 * Instagram and TikTok fetch media from, the timezone the calendar is drawn
 * in, how many times a failed post is retried, the windows in which nothing
 * goes out, and whether an Autopilot asset gets a proposed slot. It has no
 * credential, no collector and no accounts — the same shape `backups` takes,
 * and for the same reason: these are decisions, and they belong in the one
 * registry that checks a value before storing it.
 *
 * THERE IS NO COLLECTOR HERE, DELIBERATELY. Nothing in this area measures
 * anything on a schedule. What a destination can do is established by a PROBE
 * the owner presses, because the answer changes when somebody grants a
 * permission rather than every thirty minutes — and probing four networks
 * twice an hour to re-learn an unchanged fact is noise in four companies' logs.
 * The post-level performance readings that WOULD be a collector are gap 23 and
 * belong to whoever builds them, against the Pages this area now knows about.
 *
 * `onStart` ARMS THE SCHEDULER AND NOTHING ELSE. It wakes every minute, and on
 * a box with an empty calendar it does one indexed query and goes back to
 * sleep. It cannot publish anything that is not both approved and scheduled.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { upsertPlugin } from "../../db.ts";
import * as linkedin from "../../providers/linkedin.ts";
import * as tiktok from "../../providers/tiktok.ts";
import { setReferenceResolver } from "../ventures/studio.ts";
import {
  assetAsDataUrl,
  assetAsText,
  assetRow,
  markUsed,
  modelImageInput,
} from "./assets.ts";
import { destinationRows } from "./destinations.ts";
import { publishingRoutes } from "./routes.ts";
import { startScheduler } from "./scheduler.ts";
import { normaliseBase, parseAutoSchedule, parseBlackout, PLUGIN, validZone } from "./settings.ts";
import { PACKS, SKILLS } from "./skills.ts";

/**
 * THE STUDIO'S REFERENCE RESOLVER, INSTALLED HERE.
 *
 * `ventures/studio.ts` exposes a setter rather than importing this area, and
 * its comment says why: the asset library stores its files under the Studio's
 * own directory and therefore imports it, so an import back would be a cycle
 * through a module `integrations/index.ts` loads at import time — which does
 * not start the process at all.
 *
 * The three-valued answer is the product. A model with an image input gets the
 * pictures as `data:` URIs under the field name read off its own schema; a
 * model without one gets nothing, the pictures described in words, and a note
 * that ends up on the post. A reference silently dropped would be the worst of
 * the three, because the post would look like it had been used.
 */
setReferenceResolver(async (ventureId, assetIds, model) => {
  const rows = assetIds
    .map((id) => assetRow(id))
    .filter((r): r is NonNullable<typeof r> => !!r && r.venture_id === ventureId);
  const missing = assetIds.length - rows.length;
  if (!rows.length)
    return {
      dataUrls: [],
      field: null,
      many: false,
      texts: [],
      note: "None of the selected assets belong to this venture, so no reference was used.",
    };

  const support = await modelImageInput(model);
  const texts = rows.map(assetAsText);
  if (!support.supported)
    return {
      dataUrls: [],
      field: null,
      many: false,
      texts,
      note:
        support.note +
        (missing ? ` ${missing} selected asset(s) were not found for this venture.` : ""),
    };

  const dataUrls = rows
    .map((r) => assetAsDataUrl(r.id))
    .filter((u): u is string => u !== null)
    /* One image unless the model's field takes a list — sending four to a
       single-image field is a request the model rejects. */
    .slice(0, support.many ? 4 : 1);
  markUsed(rows.slice(0, dataUrls.length).map((r) => r.id));
  return {
    dataUrls,
    field: dataUrls.length ? support.field : null,
    many: support.many,
    /* The words are NOT also sent when the picture was. Describing an image the
       model can see is how a prompt starts arguing with its own reference. */
    texts: dataUrls.length ? [] : texts,
    note: dataUrls.length
      ? `${dataUrls.length} reference image(s) passed to ${model} as \`${support.field}\`.`
      : "The selected assets could not be read off disk, so they were described in words instead.",
  };
});

/** `connected` for a settings-only plugin means the owner configured
 *  something, and for this one it means there is somewhere to publish TO. A
 *  base URL typed into a box with no destinations is not a connection. */
function refreshConnected() {
  upsertPlugin(PLUGIN, destinationRows().some((d) => d.enabled === 1), null);
}

export const manifest: IntegrationManifest = {
  id: "publishing",

  plugins: {
    /*
      ONE ACCOUNT IS ONE LINKEDIN AUTHOR. The token and the author URN are one
      credential set: a token without an author cannot post anywhere, because
      LinkedIn has no "post as whoever this token is" endpoint. Both are
      secrets — the URN is not sensitive on its own, but keeping it beside the
      token in one account is what makes them impossible to get out of step.
    */
    linkedin: {
      secret: "linkedin",
      fields: ["token", "author"],
      verify: linkedin.verify,
    },

    /*
      ONE ACCOUNT IS ONE TIKTOK CREATOR. The open id is optional and is only a
      label: every call is made as the token, and TikTok's own answer carries a
      nickname rather than an id, so a portfolio with two accounts needs
      something on the page that tells them apart before the first probe.
    */
    tiktok: {
      secret: "tiktok",
      fields: ["token", "openId"],
      optional: ["openId"],
      verify: tiktok.verify,
    },
  },

  config: {
    [PLUGIN]: {
      keys: {
        publicBaseUrl: {
          label: "Public base URL",
          hint:
            "Where this API can be reached FROM THE INTERNET, e.g. https://opc.example.com. " +
            "Instagram and TikTok do not accept uploaded bytes: they take a URL and fetch it " +
            "themselves, minutes later, from their own network. This server binds to loopback, " +
            "so without a tunnel or a reverse proxy those two cannot publish at all and say so. " +
            "TikTok additionally requires this domain to be verified in its developer portal " +
            "under URL properties. Leave it empty and Facebook and LinkedIn still work — they " +
            "take the bytes.",
          ph: "https://opc.example.com",
          check(value) {
            if (!value.trim()) return null;
            return normaliseBase(value)
              ? null
              : "A full http(s) origin, e.g. https://opc.example.com — a bare hostname will not do, because the scheme decides whether Instagram fetches it at all.";
          },
        },
        timezone: {
          label: "Timezone",
          hint:
            "The zone the calendar is drawn in and the one an auto-schedule slot means. An IANA " +
            "name — Europe/Dublin, America/New_York. Empty uses this machine's own zone. Times " +
            "on the wire stay UTC instants either way; this only decides which local day a post " +
            "appears on.",
          ph: "Europe/Dublin",
          check(value) {
            if (!value.trim()) return null;
            return validZone(value.trim())
              ? null
              : `“${value.trim()}” is not a timezone this machine knows. Use an IANA name like Europe/Dublin.`;
          },
        },
        maxAttempts: {
          label: "Attempts before giving up",
          hint:
            "How many times a scheduled post is submitted before it is marked failed and left " +
            "alone. Waits 5, 15, 45 then 135 minutes between tries, capped at six hours. " +
            "Default 3. A post that fails for a missing permission will fail identically every " +
            "time — the retries are for a rate limit or a platform having a bad hour.",
          ph: "3",
          check(value) {
            if (!value.trim()) return null;
            const n = Number(value.trim());
            return Number.isInteger(n) && n >= 1 && n <= 20
              ? null
              : "A whole number of attempts between 1 and 20.";
          },
        },
        blackout: {
          label: "Blackout windows",
          hint:
            "Times when nothing goes out, one per line: “22:00-07:00”, “Sat,Sun 00:00-23:59”, " +
            "“mon-fri 12:00-13:00”. A window that ends before it starts wraps over midnight. A " +
            "post that comes due inside one is NOT skipped and not lost — it goes out on the " +
            "first minute after the window closes.",
          ph: "22:00-07:00\nSat,Sun 09:00-23:59",
          check(value) {
            const { bad } = parseBlackout(value);
            return bad.length
              ? `Could not read: ${bad.slice(0, 2).join("; ")}. A window is “HH:MM-HH:MM”, optionally preceded by days.`
              : null;
          },
        },
        autoSchedule: {
          label: "Auto-schedule Autopilot posts",
          hint:
            "One line per venture, “slug = HH:MM”, or “* = HH:MM” for all of them. When the " +
            "Autopilot finishes a post for that venture, the draft is given a PROPOSED slot at " +
            "the next such local time. It is still a draft: nothing is published until you " +
            "approve it and schedule it. Empty — the default — files Autopilot posts as drafts " +
            "with no date.",
          ph: "* = 09:30\nacme = 08:00",
          check(value) {
            const { bad } = parseAutoSchedule(value);
            return bad.length
              ? `Could not read: ${bad.slice(0, 2).join("; ")}. Each line is “slug = HH:MM”.`
              : null;
          },
        },
      },
      after: refreshConnected,
    },
  },

  skills: SKILLS,
  packs: PACKS,

  routes: [{ path: "/api/publishing", app: publishingRoutes }],

  onStart: () => {
    refreshConnected();
    startScheduler();
  },
};
