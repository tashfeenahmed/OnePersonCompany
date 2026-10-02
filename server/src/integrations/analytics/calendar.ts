/**
 * Google Calendar — the same OAuth client Gmail uses, pointed at a different
 * API, and it is a SEPARATE PLUGIN for exactly one reason: a different scope.
 *
 * The refresh token in the `gmail` plugin's vault was minted for
 * `gmail.modify` and can no more read a calendar than a Hetzner token can read
 * Stripe. Google's grants are per scope, the consent screen is where a scope
 * is added, and there is no call this code could make to widen one. So a
 * second plugin, a second account, a second refresh token — minted at the same
 * consent screen with `calendar.readonly` ticked — and a `verify` whose whole
 * job is to say that sentence when the pasted token is the mail one.
 *
 * IT READS THROUGH `get()` AND WRITES THROUGH `send()`, AND NOTHING ELSE.
 * This file used to be read-only by construction — one GET, no body
 * parameter. The owner then asked for an agent that can put things on the
 * calendar, and for a calendar page that can do the same, so the write now
 * exists and lives in ONE function beside the read. Every write goes through
 * `send()`, touches exactly one event, and only happens when the grant
 * carries a write scope (`WRITE_SCOPES`) — a token minted with
 * `calendar.readonly` still reads exactly as it did, and the page and the
 * agent are told "this calendar is read-only" rather than shown a 403.
 *
 * WHAT IT CALLS:
 *   POST   oauth2.googleapis.com/token                  the refresh grant
 *   GET    /calendar/v3/users/me/calendarList           which calendars, which are selected
 *   GET    /calendar/v3/calendars/{id}/events           the window, expanded into instances
 *   POST   /calendar/v3/calendars/{id}/events           create one event
 *   PATCH  /calendar/v3/calendars/{id}/events/{event}   change one event (or one occurrence)
 *   DELETE /calendar/v3/calendars/{id}/events/{event}   delete one event (or one occurrence)
 *
 * NO GUESTS ARE EVER ADDED, and `sendUpdates` is always `none`. A write from
 * here changes the owner's own calendar; it never emails anybody, which is a
 * fact about the request body rather than a rule an agent could misread.
 *
 * `singleEvents=true` IS LOAD-BEARING AND NOT A CONVENIENCE. Without it a
 * weekly stand-up is ONE event with a recurrence rule, and every figure about
 * "what is on this week" would have to expand RRULEs — including their
 * exceptions, their cancelled instances and their moved ones — in code that
 * would be wrong about a timezone eventually. With it Google expands them, in
 * its own timezone arithmetic, and every row here is a real occurrence with a
 * real start.
 *
 * NO DESCRIPTION IS READ OR STORED. The events table has no column for one —
 * see migration 032 — and the field masks below never ask Google for one, on
 * reads or on the echo of a write. A description can be WRITTEN (the owner or
 * the agent may want notes on an event they create), and it goes to Google
 * and nowhere else: it is not in the response mask, not in the table, and not
 * logged.
 */
import type { Account } from "../../accounts.ts";
import * as accounts from "../../accounts.ts";

const API = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 30_000;

/**
 * The scopes that can produce every figure below.
 *
 * `calendar.readonly` is what this code deserves and what the plugin asks for.
 * The two wider ones are accepted because an owner who already granted a
 * calendar app full access has a token that reads perfectly well, and refusing
 * it would send them to a consent screen to obtain strictly less power than
 * they have already given — while this file's single GET makes the extra power
 * unexercisable. `calendar.events.readonly` reads events but NOT the calendar
 * list, so it is named in the error rather than accepted: a grant that cannot
 * list calendars cannot tell us which ones the owner has selected.
 */
export const USABLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];

/** The scopes that can create, change and delete events. `calendar` is the
 *  one the connect hint asks for, because it also reads the calendar list;
 *  `calendar.events` writes events and is accepted beside `calendar.readonly`. */
export const WRITE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
];

/** Can a grant with these scopes write? An ABSENT scope list (Google omits it
 *  from some refresh responses) is read as no: a calendar wrongly marked
 *  read-only costs a reconnect, one wrongly marked writable costs a 403 in the
 *  middle of somebody's sentence. */
export const canWrite = (scopes: string[]) => scopes.some((s) => WRITE_SCOPES.includes(s));

/** The access roles on a calendar that let its owner change events on it. */
export const WRITABLE_ROLES = ["owner", "writer"];

/** The window a collection maintains: a week back, three weeks ahead. Back far
 *  enough that "what did I do last week" is answerable, forward far enough
 *  that "what is coming" covers a planning horizon, and short enough that the
 *  whole thing is one request per calendar. */
export const BACK_DAYS = 7;
export const AHEAD_DAYS = 21;

/** Per calendar, per collection. Google's own maximum for this endpoint is
 *  2500; 250 is a month of a very busy calendar and the collector says so out
 *  loud when a calendar fills it rather than silently reporting a floor. */
export const MAX_EVENTS = 250;

export class CalendarError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status} ${body}`);
    this.name = "CalendarError";
    this.status = status;
    this.body = body;
  }
}

/* ----------------------------------------------------------------- token */

/**
 * A fresh access token, and the scopes Google says the grant actually carries.
 *
 * The one POST in this file, and it is not a Calendar request: it exchanges a
 * refresh token for an hour-long access token at Google's OAuth endpoint. It
 * mutates nothing on any calendar. The same exception providers/gmail.ts
 * carries, for the same reason.
 *
 * The response's `scope` is the ONLY authoritative statement of what the grant
 * can do — a scope list copied out of a JSON file is what somebody believed
 * when they wrote it down.
 */
async function accessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ token: string; scopes: string[] }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let reason = text.slice(0, 240);
    try {
      const doc = JSON.parse(text) as { error?: string; error_description?: string };
      reason = doc.error_description ?? doc.error ?? reason;
      if (doc.error === "invalid_grant")
        reason =
          "Google has stopped accepting that refresh token. A Cloud app still " +
          "in Testing issues refresh tokens that expire after seven days — " +
          "publish the app, then mint a new one with the calendar scope.";
    } catch {
      /* not JSON; the body is all there is */
    }
    throw new CalendarError(res.status, reason);
  }
  const doc = JSON.parse(text) as { access_token?: string; scope?: string };
  if (!doc.access_token)
    throw new CalendarError(200, "Google returned no access_token for that refresh grant.");
  return {
    token: doc.access_token,
    scopes: (doc.scope ?? "").split(/\s+/).filter(Boolean),
  };
}

/** THE READ. `method: "GET"` and no body; every read in this file is this. */
async function get<T>(
  path: string,
  token: string,
  params: [string, string][] = [],
): Promise<T> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${API}${path}${qs.toString() ? `?${qs}` : ""}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let reason = text.slice(0, 240);
    try {
      const doc = JSON.parse(text) as { error?: { message?: string } };
      reason = doc.error?.message ?? reason;
    } catch {
      /* not JSON; the body is all there is */
    }
    throw new CalendarError(res.status, reason);
  }
  return (text.trim() ? JSON.parse(text) : {}) as T;
}

/**
 * THE WRITE, and the only one. One event per call, `sendUpdates=none` on every
 * request so a change here never emails a guest, and the same error shape as
 * the read so a caller handles both alike.
 */
async function send<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const qs = new URLSearchParams([["sendUpdates", "none"]]);
  if (method !== "DELETE") qs.set("fields", EVENT_FIELDS);
  const res = await fetch(`${API}${path}?${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let reason = text.slice(0, 240);
    try {
      const doc = JSON.parse(text) as { error?: { message?: string } };
      reason = doc.error?.message ?? reason;
    } catch {
      /* not JSON; the body is all there is */
    }
    throw new CalendarError(res.status, reason);
  }
  return (text.trim() ? JSON.parse(text) : {}) as T;
}

/* --------------------------------------------------------------- shapes */

export type CalendarInfo = {
  id: string;
  summary: string | null;
  timezone: string | null;
  primary: boolean;
  /** The owner's own tick beside this calendar in Google's UI. It is what
   *  decides which calendars are read — see migration 032. */
  selected: boolean;
  accessRole: string | null;
  /** Google's own `backgroundColor` for this calendar — the colour the owner
   *  already sees in the app they use — as a six-digit hex, or null. See
   *  migration 036 on why it is Google's and never one this box picked. */
  color: string | null;
};

export type EventRow = {
  id: string;
  summary: string | null;
  /** Google's own string: RFC3339 with an offset for a timed event, a bare
   *  'YYYY-MM-DD' for an all-day one. Never normalised — see migration 032. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  status: string | null;
  location: string | null;
  /** A COUNT, not a list. See migration 032 on why the guest list is not
   *  written down. */
  attendees: number | null;
  organizerSelf: boolean | null;
  /** The OWNER's responseStatus, or null on an event with no guest list. */
  response: string | null;
  /** Google's own permalink for this occurrence. An ADDRESS, not content —
   *  see migration 036 — and the only useful action a read-only page has. */
  link: string | null;
  /** The Meet room, when the event has one. Also an address. */
  meetLink: string | null;
  updated: string | null;
};

/** An https URL, or null. The one gate every link Google sends passes
 *  through before it can reach the database — see `events` below. */
function httpsOnly(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- readers */

export async function calendarList(token: string): Promise<CalendarInfo[]> {
  const doc = await get<{
    items?: {
      id?: string;
      summary?: string;
      timeZone?: string;
      primary?: boolean;
      selected?: boolean;
      accessRole?: string;
      backgroundColor?: string;
    }[];
  }>("/users/me/calendarList", token, [
    ["fields", "items(id,summary,timeZone,primary,selected,accessRole,backgroundColor)"],
    ["maxResults", "250"],
  ]);
  const out: CalendarInfo[] = [];
  for (const item of doc.items ?? []) {
    if (!item.id) continue;
    out.push({
      id: item.id,
      summary: item.summary ?? null,
      timezone: item.timeZone ?? null,
      primary: item.primary === true,
      /*
        `selected` is ABSENT rather than false on a calendar the owner has
        never unticked — Google omits defaults from a fields mask — and the
        primary calendar is never sent with it at all. Absent is read as
        selected, because the alternative is a collection that reads nothing
        from the one calendar that matters most.
      */
      selected: item.selected !== false,
      accessRole: item.accessRole ?? null,
      /*
        ONLY A PLAIN SIX-DIGIT HEX IS KEPT. Google has always sent
        `backgroundColor` in that form, but it lands in a `style` attribute on
        the page and a value that is anything else — an old `colorId`, a
        theme name, a string somebody's proxy rewrote — would be a colour this
        box did not check going straight into the DOM. Refused here rather
        than in the renderer, so the column can only ever hold a colour.
      */
      color: /^#[0-9a-f]{6}$/i.test(item.backgroundColor ?? "")
        ? item.backgroundColor!
        : null,
    });
  }
  return out;
}

/**
 * One calendar's occurrences over a window.
 *
 * `truncated` is returned rather than swallowed: a calendar that filled the
 * page has more events than this document holds, and every count derived from
 * it is a FLOOR. Saying so is the difference between a quiet week and a week
 * this code did not finish reading.
 */
/** What Google sends for one event, as far as this file ever asks. */
type GoogleEvent = {
  id?: string;
  summary?: string;
  status?: string;
  location?: string;
  updated?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { self?: boolean };
  attendees?: { self?: boolean; responseStatus?: string }[];
};

/* THE MASK IS THE PRIVACY BOUNDARY, on reads and on the echo of a write.
   `description` is not in it, so a body is never fetched, never held and never
   logged. Nor are attendee addresses: only `self` and `responseStatus`, which
   are about the owner. `htmlLink` and `hangoutLink` are addresses of the
   occurrence, not its content, and neither names a guest. */
const EVENT_FIELDS =
  "id,summary,status,location,updated,htmlLink,hangoutLink,start,end," +
  "organizer/self,attendees(self,responseStatus)";

function toRow(item: GoogleEvent & { id: string }): EventRow {
  const allDay = !!item.start?.date && !item.start?.dateTime;
  const mine = (item.attendees ?? []).find((a) => a.self === true);
  return {
    id: item.id,
    summary: item.summary ?? null,
    start: item.start?.dateTime ?? item.start?.date ?? null,
    end: item.end?.dateTime ?? item.end?.date ?? null,
    allDay,
    status: item.status ?? null,
    location: item.location ?? null,
    attendees: item.attendees ? item.attendees.length : null,
    organizerSelf: item.organizer ? item.organizer.self === true : null,
    response: mine?.responseStatus ?? null,
    /* ONLY https, and only from Google. Both of these end up in an `href`
       on the page, so a scheme that is not https — a `javascript:` a
       compromised proxy inserted, say — is dropped here rather than trusted
       to a renderer that might one day forget to check. */
    link: httpsOnly(item.htmlLink),
    meetLink: httpsOnly(item.hangoutLink),
    updated: item.updated ?? null,
  };
}

export async function events(
  token: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<{ events: EventRow[]; truncated: boolean }> {
  const doc = await get<{ items?: GoogleEvent[]; nextPageToken?: string }>(
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    token,
    [
      ["timeMin", timeMin],
      ["timeMax", timeMax],
      ["singleEvents", "true"],
      ["orderBy", "startTime"],
      ["maxResults", String(MAX_EVENTS)],
      ["showDeleted", "false"],
      ["fields", `nextPageToken,items(${EVENT_FIELDS})`],
    ],
  );

  const out: EventRow[] = [];
  for (const item of doc.items ?? []) if (item.id) out.push(toRow(item as GoogleEvent & { id: string }));
  return { events: out, truncated: !!doc.nextPageToken };
}

/* --------------------------------------------------------------- writers */

/**
 * What a caller may set on an event. Each field is optional on a change —
 * absent leaves it alone — and `null` on `location` or `description` clears
 * it. A time is either timed (RFC3339 with an offset) or all-day
 * ('YYYY-MM-DD', end EXCLUSIVE as Google has it), and which one is read off
 * its shape; the route checks that start and end agree.
 */
export type EventPatch = {
  summary?: string;
  start?: string;
  end?: string;
  location?: string | null;
  description?: string | null;
};

function toGoogle(patch: EventPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.location !== undefined) body.location = patch.location ?? "";
  if (patch.description !== undefined) body.description = patch.description ?? "";
  /* Google wants the OTHER key nulled when an event changes between timed and
     all-day, or it keeps both and refuses the patch. */
  const at = (v: string) =>
    isDay(v) ? { date: v, dateTime: null } : { dateTime: v, date: null };
  if (patch.start !== undefined) body.start = at(patch.start);
  if (patch.end !== undefined) body.end = at(patch.end);
  return body;
}

/** A bare 'YYYY-MM-DD' — an all-day bound, as Google spells one. */
export const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

const eventPath = (calendarId: string, eventId?: string) =>
  `/calendars/${encodeURIComponent(calendarId)}/events` +
  (eventId ? `/${encodeURIComponent(eventId)}` : "");

export async function createEvent(
  token: string,
  calendarId: string,
  patch: EventPatch & { summary: string; start: string; end: string },
): Promise<EventRow> {
  const item = await send<GoogleEvent>("POST", eventPath(calendarId), token, toGoogle(patch));
  if (!item.id) throw new CalendarError(200, "Google created the event and returned no id for it.");
  return toRow(item as GoogleEvent & { id: string });
}

/** A change to one event. On a recurring series the id the collector holds
 *  is ONE OCCURRENCE (it reads with singleEvents=true), so this changes that
 *  occurrence and not the series. */
export async function updateEvent(
  token: string,
  calendarId: string,
  eventId: string,
  patch: EventPatch,
): Promise<EventRow> {
  const item = await send<GoogleEvent>(
    "PATCH",
    eventPath(calendarId, eventId),
    token,
    toGoogle(patch),
  );
  return toRow({ ...item, id: item.id ?? eventId });
}

/** Delete one event — or, for an occurrence of a series, cancel that one
 *  occurrence. A 410 means it was already gone, which is the outcome asked
 *  for, so it is not an error. */
export async function deleteEvent(token: string, calendarId: string, eventId: string) {
  try {
    await send("DELETE", eventPath(calendarId, eventId), token);
  } catch (err) {
    if (err instanceof CalendarError && err.status === 410) return;
    throw err;
  }
}

/* -------------------------------------------------------------- accounts */

export function tokenAccounts(
  reader: string,
): { account: Account; values: Record<string, string> }[] {
  return accounts.credentialed(
    "calendar",
    ["client-id", "client-secret", "refresh-token"],
    reader,
  ).ready;
}

/** A session for one account: the token, the scopes it carries, and the
 *  calendars it can see. The collector's one entry point. */
export async function open(values: Record<string, string>) {
  const { token, scopes } = await accessToken(
    values["client-id"]!,
    values["client-secret"]!,
    values["refresh-token"]!,
  );
  return { token, scopes };
}

/* --------------------------------------------------------------- verify */

/**
 * Refresh the grant, then list the calendars — because neither proves the
 * other.
 *
 * THE SCOPE CHECK IS THE POINT OF THIS FUNCTION. The token most likely to be
 * pasted here is the Gmail one already in this vault: it refreshes perfectly,
 * and every Calendar call it makes answers 403 with Google's own unhelpful
 * "Request had insufficient authentication scopes". Caught here it is one
 * sentence naming the scope to tick; stored, it is a calendar page that is
 * empty forever for a reason nobody can see.
 *
 * An ABSENT scope list is tolerated — Google omits `scope` from some refresh
 * responses — and the calendarList call below then decides, which is the same
 * trade providers/gmail.ts makes.
 */
export async function verify(values: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<
  | { ok: true; scopes: string[]; calendars: CalendarInfo[]; primary: string | null }
  | { ok: false; error: string }
> {
  try {
    const { token, scopes } = await accessToken(
      values.clientId,
      values.clientSecret,
      values.refreshToken,
    );

    if (scopes.length && !scopes.some((s) => USABLE_SCOPES.includes(s)))
      return {
        ok: false,
        error:
          `That token carries ${scopes
            .map((s) => s.split("/").pop())
            .slice(0, 4)
            .join(", ")} and not calendar.readonly. Google grants scopes at the ` +
          "consent screen and no call from here can widen one, so this needs " +
          "its own refresh token: run `npm run calendar-token`, or your own OAuth " +
          "helper with https://www.googleapis.com/auth/calendar in the scope list. " +
          "The Gmail token in this vault cannot read a calendar.",
      };

    const list = await calendarList(token);
    if (!list.length)
      return {
        ok: false,
        error:
          "That grant works and Google returned no calendars for it. Mint the " +
          "token while signed in as the account whose calendar you want to read.",
      };
    return {
      ok: true,
      scopes,
      calendars: list,
      primary: list.find((c) => c.primary)?.id ?? null,
    };
  } catch (err) {
    if (err instanceof CalendarError) {
      if (err.status === 403 && /insufficient authentication scopes/i.test(err.body))
        return {
          ok: false,
          error:
            "Google refreshed that token and then refused the calendar with " +
            "“insufficient authentication scopes”. It was minted without " +
            "a calendar scope — run `npm run calendar-token` (or your OAuth helper " +
            "with https://www.googleapis.com/auth/calendar) and paste the new " +
            "refresh token.",
        };
      if (err.status === 403 && /has not been used|is disabled/i.test(err.body))
        return {
          ok: false,
          error: `${err.body} (the grant is fine; the Calendar API is switched off on that Cloud project)`,
        };
      return { ok: false, error: `HTTP ${err.status} ${err.body}` };
    }
    const name = err instanceof Error ? err.name : "Error";
    return {
      ok: false,
      error:
        name === "TimeoutError"
          ? "Google did not answer within 30 seconds."
          : `Could not reach Google (${name}).`,
    };
  }
}

/* ---------------------------------------------------------------- window */

/** The collection window, as the two RFC3339 bounds Google wants. */
export function window(from = new Date()) {
  const back = new Date(from.getTime() - BACK_DAYS * 86_400_000);
  const ahead = new Date(from.getTime() + AHEAD_DAYS * 86_400_000);
  return { timeMin: back.toISOString(), timeMax: ahead.toISOString() };
}
