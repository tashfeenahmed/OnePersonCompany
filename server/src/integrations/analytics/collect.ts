/**
 * The analytics area's four collectors.
 *
 * THE RULES THEY ALL KEEP, which are collector.ts's rules and not new ones:
 *
 *   A RUN ROW OPENS BEFORE THE NETWORK CALL and closes after it, successful or
 *   not, so "when did this last work" is answerable even when the answer is
 *   "it has not, since Tuesday".
 *
 *   FAILURE IS PER UNIT, NEVER PER RUN. One dead Umami instance, one package
 *   pypistats has never heard of, one renamed Bluesky handle: each is that
 *   unit's own error on its own row, and the run succeeds if any unit
 *   answered. A collector that fails whole because one of nine names 404s
 *   turns a typo into an empty dashboard.
 *
 *   ONE LOUD FAILURE RATHER THAN A SILENT ZERO. Nothing here writes a zero it
 *   was not told. A figure that could not be read stays absent and the row
 *   carries the reason.
 *
 * THREE OF THEM ARE ON A SLOW CLOCK. The scheduler in index.ts runs every
 * connected plugin every thirty minutes and has no opinion about cost; a
 * collector that reads day-grained figures checks its own clock and returns
 * early with `note: "fresh"`. The clock is per unit — per account, per handle,
 * per package — so a thing connected at nine o'clock collects immediately
 * while its neighbours wait, which is the same courtesy collectGithub extends
 * to a newly added account: the point of connecting something is to see it.
 */
import {
  configValue,
  finishRun,
  getPlugin,
  record,
  startRun,
  syncPlugin,
  upsertPlugin,
} from "../../db.ts";
import * as accounts from "../../accounts.ts";
import type { CollectResult } from "../manifest.ts";
import * as umami from "./umami.ts";
import * as calendar from "./calendar.ts";
import * as pypi from "./pypi.ts";
import * as bluesky from "./bluesky.ts";
import {
  due,
  forgetBlueskyHandles,
  forgetPypiPackages,
  markClock,
  pruneCalendarEvents,
  pruneClocks,
  replaceCalendarEvents,
  replaceCalendars,
  replaceUmamiTop,
  replaceUmamiWebsites,
  writeBlueskyPosts,
  writeBlueskyProfile,
  writeBlueskyWindow,
  writePypiDays,
  writePypiPackage,
  writeUmamiDays,
  writeUmamiWindow,
} from "./store.ts";

/** See migration 030 and collector.ts's TRAFFIC_EVERY_HOURS for the argument. */
export const UMAMI_EVERY_HOURS = 6;
export const CALENDAR_EVERY_HOURS = 2;
export const BLUESKY_EVERY_HOURS = 6;
/** pypistats rebuilds its dataset once a day, so the 180-day line and the
 *  package metadata are read four times a day rather than forty-eight. The
 *  `recent` counters are one cheap request and are read every tick, which is
 *  what keeps "downloads yesterday" current on a page somebody just opened. */
export const PYPI_HISTORY_EVERY_HOURS = 6;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A courtesy gap between requests to a public service nobody is paying for. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long to wait between two requests to the same public host.
 *
 * 300 ms is the polite default this codebase uses elsewhere and BLUESKY IS
 * FINE WITH IT. pypistats is not: probed on 2026-09-05 with two packages, four
 * requests spaced 300 ms apart, and the second package's `recent` came back
 * 429 — its limiter is tighter than a third of a second. So PyPI's gap is a
 * second and a bit, which costs a minute of wall clock on a list of forty and
 * buys a collection that finishes rather than one that reports half a list as
 * rate-limited. A 429 is still reported as itself if it happens anyway; it is
 * never a zero.
 */
const BLUESKY_GAP_MS = 300;
const PYPI_GAP_MS = 1_200;

/* ------------------------------------------------------------------ umami */

/**
 * Umami, collected — once per instance, then once per website inside it.
 *
 * THE THREE WRITES ARE DELIBERATELY DIFFERENT SHAPES, for collectGithub's
 * reasons. The websites are a REPLACEMENT scoped to one account: a site
 * deleted in Umami leaves the table on the next run, and an account that
 * failed keeps the rows it wrote last time rather than being emptied by a bad
 * minute. The days are an ACCUMULATION keyed by their own day, so a run that
 * dies half way leaves fewer days rather than a wrong picture — and so that
 * this database quietly ends up holding more history than a 90-day read would
 * ever show. The rankings are a replacement per website: a ranking merged
 * across two runs is a ranking of two different days.
 *
 * A WEBSITE THAT FAILS DOES NOT COST ITS NEIGHBOURS THEIR FIGURES. Umami
 * answers per site, and a site whose stats refuse is one warning and one
 * missing card rather than an instance that reads as down.
 */
export async function collectUmami(): Promise<CollectResult & { websites: number }> {
  const runId = startRun("umami");
  const ready = accounts.credentialed(
    "umami",
    ["url"],
    "collect_umami",
  ).ready;

  if (!ready.length) {
    const error = "No Umami instance is connected.";
    finishRun(runId, false, undefined, error);
    return { ok: false, error, websites: 0 };
  }

  /* A clock belongs to an account, so an account that is gone takes its
     clock with it — the rows it collected went with the foreign key's
     cascade. */
  pruneClocks("umami", ready.map((r) => String(r.account.id)));

  const warnings: string[] = [];
  let sites = 0;
  let answered = 0;
  let skipped = 0;

  for (const { account, values } of ready) {
    if (!due("umami", String(account.id), UMAMI_EVERY_HOURS)) {
      skipped++;
      continue;
    }
    try {
      const session = await umami.open(values as umami.Credentials);
      const list = await umami.websites(session);
      replaceUmamiWebsites(account.id, list);
      sites += list.length;

      const w = umami.windows(umami.WINDOW_DAYS);
      const historyStart = umami.dayStart(umami.DAYS_HISTORY);

      for (const site of list) {
        try {
          const current = await umami.stats(session, site.id, w.start, w.end);
          const previous = await umami.stats(session, site.id, w.prevStart, w.prevEnd);
          writeUmamiWindow(
            account.id,
            site.id,
            umami.WINDOW_DAYS,
            { start: umami.isoDay(w.start), end: umami.isoDay(w.end) },
            current,
            previous,
          );

          const days = await umami.pageviews(session, site.id, historyStart, w.end);
          writeUmamiDays(account.id, site.id, days);

          for (const kind of ["url", "referrer", "event"] as const) {
            const rows = await umami.metrics(session, site.id, kind, w.start, w.end);
            replaceUmamiTop(account.id, site.id, kind, umami.WINDOW_DAYS, rows);
          }
        } catch (err) {
          /* One site, not the instance. The rows it already had stay: a
             refused read is not news that the traffic did not happen. */
          warnings.push(`${account.label} · ${site.domain ?? site.id}: ${message(err)}`);
        }
      }

      markClock("umami", String(account.id));
      accounts.markOk(account.id);
      answered++;
    } catch (err) {
      const error = message(err);
      accounts.markFailed(account.id, error);
      warnings.push(`${account.label}: ${error}`);
    }
  }

  if (!answered && !skipped) {
    const error = warnings.join("; ") || "No instance answered.";
    finishRun(runId, false, undefined, error);
    syncPlugin("umami", error);
    return { ok: false, error, websites: 0 };
  }

  const note =
    answered === 0
      ? "fresh"
      : `${answered}/${ready.length} instance${ready.length === 1 ? "" : "s"}, ` +
        `${sites} website${sites === 1 ? "" : "s"}` +
        (skipped ? ` · ${skipped} fresh` : "") +
        (warnings.length ? ` · ${warnings.length} warning(s)` : "");

  finishRun(runId, true, note, warnings.join("; ") || undefined);
  syncPlugin("umami", warnings.join("; ") || null);
  return { ok: true, note, error: warnings.join("; ") || null, websites: sites };
}

/* --------------------------------------------------------------- calendar */

/**
 * Google Calendar, collected — once per account, then once per SELECTED
 * calendar.
 *
 * WHY ONLY THE SELECTED ONES. A Google account carries holiday feeds, birthday
 * feeds and every calendar anybody ever shared with the owner. Reading them
 * all would triple the events and tell you nothing about the owner's day —
 * "Feast of St Brigid" is not a commitment. `selected` is the owner's own tick
 * in Google's interface, which makes the choice theirs and keeps it in one
 * place rather than in a second list on this box.
 *
 * THE WRITE IS A REPLACEMENT SCOPED TO THE WINDOW, which is the one shape that
 * can express a CANCELLED meeting: an upsert-only write would leave last
 * week's stand-up on the page forever after somebody deleted it. Rows outside
 * the window are untouched, so history accumulates behind the collector even
 * though it only ever asks about four weeks.
 */
export async function collectCalendar(): Promise<CollectResult & { events: number }> {
  const runId = startRun("calendar");
  const ready = calendar.tokenAccounts("collect_calendar");

  if (!ready.length) {
    const error = "No Google account with a calendar grant is connected.";
    finishRun(runId, false, undefined, error);
    return { ok: false, error, events: 0 };
  }

  pruneClocks("calendar", ready.map((r) => String(r.account.id)));

  const warnings: string[] = [];
  let events = 0;
  let answered = 0;
  let skipped = 0;
  const { timeMin, timeMax } = calendar.window();

  for (const { account, values } of ready) {
    if (!due("calendar", String(account.id), CALENDAR_EVERY_HOURS)) {
      skipped++;
      continue;
    }
    try {
      const { token, scopes } = await calendar.open(values);
      if (scopes.length && !scopes.some((s) => calendar.USABLE_SCOPES.includes(s)))
        throw new Error(
          `that grant carries ${scopes.map((s) => s.split("/").pop()).join(", ")} ` +
            "and not calendar.readonly — it can no longer read this calendar",
        );

      const list = await calendar.calendarList(token);
      replaceCalendars(account.id, list);

      for (const cal of list.filter((c) => c.selected)) {
        try {
          const page = await calendar.events(token, cal.id, timeMin, timeMax);
          replaceCalendarEvents(account.id, cal.id, timeMin, timeMax, page.events);
          events += page.events.length;
          if (page.truncated)
            warnings.push(
              `${cal.summary ?? cal.id}: more than ${calendar.MAX_EVENTS} events in the ` +
                "window — every count for it is a floor, not a total",
            );
        } catch (err) {
          warnings.push(`${cal.summary ?? cal.id}: ${message(err)}`);
        }
      }

      markClock("calendar", String(account.id));
      accounts.markOk(account.id);
      answered++;
    } catch (err) {
      const error = message(err);
      accounts.markFailed(account.id, error);
      warnings.push(`${account.label}: ${error}`);
    }
  }

  /* Events older than the window this collector maintains are forgotten. A
     calendar is a rolling window and a meeting from March answers no question
     this route asks; keeping them would make the table grow forever to hold
     rows nothing reads. */
  if (answered) pruneCalendarEvents(timeMin);

  if (!answered && !skipped) {
    const error = warnings.join("; ") || "No account answered.";
    finishRun(runId, false, undefined, error);
    syncPlugin("calendar", error);
    return { ok: false, error, events: 0 };
  }

  const note =
    answered === 0
      ? "fresh"
      : `${answered}/${ready.length} account${ready.length === 1 ? "" : "s"}, ` +
        `${events} event${events === 1 ? "" : "s"} over ${calendar.BACK_DAYS}+${calendar.AHEAD_DAYS} days` +
        (skipped ? ` · ${skipped} fresh` : "") +
        (warnings.length ? ` · ${warnings.length} warning(s)` : "");

  finishRun(runId, true, note, warnings.join("; ") || undefined);
  syncPlugin("calendar", warnings.join("; ") || null);
  return { ok: true, note, error: warnings.join("; ") || null, events };
}

/* ------------------------------------------------------------------- pypi */

/**
 * PyPI, collected — once per configured package.
 *
 * THERE ARE NO ACCOUNTS HERE and that is not an omission: both services are
 * public, so there is nothing an account row could own. "Connected" means
 * exactly "there is a list to collect", which is why this writes the plugin's
 * flag directly rather than through `syncPlugin`, whose rule (any account
 * connected) would read false forever. collectNpm's argument, unchanged.
 *
 * TWO CLOCKS IN ONE COLLECTOR. `recent` is one request and answers the figure
 * a card shows first, so it is read every tick. The 180-day line and the
 * package metadata are read every six hours, because pypistats rebuilds its
 * dataset once a day and asking every half hour would spend ninety-six
 * requests a day per package to redraw the same buckets — TRAFFIC_EVERY_HOURS'
 * argument, applied to a service nobody is paying for.
 */
export async function collectPypi(): Promise<CollectResult & { packages: number }> {
  const runId = startRun("pypi");
  const packages = pypi.parsePackages(configValue("pypi", "packages"));

  if (!packages.length) {
    const error =
      "No packages configured. PyPI needs no key, but it does need to know " +
      "which packages are yours — set them on the plugin page.";
    finishRun(runId, false, undefined, error);
    upsertPlugin("pypi", false, error);
    return { ok: false, error, packages: 0 };
  }

  // A name taken off the list takes its downloads with it, or it would go on
  // counting inside every total while appearing nowhere on the page.
  forgetPypiPackages(packages);

  const warnings: string[] = [];
  let ok = 0;
  let days = 0;

  for (const pkg of packages) {
    let touched = false;
    const problems: string[] = [];

    try {
      const r = await pypi.recent(pkg);
      writePypiPackage(pkg, {
        lastDay: r.lastDay,
        lastWeek: r.lastWeek,
        lastMonth: r.lastMonth,
        recentAt: new Date().toISOString(),
      });
      touched = true;
    } catch (err) {
      problems.push(`recent: ${message(err)}`);
    }

    if (due("pypi", pkg, PYPI_HISTORY_EVERY_HOURS)) {
      await sleep(PYPI_GAP_MS);
      try {
        const line = await pypi.overall(pkg);
        days += writePypiDays(pkg, line);
        touched = true;
      } catch (err) {
        problems.push(`overall: ${message(err)}`);
      }

      await sleep(PYPI_GAP_MS);
      try {
        const m = await pypi.meta(pkg);
        writePypiPackage(pkg, {
          version: m.version,
          summary: m.summary,
          homePage: m.homePage,
          projectUrls: m.projectUrls ? JSON.stringify(m.projectUrls) : null,
          metaAt: new Date().toISOString(),
        });
        touched = true;
      } catch (err) {
        /* pypi.org and pypistats are different hosts with different outages,
           so metadata that will not read is a warning on a package that still
           has downloads — never a failed package. */
        problems.push(`metadata: ${message(err)}`);
      }
      if (touched) markClock("pypi", pkg);
    }

    /* The days and counters already written stay: a refused read is not news
       that the downloads did not happen. */
    writePypiPackage(pkg, {
      error: problems.length ? problems.join("; ") : null,
      ok: touched,
    });
    if (problems.length) warnings.push(`${pkg}: ${problems.join("; ")}`);
    if (touched) ok++;

    await sleep(PYPI_GAP_MS);
  }

  if (!ok) {
    const error = warnings.join("; ");
    finishRun(runId, false, undefined, error);
    upsertPlugin("pypi", true, error);
    return { ok: false, error, packages: 0 };
  }

  const note =
    `${ok}/${packages.length} package${packages.length === 1 ? "" : "s"}` +
    (days ? `, ${days} daily figures` : "") +
    (warnings.length ? ` · ${warnings.length} warning(s)` : "");
  finishRun(runId, true, note, warnings.join("; ") || undefined);
  upsertPlugin("pypi", true, warnings.join("; ") || null);
  return { ok: true, note, error: warnings.join("; ") || null, packages: ok };
}

/* ---------------------------------------------------------------- bluesky */

/**
 * Bluesky, collected — once per configured handle, on a six-hour clock.
 *
 * ACCOUNTS: NONE, for pypi's reason. The public AppView answers to anybody, so
 * "connected" means there is a list of handles.
 *
 * ONE READING PER HANDLE PER COLLECTION, and only the follower count. It is
 * the one figure here that is a STOCK rather than a window — it is true at a
 * moment, and the shape of its line over months is the question anybody asks
 * of a social account. The engagement windows are NOT recorded as readings:
 * they are recomputed from the same fifty posts every run and their values
 * move as old posts gather new likes, so a time series of them would be a
 * chart of a moving definition.
 */
export async function collectBluesky(): Promise<CollectResult & { handles: number }> {
  const runId = startRun("bluesky");
  const handles = bluesky.parseHandles(configValue("bluesky", "handles"));

  if (!handles.length) {
    const error =
      "No handles configured. Bluesky's public API needs no key, but it does " +
      "need to know whose account to read — set the handles on the plugin page.";
    finishRun(runId, false, undefined, error);
    upsertPlugin("bluesky", false, error);
    return { ok: false, error, handles: 0 };
  }

  forgetBlueskyHandles(handles);

  const warnings: string[] = [];
  let ok = 0;
  let skipped = 0;

  for (const handle of handles) {
    if (!due("bluesky", handle, BLUESKY_EVERY_HOURS)) {
      skipped++;
      continue;
    }
    try {
      const p = await bluesky.profile(handle);
      writeBlueskyProfile(handle, {
        did: p.did,
        displayName: p.displayName,
        followers: p.followers,
        follows: p.follows,
        posts: p.posts,
        avatar: p.avatar,
        error: null,
        ok: true,
      });
      if (p.followers !== null)
        record(`bluesky.${handle}.followers`, p.followers, { did: p.did });

      await sleep(BLUESKY_GAP_MS);

      try {
        const feed = await bluesky.authorFeed(handle);
        for (const days of bluesky.WINDOWS)
          writeBlueskyWindow(handle, days, bluesky.windowTotals(feed, days));
        /* THE SAME PAGE, KEPT RATHER THAN ONLY COUNTED. The request has
           already been made and its posts are already parsed; storing them
           costs nothing more and is what lets a board show which post earned
           the likes the windows above total. Reposts by the handle are
           dropped for the reason the windows drop them: somebody else's post,
           somebody else's likes. */
        writeBlueskyPosts(
          handle,
          feed.filter((p) => !p.isRepostByAuthor),
        );
      } catch (err) {
        /* The profile answered and the feed did not. That is a handle with
           counts and no engagement figures, which is a smaller failure than
           the handle being marked dead. */
        warnings.push(`${handle}: feed — ${message(err)}`);
        writeBlueskyProfile(handle, { error: `feed: ${message(err)}` });
      }

      markClock("bluesky", handle);
      ok++;
    } catch (err) {
      const error = message(err);
      writeBlueskyProfile(handle, { error });
      warnings.push(`${handle}: ${error}`);
    }
    await sleep(BLUESKY_GAP_MS);
  }

  if (!ok && !skipped) {
    const error = warnings.join("; ");
    finishRun(runId, false, undefined, error);
    upsertPlugin("bluesky", true, error);
    return { ok: false, error, handles: 0 };
  }

  const note =
    ok === 0
      ? "fresh"
      : `${ok}/${handles.length} handle${handles.length === 1 ? "" : "s"}` +
        (skipped ? ` · ${skipped} fresh` : "") +
        (warnings.length ? ` · ${warnings.length} warning(s)` : "");
  finishRun(runId, true, note, warnings.join("; ") || undefined);
  upsertPlugin("bluesky", true, warnings.join("; ") || null);
  return { ok: true, note, error: warnings.join("; ") || null, handles: ok };
}

/* --------------------------------------------------------------- helpers */

/** The connected flag for a list-shaped plugin, recomputed from the list. The
 *  `after` hook on both config entries — npm's rule, twice. */
export function syncListPlugin(id: string, count: number) {
  if (!getPlugin(id)) upsertPlugin(id, false, null);
  upsertPlugin(id, count > 0, null);
}
