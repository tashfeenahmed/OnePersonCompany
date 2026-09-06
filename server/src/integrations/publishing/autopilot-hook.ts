/**
 * WHAT HAPPENS TO SOMETHING THE AUTOPILOT MADE.
 *
 * The Autopilot generates on a schedule and its own header says, at length,
 * that it never publishes anything. That is still true and this file does not
 * change it: what it does is put a finished asset into the publishing queue AS
 * A DRAFT, so the owner finds it beside everything else waiting for a decision
 * rather than having to go and look in the Studio gallery.
 *
 * A DRAFT IS THE DEFAULT AND IT IS NOT NEGOTIABLE. The only thing the
 * `autoSchedule` setting can do is put a DATE on it, and a scheduled item that
 * was never approved is not published by the scheduler — `schedule()` refuses
 * an unapproved item and the scheduler only reads scheduled ones. So the most
 * an owner can configure here is "and put it in Tuesday's nine o'clock slot,
 * for when I approve it".
 *
 * A HOOK RATHER THAN A CALL BACK INTO THE AUTOPILOT. `video/autopilot.ts`
 * imports this one function and nothing else about publishing; this file
 * imports nothing from the video area at all. That is what keeps the two areas
 * separable — the Autopilot works with this file absent, and everything here
 * works with the Autopilot switched off.
 */
import { db } from "../../db.ts";
import { createItem } from "./items.ts";
import { destinationRows } from "./destinations.ts";
import { settings, wall } from "./settings.ts";

export type HookResult = {
  itemId: string | null;
  scheduledFor: string | null;
  note: string;
};

/**
 * The next occurrence of a local `HH:MM`, never today's if it has passed.
 *
 * WALKED FORWARD AN HOUR AT A TIME rather than computed, which is
 * video/autopilot.ts's argument and it applies here for the same reason:
 * turning "09:30 next Tuesday in Europe/Dublin" into a UTC instant by
 * arithmetic means handling the two nights a year when a local hour happens
 * twice or not at all, and getting it wrong is a post that goes out an hour
 * early in March. Asking Intl what the local hour is at each step cannot be
 * wrong about a transition it does not have to model.
 */
export function nextSlot(
  tz: string,
  hour: number,
  minute: number,
  from: Date = new Date(),
): string {
  for (let i = 0; i <= 48; i++) {
    const at = new Date(from.getTime() + i * 3_600_000);
    const w = wall(tz, at);
    if (w.hour !== hour) continue;
    /* Snap to the top of that local hour and add the minutes, then check it is
       still in the future — the hour that is happening right now may already
       be past its minute. */
    const top = new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000 + minute * 60_000);
    if (top.getTime() > from.getTime()) return top.toISOString();
  }
  /* No matching local hour in the next two days is not possible for a valid
     zone, but a fallback that is obviously "tomorrow-ish" beats a throw inside
     a background pass. */
  return new Date(from.getTime() + 86_400_000).toISOString();
}

/**
 * One finished Autopilot asset, filed.
 *
 * Called with what the Autopilot made. Never throws: a queue this could not
 * write to must not be the reason a generation pass fails, and the Studio post
 * exists either way.
 */
export function onAutopilotAsset(input: {
  ventureId: string;
  ventureSlug: string;
  source: { kind: "studio_post" | "video_job"; id: string };
}): HookResult {
  try {
    const dests = destinationRows(input.ventureId).filter((d) => d.enabled === 1);
    /* ONE DESTINATION IS UNAMBIGUOUS AND TWO IS NOT. With exactly one enabled
       destination, the draft is addressed; with more, it is a draft with no
       destination and the owner picks — guessing which of three accounts a
       post is for is exactly the kind of helpfulness that publishes to the
       wrong audience. */
    const destinationId = dests.length === 1 ? dests[0]!.id : null;
    const created = createItem({
      ventureId: input.ventureId,
      source: input.source,
      destinationId,
    });
    if (!created.ok) return { itemId: null, scheduledFor: null, note: created.error };

    const s = settings();
    const slot =
      s.autoSchedule.find((a) => a.slug === input.ventureSlug.toLowerCase()) ??
      s.autoSchedule.find((a) => a.slug === "*");
    if (!slot)
      return {
        itemId: created.item.id,
        scheduledFor: null,
        note: "Queued as a draft. No auto-schedule slot is set for this venture.",
      };

    /* The date is written directly rather than through `schedule()`, because
       that function correctly refuses an unapproved item. What is stored is a
       PROPOSED date on a draft: the status stays `draft`, so nothing can
       publish it, and the calendar can already draw where it would go. */
    const at = nextSlot(s.timezone, slot.hour, slot.minute);
    db.prepare("UPDATE publish_items SET scheduled_for = ? WHERE id = ?").run(at, created.item.id);
    return {
      itemId: created.item.id,
      scheduledFor: at,
      note:
        `Queued as a draft with a proposed slot at ${at}. It is still a DRAFT — approve it and ` +
        "schedule it, or the scheduler will never look at it.",
    };
  } catch (err) {
    return {
      itemId: null,
      scheduledFor: null,
      note: `The publishing queue refused it: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
