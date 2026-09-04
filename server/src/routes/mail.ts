/**
 * Mail: what arrives, and what leaves.
 *
 * ONE ROUTE FOR BOTH PROVIDERS, the way /api/mobile is one route for both app
 * stores. The Email page asks one question — "what is my mail doing" — of two
 * services that sit at opposite ends of the same pipe, and a page that had to
 * fetch two documents and join them is a page that eventually joins them
 * wrongly. The two halves stay two blocks with two `connected` flags, so an
 * expired Google grant leaves every sending domain exactly where it was.
 *
 * IT IS NOT THE SPLIT THE TWO SEARCH ENGINES TAKE, and the difference is worth
 * naming because the reasoning looks similar. /api/gsc and /api/bing are two
 * routes because Google's impressions and Bing's count the same KIND of thing
 * about different populations, and one document holding both would be one field
 * away from a card that adds them. Nothing here is that shape: an inbox thread
 * waiting on a reply and a transactional password reset are not the same kind
 * of thing at all, and there is no arithmetic anybody would be tempted to
 * perform across them. The temptation is the test, and it fails in the other
 * direction — so one route, and no figure below spans the two.
 *
 * EVERY TOTAL IS COMPUTED HERE, ON THE READ. Nothing stored anywhere says "264
 * sent this week" or "a 0.8% bounce rate": the tables hold one row per email
 * with its own day and its own latest event, and the windows are summed when
 * somebody asks. That matters more for Resend than for most providers on this
 * box, because `last_event` MOVES — an email delivered this morning can be
 * bounced this afternoon — so a stored rate would be wrong in the direction
 * that flatters, and a re-read corrects the row it was computed from.
 *
 * NOTHING PRIVATE IS ON THIS WIRE AND NOTHING PRIVATE COULD BE. The tables
 * behind it hold no subject, no message body, no recipient and no
 * correspondent's address — Gmail's contact rows are HMACs and Resend's email
 * rows carry only our OWN sending address. So this file does not have to
 * remember to redact anything: there is nothing here to redact. That is the
 * rule collect_playstore.py keeps for review authors and collect_inbox.py keeps
 * for the whole inbox, applied one step further than either.
 */
import { Hono } from "hono";
import {
  getPlugin,
  gmailCorrespondents,
  gmailDays,
  gmailLabels,
  gmailMailboxes,
  resendDns,
  resendDomains,
  resendEmails,
  resendState,
  type ResendEmailRow,
} from "../db.ts";
import {
  MAX_THREAD_FETCH,
  NEEDS_REPLY_DEFINITION,
  OUTREACH_DAYS,
  WINDOW_DAYS as GMAIL_WINDOW_DAYS,
} from "../providers/gmail.ts";
import { MAX_PAGES, WINDOW_DAYS as RESEND_WINDOW_DAYS } from "../providers/resend.ts";
import { MAIL_EVERY_HOURS } from "../collector.ts";

export const mail = new Hono();

/** A stored 0/1 as the boolean it was written as. */
const bool = (v: number | null): boolean | null => (v === null ? null : v === 1);

/** Sum a column, or null when not one row carried it. Null is "nothing
 *  reported it", which is never the same as a total of nothing. */
function total<T>(rows: T[], pick: (r: T) => number | null): number | null {
  const seen = rows.map(pick).filter((v): v is number => v !== null);
  return seen.length ? seen.reduce((a, b) => a + b, 0) : null;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * WHAT THIS INTEGRATION CANNOT ANSWER, written as the exchange rather than as a
 * conclusion — the same shape Replicate's block and Cloudflare's carry.
 *
 * A reader who goes looking for an open rate or a monthly send allowance finds
 * out what was asked and what came back, with the date it was checked, rather
 * than assuming the collector is broken and re-pasting a perfectly good key.
 */
export const CANNOT = [
  {
    what: "An open or click rate for anything sent through Resend",
    asked: "GET /domains → open_tracking, click_tracking",
    answer:
      "false on every domain on this account, so Resend never writes an " +
      "opened or clicked event for them. A rate here would be a measurement " +
      "of a feature nobody has switched on — turning tracking on in Resend is " +
      "what would produce one.",
    checked: "2026-09-05",
  },
  {
    what: "How much of a Resend plan's send allowance is left",
    asked: "GET /usage · GET /account · GET /metrics · GET /stats",
    answer:
      "404 for the first and 405 Method not allowed for the rest. There is no " +
      "usage endpoint; the volume figures here are counted from /emails rows.",
    checked: "2026-09-05",
  },
  {
    what: "Anything at all from a Resend Sending-access key",
    asked: "GET /domains with a send-only key",
    answer:
      "401 “This API key is restricted to only send emails”, deterministically " +
      "and on every endpoint. Such a key can POST an email and read nothing, " +
      "so it is refused when it is pasted rather than stored as a domain that " +
      "would never report anything.",
    checked: "2026-09-05",
  },
  {
    what: "Whether a thread was answered by phone, or from another mailbox",
    asked: "the SENT and DRAFT labels on a thread's last message",
    answer:
      "nothing in a mailbox can know. The reply count over-reports rather " +
      "than under — see the definition beside it — which is the safe " +
      "direction for a queue of work.",
    checked: "2026-09-05",
  },
  {
    what: "A narrower Gmail token than the one in the vault",
    asked: "the scopes on the refresh grant",
    answer:
      "Google issues no way to narrow a token after it is minted, and a " +
      "gmail.readonly one needs a human at a consent screen. The credential " +
      "carries gmail.modify — archive, label, trash — and the provider that " +
      "holds it has one HTTP entry point that hard-codes GET and takes no " +
      "body, so the extra power is never exercised.",
    checked: "2026-09-05",
  },
];

mail.get("/", (c) => {
  const days = Math.min(
    400,
    Math.max(1, Number(c.req.query("days") ?? GMAIL_WINDOW_DAYS) || GMAIL_WINDOW_DAYS),
  );

  const mailboxRows = gmailMailboxes();
  const labelRows = gmailLabels();
  const dayRows = gmailDays(days);
  const contactRows = gmailCorrespondents();
  const domainRows = resendDomains();
  const dnsRows = resendDns();
  const emailRows = resendEmails(days);
  const stateRows = resendState();

  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const now = today();

  /* ----------------------------------------------------------- mailboxes */

  const mailboxes = mailboxRows.map((m) => {
    const labels = labelRows
      .filter((l) => l.account_id === m.account_id)
      .map((l) => ({
        id: l.label_id,
        name: l.name,
        kind: l.kind,
        /** Gmail's OWN counters. Exact, and not a search estimate: asked for
         *  the unread inbox as a query, Gmail answered 201 against a true 263
         *  on this mailbox. Null is "the counter did not come back". */
        messagesTotal: l.messages_total,
        messagesUnread: l.messages_unread,
        threadsTotal: l.threads_total,
        threadsUnread: l.threads_unread,
        /** How many threads the reply verdict below is over. A queue with no
         *  denominator is not a measurement. Null means this label was not
         *  scanned at all, which is not "nothing is waiting". */
        scanned: l.scanned,
        needingReply: l.needing_reply,
        oldestWaitingDays: l.oldest_waiting_days,
        /** The listing or the run's budget ran out, so the count is a FLOOR. */
        truncated: l.truncated === 1,
        note: l.note,
      }));
    const inbox = labels.find((l) => l.id === "INBOX") ?? null;
    const mine = m.address ? dayRows.filter((d) => d.address === m.address) : [];
    /* Today is still filling — the mailbox will receive more of it after this
       reading — so it is carried, marked, and left out of every total. Drawn
       beside finished days it is a cliff that never happened, which is the same
       rule Cloudflare's and Search Console's daily lines follow. */
    const volumeDays = mine.map((d) => ({
      day: d.day,
      received: d.received,
      sent: d.sent,
      partial: d.day === now,
      /** Gmail had more ids than one page carried. It has never happened on
       *  this mailbox at 500 a page, and a day that hit it is a floor. */
      capped: d.received_capped === 1 || d.sent_capped === 1,
    }));
    const complete = volumeDays.filter((d) => !d.partial);

    const people = m.address ? contactRows.filter((p) => p.mailbox === m.address) : [];
    const active = people.filter((p) => p.last_at >= since);
    const first = people.map((p) => p.first_at).sort()[0] ?? null;

    return {
      accountId: m.account_id,
      accountLabel: m.account_label,
      /** The mailbox's own address. The only address on this document, and it
       *  is the owner's — no correspondent's ever reaches here. */
      address: m.address,
      messagesTotal: m.messages_total,
      threadsTotal: m.threads_total,
      labelsTotal: m.labels_total,
      historyId: m.history_id,
      /**
       * What Google says the grant carries, off the refresh response rather
       * than off the file it came from.
       *
       * `gmail.modify` is a WRITE scope and this is where a reader finds that
       * out. `readOnly` beside it is the answer: the provider has one function
       * that talks to Gmail, it hard-codes GET, and it takes no body — so the
       * token's extra power is a fact about the credential and never about
       * what this dashboard does with it.
       */
      scopes: (m.scopes ?? "").split(/\s+/).filter(Boolean),
      readOnly: {
        enforced: true,
        how: "one HTTP entry point in providers/gmail.ts, method GET hard-coded, no body parameter",
      },
      unread: {
        /** Two answers, because Gmail has two and they differ by a fifth here:
         *  263 messages against 252 threads. A card must say which it drew. */
        messages: inbox?.messagesUnread ?? null,
        threads: inbox?.threadsUnread ?? null,
      },
      needingReply: inbox?.needingReply ?? null,
      oldestWaitingDays: inbox?.oldestWaitingDays ?? null,
      scanned: inbox?.scanned ?? null,
      floor: inbox?.truncated ?? false,
      labels,
      volume: {
        byDay: volumeDays,
        /** Over COMPLETE days only, and the two are never added: one is mail
         *  that cost you attention and the other mail that cost you a reply. */
        received: total(complete, (d) => d.received),
        sent: total(complete, (d) => d.sent),
        from: complete[0]?.day ?? null,
        to: complete[complete.length - 1]?.day ?? null,
        days: complete.length,
      },
      outreach: {
        /** People this mailbox WROTE to inside the window. Sent mail rather
         *  than received, which gets the "a subscription is not a
         *  relationship" filter for free: nobody was ever subscribed to a
         *  newsletter by writing to it. */
        people: active.length,
        /** First written to inside the window, judged against every day of
         *  sent mail on hand — which `historyFrom` states, because a "new
         *  contact" count is only as good as the history it is new against. */
        new: active.filter((p) => p.first_at >= since).length,
        known: people.length,
        historyFrom: first,
        lookbackDays: OUTREACH_DAYS,
      },
      seenAt: m.seen_at,
      note: m.note,
    };
  });

  /**
   * THE TRIAGE HEADLINE IS THE INBOX'S AND NEVER A SUM ACROSS LABELS.
   *
   * A thread can carry INBOX and a hand-made label at once, so adding the
   * per-label queues counts it twice — the same rule GitHub's unique visitors
   * and Cloudflare's visitors follow, in a place it is far easier to get wrong
   * because the labels look like folders. Across MAILBOXES the counts do add:
   * two Google accounts are two separate stores of mail.
   */
  const inboxCounts = mailboxes.filter((m) => m.needingReply !== null);
  const waiting = total(inboxCounts, (m) => m.needingReply);
  const oldest = inboxCounts
    .map((m) => m.oldestWaitingDays)
    .filter((n): n is number => n !== null)
    .sort((a, b) => b - a)[0];

  const volumeByDay = [...new Set(dayRows.map((d) => d.day))].sort().map((day) => {
    const rows = dayRows.filter((d) => d.day === day);
    return {
      day,
      received: total(rows, (r) => r.received),
      sent: total(rows, (r) => r.sent),
      /** How many mailboxes are in this day. A day the collector could not read
       *  for one of two mailboxes is a smaller day for a reason that is not the
       *  mail — the same trap GitHub's per-repo traffic days carry. */
      mailboxes: rows.length,
      partial: day === now,
    };
  });
  const completeDays = volumeByDay.filter((d) => !d.partial);

  /* ------------------------------------------------------ sending domains */

  const inWindow = emailRows.filter((e) => e.day >= since);
  const bucket = (rows: ResendEmailRow[], event: string) =>
    rows.filter((e) => e.last_event === event).length;

  /**
   * One domain's send figures, counted from rows rather than from anything
   * Resend was asked to total.
   *
   * THE BOUNCE RATE'S DENOMINATOR IS NAMED BECAUSE THERE ARE THREE DEFENSIBLE
   * ONES. It is over mail that actually reached a mail server —
   * delivered + bounced + complained — and NOT over everything sent.
   * `suppressed` is Resend declining to send at all, to an address already on
   * its own suppression list: it never reached a server, so counting it in the
   * denominator would make a domain's bounce rate fall every time Resend
   * refused to try. It is reported on its own line instead, which is also the
   * more actionable number: a suppression is a list to clean.
   */
  function sends(rows: ResendEmailRow[]) {
    const delivered = bucket(rows, "delivered");
    const bounced = bucket(rows, "bounced");
    const complained = bucket(rows, "complained");
    const suppressed = bucket(rows, "suppressed");
    const attempted = delivered + bounced + complained;
    const known = new Set(["delivered", "bounced", "complained", "suppressed"]);
    return {
      sent: rows.length,
      delivered,
      bounced,
      complained,
      suppressed,
      /** Queued, scheduled, delayed, cancelled — anything Resend has not
       *  finished with. Counted apart rather than folded into a failure. */
      inFlight: rows.filter((e) => !known.has(e.last_event ?? "")).length,
      /** Null over nothing attempted, never 0% — the same rule a cache ratio
       *  over zero requests follows. */
      bounceRate: attempted ? Number(((bounced / attempted) * 100).toFixed(2)) : null,
      complaintRate: attempted
        ? Number(((complained / attempted) * 100).toFixed(2))
        : null,
      deliveryRate: attempted
        ? Number(((delivered / attempted) * 100).toFixed(2))
        : null,
      rateBasis: "delivered + bounced + complained — mail that reached a server",
      attempted,
    };
  }

  const sendingDomains = domainRows.map((d) => {
    const records = dnsRows
      .filter((r) => r.domain_id === d.domain_id)
      .map((r) => ({
        record: r.record,
        type: r.type,
        name: r.name,
        status: r.status,
        priority: r.priority,
      }));
    const rows = inWindow.filter((e) => e.domain === d.name);
    const byDay = [...new Set(rows.map((e) => e.day))].sort().map((day) => {
      const of = rows.filter((e) => e.day === day);
      return {
        day,
        sent: of.length,
        delivered: bucket(of, "delivered"),
        bounced: bucket(of, "bounced"),
        /* Today is NOT marked partial on this line, and that is a real
           difference from Gmail's: an email Resend has accepted is a row the
           moment it exists, so today's bucket is complete for every email sent
           so far rather than a fraction of a figure that will be revised. What
           can still change is each row's own last_event, which a re-read
           corrects in place. */
      };
    });
    const state = stateRows.find((s) => s.account_id === d.account_id) ?? null;
    const froms = [...new Set(rows.map((e) => e.from_address).filter((a): a is string => !!a))]
      .map((address) => ({
        address,
        sent: rows.filter((e) => e.from_address === address).length,
      }))
      .sort((a, b) => b.sent - a.sent);

    return {
      id: d.domain_id,
      name: d.name,
      accountId: d.account_id,
      accountLabel: d.account_label,
      /** Resend's own word — "verified", "pending", "failed" — never reduced to
       *  a boolean. A domain part-way through verification and one that will
       *  not send are different situations and only one is a thing to fix. */
      status: d.status,
      region: d.region,
      createdAt: d.created_at,
      sending: d.sending,
      receiving: d.receiving,
      tracking: { open: bool(d.open_tracking), click: bool(d.click_tracking) },
      dns: {
        /** Whether the per-domain call carrying the records answered. A domain
         *  with no records READ is not a domain with no records, so `verified`
         *  below is null rather than zero in that case. */
        read: d.records_read === 1,
        records,
        total: d.records_read === 1 ? records.length : null,
        verified:
          d.records_read === 1 ? records.filter((r) => r.status === "verified").length : null,
        /** The records that are not verified, named. A domain that reads
         *  "verified" while one of its three records has gone pending is a
         *  domain about to stop sending, and the listing endpoint cannot show
         *  that — this is the only place on the board where it is visible. */
        unhealthy: records.filter((r) => r.status !== "verified"),
      },
      sends: {
        ...sends(rows),
        windowDays: days,
        byDay,
        fromAddresses: froms,
        /** How far back this key's own walk reached, and whether its page
         *  ceiling cut it short — so a wide window is read as a floor rather
         *  than as a total. */
        oldest: state?.oldest ?? null,
        floor: state?.truncated === 1,
      },
      seenAt: d.seen_at,
      note: d.note,
    };
  });

  const allSends = sends(inWindow);
  const sendingByDay = [...new Set(inWindow.map((e) => e.day))].sort().map((day) => {
    const of = inWindow.filter((e) => e.day === day);
    return {
      day,
      sent: of.length,
      delivered: bucket(of, "delivered"),
      bounced: bucket(of, "bounced"),
      domains: new Set(of.map((e) => e.domain)).size,
    };
  });

  /* ---------------------------------------------------------------- state */

  const seenAt =
    [
      ...mailboxRows.map((m) => m.seen_at),
      ...domainRows.map((d) => d.seen_at),
    ]
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;

  return c.json({
    generatedAt: new Date().toISOString(),
    /** When the mail was last READ, not when this document was assembled. Every
     *  figure above is recomputed on every request, so the route's own clock
     *  would say "just now" over counts collected two hours ago. */
    seenAt,
    windowDays: days,
    collectedEveryHours: MAIL_EVERY_HOURS,
    connected: {
      gmail: getPlugin("gmail")?.connected === 1,
      resend: getPlugin("resend")?.connected === 1,
    },

    /* ------------------------------------------------------------ arriving */
    mailboxes,
    inbox: {
      mailboxes: mailboxes.length,
      /** Summed across mailboxes, which is safe — two Google accounts are two
       *  separate stores of mail — and never across labels, which is not. */
      unreadThreads: total(mailboxes, (m) => m.unread.threads),
      unreadMessages: total(mailboxes, (m) => m.unread.messages),
      needingReply: waiting,
      oldestWaitingDays: oldest ?? null,
      scanned: total(mailboxes, (m) => m.scanned),
      /** True when a listing or the run's thread budget ran out, which makes
       *  `needingReply` a floor rather than a count. */
      floor: mailboxes.some((m) => m.floor),
      budget: MAX_THREAD_FETCH,
      windowDays: GMAIL_WINDOW_DAYS,
      /** The sentence the count is only interpretable beside. */
      definition: NEEDS_REPLY_DEFINITION,
    },
    volume: {
      byDay: volumeByDay,
      received: total(completeDays, (d) => d.received),
      sent: total(completeDays, (d) => d.sent),
      from: completeDays[0]?.day ?? null,
      to: completeDays[completeDays.length - 1]?.day ?? null,
      days: completeDays.length,
      note:
        "received and sent are never added: one is mail that arrived and one " +
        "is mail you wrote. Today is carried, marked partial, and is in no total.",
    },
    outreach: {
      /** De-duplicated across mailboxes by fingerprint, because a person
       *  written to from two addresses is one relationship — the merge
       *  collect_contacts.py performs, done here without ever holding a name. */
      people: new Set(
        contactRows.filter((p) => p.last_at >= since).map((p) => p.fingerprint),
      ).size,
      new: new Set(
        contactRows
          .filter((p) => p.last_at >= since && p.first_at >= since)
          .map((p) => p.fingerprint),
      ).size,
      known: new Set(contactRows.map((p) => p.fingerprint)).size,
      historyFrom: contactRows.map((p) => p.first_at).sort()[0] ?? null,
      windowDays: days,
      lookbackDays: OUTREACH_DAYS,
      note:
        "counted from mail you SENT, so a mailing list is not a contact. No " +
        "address or name is stored: each person is an HMAC that exists only to " +
        "let two collections agree they saw the same one.",
    },

    /* ------------------------------------------------------------- leaving */
    sendingDomains,
    sending: {
      domains: sendingDomains.length,
      verified: sendingDomains.filter((d) => d.status === "verified").length,
      /** Kept apart from `verified`, because "pending" is a domain part-way
       *  through and "failed" is one that will not send. */
      pending: sendingDomains.filter((d) => d.status === "pending").length,
      failed: sendingDomains.filter(
        (d) => d.status !== "verified" && d.status !== "pending",
      ).length,
      regions: [...new Set(sendingDomains.map((d) => d.region).filter(Boolean))],
      ...allSends,
      windowDays: days,
      byDay: sendingByDay,
      floor: sendingDomains.some((d) => d.sends.floor),
      pageCeiling: MAX_PAGES,
      walkDays: RESEND_WINDOW_DAYS,
      oldest: emailRows[0]?.day ?? null,
      note:
        "counted from Resend's own /emails rows, one per email, keyed by its " +
        "id and re-read every collection — last_event moves after the fact, so " +
        "a bounce that happens this afternoon corrects this morning's row " +
        "rather than being missed.",
    },
    dns: {
      /** DNS health across every sending domain, computed here rather than
       *  stored: a record that went pending overnight must not be reported
       *  from a snapshot that was right yesterday. */
      domains: sendingDomains.filter((d) => d.dns.read).length,
      unread: sendingDomains.filter((d) => !d.dns.read).length,
      records: total(sendingDomains, (d) => d.dns.total),
      verified: total(sendingDomains, (d) => d.dns.verified),
      unhealthy: sendingDomains
        .filter((d) => d.dns.unhealthy.length)
        .map((d) => ({
          domain: d.name,
          records: d.dns.unhealthy.map((r) => `${r.record} ${r.type} ${r.name}`),
          status: d.dns.unhealthy.map((r) => r.status),
        })),
    },

    accounts: {
      gmail: mailboxRows.map((m) => ({
        id: m.account_id,
        label: m.account_label,
        address: m.address,
        seenAt: m.seen_at,
        note: m.note,
      })),
      resend: stateRows.map((s) => ({
        id: s.account_id,
        label: s.account_label,
        domains: s.domains,
        emails: s.emails,
        pages: s.pages,
        oldest: s.oldest,
        truncated: s.truncated === 1,
        seenAt: s.seen_at,
        note: s.note,
      })),
    },

    cannot: CANNOT,
    privacy:
      "no subject, no message body, no recipient and no correspondent's " +
      "address is stored or served anywhere in this document. The only " +
      "addresses on it are the owner's own mailbox and the from-addresses of " +
      "domains the owner sends from.",
  });
});
