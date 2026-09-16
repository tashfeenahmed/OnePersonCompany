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
import { createItem, proposeSlot } from "./items.ts";
import { destinationRows } from "./destinations.ts";
import { settings } from "./settings.ts";
import { nextZonedTime } from "../../../../shared/zonedTime.ts";

export type HookResult = {
  itemId: string | null;
  scheduledFor: string | null;
  note: string;
};

/**
 * The next occurrence of a local `HH:MM`, never today's if it has passed.
 *
 * WALKED FORWARD A MINUTE AT A TIME rather than computed, which is
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
  return nextZonedTime(tz, hour, minute, from);
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
  source: { kind: "studio_post" | "video_job" | "video_clip"; id: string };
}): HookResult {
  try {
    // A retry must preserve a draft someone edited, reassigned or cancelled.
    const existing = db.prepare("SELECT id, scheduled_for FROM publish_items WHERE venture_id = ? AND source_kind = ? AND source_id = ? ORDER BY created_at, id LIMIT 1")
      .get(input.ventureId, input.source.kind, input.source.id) as { id: string; scheduled_for: string | null } | undefined;
    if (existing) return { itemId: existing.id, scheduledFor: existing.scheduled_for, note: "Already filed in Publishing; the existing item was kept." };
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

    /* A PROPOSED date on a draft, through items.ts rather than by an UPDATE
       from here — see `proposeSlot`, which refuses anything past `draft` so
       this can never move a slot a person actually chose. */
    const at = nextSlot(s.timezone, slot.hour, slot.minute);
    proposeSlot(created.item.id, at);
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
