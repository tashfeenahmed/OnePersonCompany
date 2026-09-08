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
 * READ-ONLY, STRUCTURALLY. `providers/gmail.ts` makes "this cannot archive,
 * label or send" a fact about the code by having one function that talks to
 * Gmail with `method: "GET"` hard-coded and no body parameter. The same shape
 * is kept here for the same reason: `get()` below is the only function in this
 * file that reaches Google's Calendar API, it is a GET, and there is no
 * argument anywhere that would make it a POST. A token minted with the wider
 * `calendar` scope — which some owners will already have — therefore cannot
 * create, move or cancel anything from this box.
 *
 * WHAT IT READS, and nothing else:
 *   POST oauth2.googleapis.com/token          the refresh grant (not a Calendar call)
 *   GET  /calendar/v3/users/me/calendarList   which calendars, and which are selected
 *   GET  /calendar/v3/calendars/{id}/events   the window, expanded into instances
 *
 * `singleEvents=true` IS LOAD-BEARING AND NOT A CONVENIENCE. Without it a
 * weekly stand-up is ONE event with a recurrence rule, and every figure about
 * "what is on this week" would have to expand RRULEs — including their
 * exceptions, their cancelled instances and their moved ones — in code that
 * would be wrong about a timezone eventually. With it Google expands them, in
 * its own timezone arithmetic, and every row here is a real occurrence with a
 * real start.
 *
 * NO DESCRIPTION, EVER. The events table has no column for one — see migration
 * 032 — and this file does not ask Google for one either: the field mask below
 * names what is read, so a body is not fetched, not held in memory and not
 * logged. The same line the mail tables draw.
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

/**
 * THE ONLY FUNCTION IN THIS FILE THAT TALKS TO GOOGLE CALENDAR.
 *
 * `method: "GET"` is written here and nowhere else and there is no body
 * parameter, which is what makes "this cannot create, move or cancel an event"
 * a fact about the code rather than a claim about the credential.
 */
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
export async function events(
  token: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<{ events: EventRow[]; truncated: boolean }> {
  const doc = await get<{
    items?: {
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
    }[];
    nextPageToken?: string;
  }>(`/calendars/${encodeURIComponent(calendarId)}/events`, token, [
    ["timeMin", timeMin],
    ["timeMax", timeMax],
    ["singleEvents", "true"],
    ["orderBy", "startTime"],
    ["maxResults", String(MAX_EVENTS)],
    ["showDeleted", "false"],
    /* THE MASK IS THE PRIVACY BOUNDARY. `description` is not in it, so a body
       is never fetched, never held and never logged. Nor are attendee
       addresses: only `self` and `responseStatus`, which are about the owner.
       `htmlLink` and `hangoutLink` were added to it for the calendar page and
       do not move that line: both are addresses of the occurrence, neither is
       its content, and neither names a guest. */
    [
      "fields",
      "nextPageToken,items(id,summary,status,location,updated,htmlLink," +
        "hangoutLink,start,end,organizer/self,attendees(self,responseStatus))",
    ],
  ]);

  const out: EventRow[] = [];
  for (const item of doc.items ?? []) {
    if (!item.id) continue;
    const allDay = !!item.start?.date && !item.start?.dateTime;
    const mine = (item.attendees ?? []).find((a) => a.self === true);
    out.push({
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
    });
  }
  return { events: out, truncated: !!doc.nextPageToken };
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
          "its own refresh token: rerun your OAuth helper with " +
          "https://www.googleapis.com/auth/calendar.readonly in the scope list. " +
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
            "calendar.readonly — rerun your OAuth helper with " +
            "https://www.googleapis.com/auth/calendar.readonly and paste the new " +
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
