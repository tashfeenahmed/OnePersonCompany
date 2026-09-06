/**
 * RUNTIME — the two things a model-only installation was missing.
 *
 * GAP 2, TOOL USE WITHOUT A SEPARATE AGENT RUNTIME. Connecting a model key
 * gave a chat that could talk and could not look anything up: the direct
 * provider fallback was text-only by design, and business tools needed Hermes
 * or OpenClaw. `loop.ts` is a bounded tool loop that gives a direct provider
 * the same skills registry the agents get — same honesty rules, same response
 * budget, a hard ceiling on calls, time and dollars, and writes off until the
 * owner turns them on. It plugs into the server-owned run engine
 * (`chat/runs.ts`) as a turn's `open()`, so reattach after a reload, the stop
 * button and the partial row all work exactly as they do for an agent.
 *
 * GAP 8, APPLICATION-LEVEL DELIVERY OF AGENT CRON RESULTS. Both managed
 * runtimes schedule work of their own and both were running that scheduler;
 * nothing on this side could say what they had done, and their results reached
 * nobody's phone because the Telegram token is deliberately not in an agent's
 * home. `jobs.ts` reads each runtime's own store, `relay.ts` pushes what is new
 * through the pairing this app already holds, and neither of them creates,
 * edits or fires a job. Scheduling stays the runtime's.
 *
 * ONE CONFIG-ONLY PSEUDO-PLUGIN AND NO CREDENTIAL. The model is the one the
 * owner already chose under Models; the bot is the one they already paired
 * under Telegram; the quiet hours are the ones they already typed under
 * Customers. What this area owns is the BOUNDS, and every one of them is a
 * setting rather than a constant.
 *
 * NO COLLECTOR. `manifestCollectors()` merges over the built-ins BY PLUGIN ID,
 * and this area's work is a two-minute directory walk rather than a half-hour
 * fetch — a collector entry would put a scheduled-result relay on the same
 * cadence as a Stripe pull, which is a digest rather than a reminder. The
 * timer is in `onStart`.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { upsertPlugin } from "../../db.ts";
import { runtimeRoutes } from "./routes.ts";
import { startRelayTimer } from "./relay.ts";
import { SKILLS, PACKS } from "./skills.ts";
import {
  DEFAULT_JOBS_BODY_CHARS,
  DEFAULT_JOBS_PER_PASS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_TOOL_CATALOG_BYTES,
  DEFAULT_TOOL_SECONDS,
  RUNTIME_PLUGIN,
} from "./store.ts";

const onOffCheck = (value: string) => {
  const t = value.trim().toLowerCase();
  if (!t) return null;
  return ["on", "off", "yes", "no", "true", "false", "1", "0"].includes(t) ? null : "“on” or “off”.";
};

function wholeNumber(lo: number, hi: number) {
  return (value: string) => {
    const raw = value.trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n)) return `“${raw}” is not a whole number.`;
    if (n < lo || n > hi) return `Choose a number between ${lo} and ${hi}.`;
    return null;
  };
}

export const manifest: IntegrationManifest = {
  id: "runtime",

  config: {
    [RUNTIME_PLUGIN]: {
      keys: {
        tools: {
          label: "Tool use for direct model providers",
          hint:
            "“on” or “off”. ON. When no agent (Hermes, OpenClaw) is live, a chat goes " +
            "straight to the model provider you chose under Models — and with this on, that " +
            "model is given your connected integrations as TOOLS, so it can answer “what did " +
            "Stripe collect last week” from the collected data instead of from its own head. " +
            "It only takes effect for a model MEASURED to support function calling: the " +
            "check is one small call, cached for a week, and a model that cannot do it gets " +
            "the text-only chat this app has always had. Turning it off makes every direct " +
            "connection text-only whatever the model can do.",
          ph: "on",
          check: onOffCheck,
        },
        actions: {
          label: "Let a direct model WRITE",
          hint:
            "“on” or “off”. OFF. With it off, a direct model connection can only READ — every " +
            "tool it is given is a GET, and nothing it can call changes your data. With it on " +
            "it may WRITE A ROW: create a card, file a venture, set a goal. It is an " +
            "ALLOW-LIST and not a free pass, and an action has to pass all three of these to " +
            "be on it — (1) the registry does not mark it irreversible, where irreversible now " +
            "means “cannot be undone, OR spends money, OR sends a message, OR reaches a machine " +
            "that is not this one”; (2) its integration does not reach off this box; and (3) " +
            "its name is not a doing verb — send, run, start, deliver, dispatch, submit, " +
            "publish, render, refresh, wake, sleep, shutdown. That third rule is the belt to the other two’s " +
            "braces: an area that adds an action and forgets the flag must not thereby hand a " +
            "model a button that spends. Anything off the list is refused with a sentence " +
            "naming it, so the model can hand the job back to you instead of pretending it " +
            "cannot be done. A connected agent (Hermes, OpenClaw) is unaffected by this " +
            "setting and still reaches everything the registry publishes.",
          ph: "off",
          check: onOffCheck,
        },
        max_tool_calls: {
          label: "Tool calls per turn",
          hint:
            `How many tools one direct-model turn may call before it must answer. Default ` +
            `${DEFAULT_MAX_TOOL_CALLS}. Past the ceiling the tools are taken away and the ` +
            `model is asked to answer with what it has and say what it could not check — it ` +
            `never simply stops. A question that genuinely needs more than a dozen reads of ` +
            `this box's own documents wanted a sub-agent run rather than a chat turn.`,
          ph: String(DEFAULT_MAX_TOOL_CALLS),
          check: wholeNumber(1, 100),
        },
        tool_seconds: {
          label: "Seconds per tool-using turn",
          hint:
            `The whole turn's wall clock, not one call's. Default ${DEFAULT_TOOL_SECONDS}. ` +
            `The per-call timeout belongs to the provider's own policy; this exists because a ` +
            `dozen calls each taking their full timeout is twenty minutes of a page spinning, ` +
            `and the honest answer at three minutes is “here is what I found, I ran out of ` +
            `time”.`,
          ph: String(DEFAULT_TOOL_SECONDS),
          check: wholeNumber(10, 3600),
        },
        tool_catalog_bytes: {
          label: "Tool list budget (bytes)",
          hint:
            `How big the tool list handed to a direct model may be. Default ` +
            `${DEFAULT_TOOL_CATALOG_BYTES} (24 KB) — the same figure as the tool RESPONSE ` +
            `budget, because a tool list bigger than a whole tool answer is out of ` +
            `proportion. Under it, every connected integration is its own tool with its own ` +
            `typed parameters, which is the better shape. Over it — this box has enough ` +
            `integrations that one tool each would be around 60 KB on every round — the model ` +
            `gets three tools instead: one that lists the integrations and explains any one of ` +
            `them, one that reads, and one that writes. Nothing becomes unreachable either ` +
            `way. Raise it for a large-window model; lower it for a local 8k one.`,
          ph: String(DEFAULT_TOOL_CATALOG_BYTES),
          check: wholeNumber(1024, 4 * 1024 * 1024),
        },
        turn_usd: {
          label: "Dollars per tool-using turn",
          hint:
            "A ceiling on what ONE chat turn may spend across all its rounds, read back out " +
            "of the same usage ledger the run queue uses. Blank or 0 means no ceiling of this " +
            "area's own — the global limits under Settings → Usage limits still apply, and " +
            "they already bound this loop because every round of a turn is charged against " +
            "one run id. Set this when you want chat capped separately from background work. " +
            "It only means anything once a model price per million tokens is set under Usage " +
            "limits; without one, every call is costed at zero.",
          ph: "0",
          check(value) {
            const raw = value.trim();
            if (!raw) return null;
            const n = Number(raw);
            if (!Number.isFinite(n)) return `“${raw}” is not an amount.`;
            if (n < 0) return "A budget cannot be negative.";
            if (n > 1000) return "Over $1000 for one chat turn is not a budget.";
            return null;
          },
        },
        relay: {
          label: "Relay scheduled job results to Telegram",
          hint:
            "“on” or “off”. OFF until you turn it on, for the reason the daily briefing is " +
            "off: a message arriving on your phone because a default said so is a surprise. " +
            "Your agent runtime has a scheduler of its own and it is already firing; what " +
            "this does is read each finished run and push it to the Telegram chat you have " +
            "paired, because the bot token deliberately does not live inside the agent. The " +
            "FIRST pass after switching this on sends nothing — everything already on disk is " +
            "marked seen — so an estate that has been running for a week does not empty its " +
            "backlog onto your phone. A run the runtime marked silent is not pushed; a run " +
            "that FAILED is. Needs a Telegram bot connected and a chat paired.",
          ph: "off",
          check: onOffCheck,
        },
        jobs_per_pass: {
          label: "Scheduled results per pass",
          hint:
            `How many results one relay pass sends individually. Default ` +
            `${DEFAULT_JOBS_PER_PASS}, and lower than an event feed's because a cron run's ` +
            `output is a whole answer rather than a line. Past it, one message says how many ` +
            `are waiting and the next pass sends them — nothing is dropped.`,
          ph: String(DEFAULT_JOBS_PER_PASS),
          check: wholeNumber(1, 50),
        },
        jobs_body_chars: {
          label: "Characters of one result in a message",
          hint:
            `Default ${DEFAULT_JOBS_BODY_CHARS}. Telegram splits anything longer than about ` +
            `3500 rather than dropping it, so an uncapped 40 KB answer arrives as a dozen ` +
            `consecutive messages — which is the flood this cap exists to prevent. ` +
            `Shortening is stated in the message, and the whole text stays in the runtime's ` +
            `own store and on the Scheduled jobs panel on your agent's page.`,
          ph: String(DEFAULT_JOBS_BODY_CHARS),
          check: wholeNumber(200, 20_000),
        },
      },
      /* The row is created on demand for routes/pluginConfig.ts's reason:
         `plugin_config` has a foreign key onto `plugins`, so a setting cannot
         be stored until the plugin exists. */
      after() {
        upsertPlugin(RUNTIME_PLUGIN, true, null);
      },
    },
  },

  routes: [{ path: "/api/runtime", app: runtimeRoutes }],

  skills: SKILLS,
  packs: PACKS,

  /** The row before anything can read the settings, and the relay's timer.
   *  Neither may throw — this runs inside the process that serves the
   *  dashboard, and the timer's own pass catches its failures itself. */
  onStart() {
    upsertPlugin(RUNTIME_PLUGIN, true, null);
    startRelayTimer();
  },
};
