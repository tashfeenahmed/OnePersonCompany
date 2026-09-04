/**
 * The mailbox — a live proxy onto Gmail and Resend. NOTHING HERE IS STORED.
 *
 * THAT IS THE FIRST THING TO KNOW AND IT IS A DELIBERATE BREAK WITH THE ROUTE
 * NEXT DOOR. `routes/mail.ts` answers "what is my mail doing" out of tables
 * that were filled by a collector on a timer, and those tables cannot hold a
 * subject, a body or a correspondent — the schema has no column for one, which
 * is what makes its privacy claim structural rather than a promise. This route
 * answers "what does this thread say", which no such table could ever answer,
 * so it does the opposite thing: it asks Gmail on the read, hands the answer
 * to one browser, and forgets it.
 *
 * Concretely, and this is the whole contract:
 *
 *   * no `INSERT`, no `UPDATE`, no file write and no `console.log` of anything
 *     that came out of a message. The only database reads below are the
 *     mailbox ADDRESS and the sending DOMAIN LIST — configuration, not mail.
 *   * no cache. A thread read twice is fetched twice. A sixty-second memo
 *     would be a mailbox living in this process's heap between requests, which
 *     is a smaller version of the thing this route exists not to do, and it
 *     would buy a page load that is already two seconds.
 *   * `routes/mail.ts` is untouched by any of it. Its schema is still
 *     body-free, and nothing here writes to it.
 *
 * ONE INBOX, AND THE VENTURE MAILBOX IS A FILTER RATHER THAN A PLACE. Every
 * domain in this portfolio routes its mail through Cloudflare into a single
 * Gmail account, and Resend sends back out as any address on those domains. So
 * there is one list and the per-venture "mailbox" is a Gmail QUERY —
 * `to:(@livetutor.io)` — not a folder, not a second account, and not a
 * client-side filter over rows already fetched. That last one is the trap: 25
 * rows filtered in the browser would show "3 threads" for a venture with
 * hundreds, and the number would be a fact about the page size.
 *
 * WHICH MAILBOX A THREAD ARRIVED AT IS DECIDED HERE AND NOWHERE ELSE. The From
 * line says who wrote and the subject says what about; neither says which
 * business it concerns, and the To line — the one header a thread list has
 * never shown — is the only clue. The provider hands over every address in
 * every To, Cc and Delivered-To across the thread; this file matches them
 * against the domains the Resend keys actually cover, because this is the only
 * place both facts are on hand. The browser does not re-derive it: a forwarding
 * chain rewrites headers in ways that are this file's problem.
 *
 * HTML IS SANITISED HERE, ON THE WAY OUT, AND THE BROWSER IS NOT ASKED TO
 * HELP. Workdash's own version of this page does the opposite — it passes the
 * sender's markup through verbatim and relies entirely on a sandboxed iframe —
 * and its comment gives the honest reason: every newsletter is a table layout,
 * so a clumsy strip breaks the mail while still not being safe. The answer
 * taken here is not to choose: the markup is cleaned server-side (see
 * `sanitise`) AND arrives inside a document carrying its own restrictive CSP,
 * so the frame is the second wall rather than the only one. A client that
 * cleaned its own mail would be a client where one forgotten call site is a
 * vulnerability.
 *
 * REMOTE IMAGES ARE OFF UNTIL SOMEBODY ASKS, PER MESSAGE. A remote image in a
 * marketing email is a tracking pixel far more often than it is a picture, and
 * loading it tells the sender the mail was opened, when, and roughly from
 * where. Turning them on re-fetches that one message from Gmail rather than
 * unhiding something already delivered, because the only way to be sure the
 * browser cannot load a URL is to not send it the URL.
 *
 * THE ONE WRITE IS `POST /threads/:id/read`. It is named at
 * `providers/gmail.ts`'s own header, it can only ever add or remove the UNREAD
 * label, and it is the exception the read-only stance has to state out loud
 * rather than the beginning of a general POST.
 */
import { Hono } from "hono";
import * as accounts from "../accounts.ts";
import { gmailMailboxes, resendDomains } from "../db.ts";
import {
  GmailError,
  NoMailbox,
  listThreads,
  modify,
  open,
  readThread,
  type LiveMessage,
  type Session,
  type ThreadRow,
} from "../providers/gmail.ts";
import {
  ResendError,
  sentEmail,
  sentList,
  type SentEmail,
  type SentRow,
} from "../providers/resend.ts";

export const mailbox = new Hono();

/**
 * How many threads a page carries.
 *
 * Twenty-five, and the ceiling is quota rather than taste. `threads.list`
 * answers with ids and nothing a row could be drawn from, so every row costs
 * its own `threads.get` at ten quota units — a page of 25 is 260 units, about
 * two seconds through the provider's rate gate. A hundred would be eight
 * seconds of spinner to draw a list nobody scrolls to the bottom of, and the
 * page token below is the better answer to "I want more".
 */
const PAGE = 25;
const MAX_PAGE = 50;

/** A page of the sent list, per domain. Resend's own maximum is 100 and its
 *  rows are cheap — one request, no hydration — so this is set by what a person
 *  will read rather than by what the API will bear. */
const SENT_PAGE = 25;

/**
 * How many domains the merged "sent by apps" view reads at once.
 *
 * Ten keys at a quarter-second apiece is two and a half seconds, which is the
 * whole reason this cap exists rather than a quota. A portfolio that grows to
 * forty domains should not turn one page load into ten seconds; past the cap
 * the response says how many domains it left out, and picking one domain reads
 * only that one.
 */
const MERGE_DOMAINS = 12;

/* ====================================================================== */
/*  Which mailboxes exist                                                 */
/* ====================================================================== */

type MailboxChip = {
  /** What `?mailbox=` takes: a bare domain, or "gmail". */
  key: string;
  kind: "gmail" | "domain";
  /** The domain, for a domain chip. Null for the Gmail one, which is an
   *  address rather than a domain. */
  domain: string | null;
  /** The Gmail address, for the Gmail chip. Null for the rest. */
  address: string | null;
  /**
   * THE LABEL IS THE DOMAIN'S OWN NAME AND NOT A PRODUCT'S.
   *
   * Workdash hard-codes a table — "livetutor.io" → "LiveTutor" — which it can
   * do because that list is five entries maintained by hand beside the page.
   * This app has ventures, and a venture here has a name, a description and a
   * colour and NO DOMAIN FIELD; there is no join to make. Worse, the ventures
   * live in the browser's store, so this process cannot see them at all.
   *
   * So the server labels a domain with the domain. The client owns the only
   * honest upgrade available — matching a venture's name against the domain's
   * own label, so `planintel.ie` reads as "PlanIntel" and a domain matching no
   * venture keeps its own name rather than being given an invented one. Doing
   * that here would mean either shipping a hard-coded table this codebase has
   * no basis for, or inventing "Fityourwit" out of `fityourwit.co` and
   * presenting it as the name of a business.
   */
  label: string;
  accountId: number;
  accountLabel: string;
  /** Resend's own word for the domain — "verified", "pending". Null for the
   *  Gmail chip and for a domain the collector has not read yet. */
  status: string | null;
};

/**
 * The chips: every connected Resend domain, plus the Gmail account itself.
 *
 * TWO SOURCES AND THE ACCOUNT ROWS WIN. Which domains exist comes from the
 * plugin accounts — the same rows the Integrations page draws — so a key added
 * there appears here with no second list to keep in step, and a key whose
 * collection has never run still gets a chip. What the collector knows about
 * the domain (its verification status, and the id Resend gave it) is laid over
 * that. A domain with an account row and no collected row is a chip with a
 * null status, which is "not read yet" and not "not verified".
 */
function chips(): { chips: MailboxChip[]; gmail: MailboxChip | null } {
  const collected = new Map(resendDomains().map((d) => [d.account_id, d]));
  const list: MailboxChip[] = [];

  for (const account of accounts.list("resend")) {
    if (!account.connected) continue;
    const row = collected.get(account.id);
    /* The account's LABEL is the domain — the Resend door names an account
       after the domain its key can actually see, rather than "Account 4" — but
       the collected row is the domain Resend itself named, so it wins where it
       exists. A renamed account cannot silently re-point a chip. */
    const domain = (row?.name ?? account.label).trim().toLowerCase();
    if (!domain.includes(".")) continue;
    list.push({
      key: domain,
      kind: "domain",
      domain,
      address: null,
      label: domain,
      accountId: account.id,
      accountLabel: account.label,
      status: row?.status ?? null,
    });
  }
  list.sort((a, b) => a.key.localeCompare(b.key));

  /* The Gmail chip is last, because it is the pile everything that is not a
     venture lands in — the personal mail, and the mail sent straight to the
     Google address. It is a chip rather than the absence of one so "just my
     own mail" is reachable, which "All" cannot express. */
  const boxes = gmailMailboxes();
  const gmailAccount = accounts.list("gmail").find((a) => a.connected) ?? null;
  const box = gmailAccount ? boxes.find((b) => b.account_id === gmailAccount.id) : undefined;
  const gmail: MailboxChip | null =
    gmailAccount && box?.address
      ? {
          key: "gmail",
          kind: "gmail",
          domain: null,
          address: box.address,
          label: box.address,
          accountId: gmailAccount.id,
          accountLabel: gmailAccount.label,
          status: null,
        }
      : null;

  return { chips: gmail ? [...list, gmail] : list, gmail };
}

mailbox.get("/mailboxes", (c) => {
  const { chips: all, gmail } = chips();
  const gmailAccounts = accounts.list("gmail").filter((a) => a.connected);
  return c.json({
    /** Whether there is a mailbox to read at all. Every other route here is
     *  404 without one, and this is the flag the page checks before it draws
     *  an empty list that would read as "no mail". */
    connected: gmailAccounts.length > 0,
    gmail,
    accounts: gmailAccounts.map((a) => ({ id: a.id, label: a.label })),
    mailboxes: all,
    /** Said on the wire because a reader who sees "fityourwit.co" where they
     *  expected a product name should find out why in one place. */
    labelling:
      "A chip is labelled with its own domain. Ventures in this app carry no " +
      "domain field and live in the browser's store, so the page matches a " +
      "venture's name against the domain and names the chip after it when they " +
      "agree — a domain matching no venture keeps its own name rather than " +
      "being given an invented one.",
  });
});

/* ====================================================================== */
/*  The query                                                             */
/* ====================================================================== */

/**
 * The mailbox chip, as a Gmail search term.
 *
 * `to:` AND NOT `deliveredto:`, WHICH IS THE COUNTER-INTUITIVE HALF. Every one
 * of these domains reaches the mailbox by Cloudflare forwarding, and a
 * forwarded message was *delivered to* the Gmail address — so `deliveredto:` on
 * a venture domain matches nothing at all, and `deliveredto:` on the Gmail one
 * matches practically everything. The original To header survives the forward,
 * so `to:` is the term that means what the chip says.
 *
 * The parentheses matter: `to:(@livetutor.io)` groups the term, so free text
 * appended after it stays a separate condition rather than being swallowed into
 * the address.
 */
function scopeFor(mailboxKey: string | null, gmailAddress: string | null): string {
  if (!mailboxKey || mailboxKey === "all") return "";
  if (mailboxKey === "gmail") return gmailAddress ? `to:(${gmailAddress})` : "";
  return `to:(@${mailboxKey})`;
}

/** Gmail's own operators, so a query that already says where to look is not
 *  overruled by the default. Somebody who types `in:anywhere` or `label:sent`
 *  means it. */
const PLACE_OPERATOR = /\b(in|label|is|has|category):/i;

/**
 * Chip, free text and a place, ANDed.
 *
 * Gmail ANDs space-separated terms, which is what having a chip and a search
 * box visible at once implies: the chip narrows and the box narrows further.
 * The typed text is passed through untouched, so Gmail's own operators —
 * `from:`, `has:attachment`, quoted phrases — keep working inside a scoped
 * view rather than being escaped into literals.
 *
 * `in:inbox` is the default place and not a hard-coded one. Without it Gmail
 * searches all mail, so a page titled Inbox would answer with archived
 * conversations from four years ago; with it forced, `is:starred` would be
 * unable to reach a starred thread that has been filed. So it is added only
 * when the typed query names no place of its own.
 */
function composeQuery(scope: string, typed: string): string {
  const q = typed.trim();
  const place = PLACE_OPERATOR.test(q) ? "" : "in:inbox";
  return [place, scope.trim(), q].filter(Boolean).join(" ");
}

/* ====================================================================== */
/*  Which venture mailbox a thread arrived at                             */
/* ====================================================================== */

/**
 * The domains this portfolio actually receives at, from the Resend keys.
 *
 * Resend is a SENDING service and this is a question about RECEIVING, which
 * looks like the wrong source until you look at the pipe: a venture's domain
 * is on this dashboard because that venture sends from it, and the same domain
 * is what its customers reply to. There is no separate list of "domains whose
 * mail forwards here" anywhere on this box, and inventing one as a hand-kept
 * constant is what workdash does and what this is trying not to inherit.
 */
function inboundDomains(): Set<string> {
  return new Set(chips().chips.filter((m) => m.domain).map((m) => m.domain!));
}

/**
 * Which mailbox a thread arrived at, or null.
 *
 * TWO PASSES, AND THE ORDER IS THE WHOLE FUNCTION. A forwarded message carries
 * the Gmail address in `Delivered-To` on top of the venture address it was
 * really sent to, so a single pass in header order would attribute practically
 * every thread to "gmail". A venture domain anywhere in the thread therefore
 * beats the Gmail address everywhere in it.
 *
 * NULL IS "IT IS NONE OF OURS" HERE, and that is worth stating because it is
 * the narrower of the two readings this field can have. This server always
 * looks — there is no build of it that omits the field — so null means the
 * addresses were read and matched no connected domain and not the mailbox
 * either: a mailing list, a Bcc, a thread that reached the account some other
 * way. It is a real answer rather than a failure, and the page draws no badge
 * for it because a badge reading "Other" two hundred times is a column.
 */
function mailboxOf(
  recipients: string[],
  domains: Set<string>,
  gmailAddress: string | null,
): string | null {
  for (const address of recipients) {
    const domain = address.split("@")[1] ?? "";
    if (domain && domains.has(domain)) return domain;
  }
  const mine = (gmailAddress ?? "").trim().toLowerCase();
  for (const address of recipients) {
    if (mine ? address === mine : /@(gmail|googlemail)\.com$/.test(address))
      return "gmail";
  }
  return null;
}

/* ====================================================================== */
/*  HTML, made safe                                                       */
/* ====================================================================== */

/*
  A SANITISER WRITTEN OUT RATHER THAN INSTALLED.

  The obvious move is a dependency — DOMPurify under jsdom, or sanitize-html.
  It was declined for the reason this whole server has two runtime
  dependencies: jsdom is a browser implementation, it compiles, and it is meant
  to run on the same class of machine as the collectors. A parser that fails to
  install on a Raspberry Pi is a mail client that fails to install on one.

  So this is a rewriter over tags rather than a document parser, and its safety
  argument is that it is ALLOW-LIST rather than deny-list at the point where it
  matters: every attribute is dropped unless it is named below, and every URL
  is dropped unless its scheme is named below. A deny-list ("strip onclick")
  is the version that loses to the next attribute somebody invents.

  IT IS ALSO NOT THE ONLY WALL, and it is not asked to be. The document it
  produces carries `default-src 'none'` — no scripts, no frames, no fetches, no
  fonts but data: — and the page renders it in an iframe sandboxed WITHOUT
  `allow-scripts` and WITHOUT `allow-same-origin`, so script that survived
  every rule below would still have nothing to execute in and no origin to
  execute against. Three independent things have to fail together.
*/

/** Elements dropped WITH their contents. A `<script>` whose body survived into
 *  the output is a script that runs the day somebody renders this outside a
 *  sandbox — the tag and the code go together. */
const DROP_WHOLE =
  /<(script|style|noscript|iframe|frame|frameset|object|embed|applet|template|title)\b[\s\S]*?<\/\1\s*>/gi;
/* `title` is in that list for a duller reason than the rest: mail arrives as a
   whole document and its `<title>` is the subject again. Unwrapped into a body
   it is not a title, it is the subject printed a second time at the top of the
   message — which is how it first rendered. */

/** Elements whose TAG is dropped and whose contents are kept: the document
 *  furniture a fragment must not carry, since this output is spliced into a
 *  document of ours that has its own head. */
const UNWRAP = new Set(["html", "head", "body"]);

/** Elements dropped tag-and-all, with no closing tag to match. `<base>` would
 *  re-point every relative URL in the message; `<link>` and `<meta>` are ways
 *  to fetch or redirect. */
const DROP_EMPTY = new Set(["base", "link", "meta", "form", "input", "button", "textarea", "select", "option"]);

/** The attributes that survive. Everything else — every `on*`, every `srcdoc`,
 *  every `formaction`, and every attribute nobody has thought of yet — is
 *  dropped by not being here. */
const KEEP_ATTR = new Set([
  "href", "src", "alt", "title", "width", "height", "align", "valign",
  "colspan", "rowspan", "border", "cellpadding", "cellspacing", "bgcolor",
  "color", "face", "size", "dir", "lang", "class", "id", "style", "type",
  "start", "target", "rel", "srcset",
]);

/** Attributes carrying a URL, checked against the schemes below rather than
 *  merely kept. */
const URL_ATTR = new Set(["href", "src", "srcset"]);

/** `mailto:` and `tel:` because a mail client that cannot offer to reply to an
 *  address in the body is missing the point; `cid:` because it names an inline
 *  attachment and is hidden rather than fetched; `data:` only for images, and
 *  never for `text/html`, which is a document with a script in it wearing a
 *  URL's clothes. */
function safeUrl(raw: string, attr: string): string | null {
  const value = raw.trim().replace(/[ -]/g, "");
  if (!value) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (!scheme) {
    /* A relative URL in an email resolves against nothing — the frame has no
       base and `base-uri 'none'` in the CSP keeps it that way — so it can only
       ever be a broken request. Dropped rather than emitted as a link that
       goes nowhere. `#anchor` survives because it is an in-document jump. */
    return value.startsWith("#") ? value : null;
  }
  const s = scheme[1]!.toLowerCase();
  if (s === "http" || s === "https" || s === "mailto" || s === "tel") return value;
  if (s === "cid") return attr === "src" ? value : null;
  if (s === "data") return /^data:image\/(png|jpe?g|gif|webp|bmp|x-icon|svg\+xml)[;,]/i.test(value) ? value : null;
  return null;
}

/** Is this a URL that would leave the machine? The image gate is about the
 *  network call, so `data:` and `cid:` are not remote and are never hidden. */
const isRemote = (url: string) => /^https?:/i.test(url);

const escapeAttr = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Inline `style` is kept because mail is styled inline and stripping it makes
 *  every newsletter a column of unstyled text — but a declaration that can
 *  fetch or execute is not styling. `url(...)` goes because it is a network
 *  call the image gate would not see. */
function safeStyle(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/url\s*\([^)]*\)/gi, "none")
    .replace(/expression\s*\(/gi, "void(")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/(javascript|vbscript|data)\s*:/gi, "")
    .trim();
}

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/**
 * The sender's markup, rewritten.
 *
 * Returns the cleaned fragment and how many remote images it found, because
 * "12 images not loaded" is the sentence that turns a hidden picture into a
 * decision the reader can make. A message with no remote images gets no
 * button, which is most personal mail.
 */
function sanitise(html: string, images: boolean): { html: string; remoteImages: number } {
  let remoteImages = 0;

  const stripped = html
    /* Comments first, and before anything else looks at a tag: a conditional
       comment can hide a whole `<script>` from a tag-by-tag rewriter, and
       Outlook's mail is full of them. */
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(DROP_WHOLE, "")
    /* An unclosed `<script>` never matched the pair above. Whatever follows it
       is discarded rather than emitted, because an unterminated script is
       either malformed mail or an attempt to smuggle one past the pair. */
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*$/i, "");

  const out = stripped.replace(TAG, (_whole, close: string, rawName: string, rawAttrs: string, selfClose: string) => {
    const name = rawName.toLowerCase();
    if (UNWRAP.has(name)) return "";
    if (DROP_EMPTY.has(name)) return "";

    if (close) return `</${name}>`;

    const kept: string[] = [];
    let hidden = false;

    for (const m of rawAttrs.matchAll(ATTR)) {
      const attr = m[1]!.toLowerCase();
      if (!KEEP_ATTR.has(attr)) continue;
      let value = m[2] ?? "";
      if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1);

      if (attr === "style") {
        const css = safeStyle(value);
        if (css) kept.push(`style="${escapeAttr(css)}"`);
        continue;
      }

      if (URL_ATTR.has(attr)) {
        if (attr === "srcset") {
          /* A srcset is a comma-separated list of candidates, and one bad
             candidate must not lose the good ones. Rebuilt from the ones that
             pass rather than accepted or rejected whole. */
          const parts = value
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p) => {
              const [url, ...rest] = p.split(/\s+/);
              const safe = url ? safeUrl(url, "src") : null;
              if (!safe) return null;
              if (isRemote(safe)) {
                if (!images) return null;
              }
              return [safe, ...rest].join(" ");
            })
            .filter((p): p is string => p !== null);
          if (parts.length && images) kept.push(`srcset="${escapeAttr(parts.join(", "))}"`);
          continue;
        }

        const safe = safeUrl(value, attr);
        if (!safe) continue;

        if (attr === "src" && isRemote(safe)) {
          remoteImages += 1;
          if (!images) {
            /*
              THE URL IS NOT SENT AT ALL, rather than sent and hidden with CSS.
              A `display:none` image is still an image the browser may fetch,
              and the whole point of the gate is that the sender learns nothing
              about whether this was opened. The element is marked so the
              reader can draw a placeholder where the picture would be.
            */
            hidden = true;
            continue;
          }
        }
        kept.push(`${attr}="${escapeAttr(safe)}"`);
        continue;
      }

      if (attr === "target" || attr === "rel") continue; // set below, not taken
      kept.push(value ? `${attr}="${escapeAttr(value)}"` : attr);
    }

    if (name === "a") {
      /* Every link leaves through a new tab. The frame is sandboxed without
         scripts, so a plain click would navigate the FRAME — the linked site
         loading in the card where the mail just was, which reads as the
         dashboard being replaced. `noreferrer` because the reader of a mail is
         nobody's analytics event. */
      kept.push('target="_blank"', 'rel="noopener noreferrer"');
    }
    if (hidden) kept.push('data-blocked="1"');

    return `<${name}${kept.length ? " " + kept.join(" ") : ""}${selfClose ? " /" : ""}>`;
  });

  return { html: out, remoteImages };
}

/**
 * The cleaned fragment, wrapped in the document the frame actually renders.
 *
 * THE WRAPPER IS BUILT HERE RATHER THAN IN THE BROWSER, and that is the point
 * of it. The Content-Security-Policy is the second of the three walls, and a
 * policy assembled on the client is a policy one refactor away from being
 * assembled wrongly, in a file where nothing would fail loudly if it were. It
 * ships attached to the content it governs.
 *
 * THE CANVAS IS ALWAYS LIGHT, whatever the dashboard's theme. HTML mail is
 * designed against a white page: templates set dark text and leave the
 * background to the client, so a transparent canvas in dark mode renders
 * near-black text on a near-black card. Gmail's own dark mode makes the same
 * call — the message sits on a white sheet inside a dark frame, and it reads
 * as a document rather than as a bug.
 */
function document_(fragment: string, images: boolean): string {
  const img = images ? "img-src https: data:" : "img-src data:";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; ${img}; form-action 'none'; base-uri 'none'; frame-src 'none'; script-src 'none'">
<style>
  :root { color-scheme: light; }
  html { background: #ffffff; }
  body {
    margin: 0; padding: 12px 14px 16px;
    font: 13px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #2a2a2a; background: #ffffff;
    word-break: break-word; -webkit-font-smoothing: antialiased;
  }
  body > :first-child { margin-top: 0; }
  /* A cid: reference that reached here could not be resolved — attachments are
     listed and never fetched — and a broken-image glyph says "this mail is
     damaged" about a message that is fine. */
  img[src^="cid:"] { display: none; }
  /* The placeholder for an image whose URL was never sent. A thin outline
     rather than nothing, so a newsletter reads as a newsletter with its
     pictures withheld rather than as a mail that failed to load. */
  [data-blocked] {
    display: inline-block; min-width: 22px; min-height: 22px;
    border: 1px dashed #d4d4d4; border-radius: 3px; background: #fafafa;
  }
  img, table, video { max-width: 100% !important; }
  img { height: auto; }
  table { border-collapse: collapse; }
  a { color: #2c4894; }
  blockquote { margin: 8px 0; padding-left: 10px; border-left: 2px solid #e2e2e2; color: #6c6c6c; }
  pre, code { font: 11.5px/1.5 ui-monospace, monospace; white-space: pre-wrap; }
</style></head><body>${fragment}</body></html>`;
}

/* ====================================================================== */
/*  Failure, said once                                                    */
/* ====================================================================== */

/**
 * What went wrong, in one sentence somebody can act on.
 *
 * A DEAD GRANT IS THE ONE WORTH SEPARATING. Google answers 401 to a refresh
 * token it has stopped accepting — an app still in Testing issues tokens that
 * expire after seven days — and the symptom is a mailbox that worked all week
 * and is now empty. Rendered as "HTTP 401" that reads as a bug in this page;
 * named, it is one click away from being fixed.
 */
function failure(err: unknown): { status: 401 | 404 | 502 | 503; error: string; fix?: string } {
  if (err instanceof NoMailbox)
    return { status: 404, error: err.message, fix: "/integrations/gmail" };
  if (err instanceof GmailError) {
    if (err.status === 401)
      return {
        status: 401,
        error:
          "Google has stopped accepting this mailbox's grant, so no mail can " +
          "be read until it is renewed. Re-paste the Gmail credentials on the " +
          "Integrations page.",
        fix: "/integrations/gmail",
      };
    if (err.status === 403)
      return { status: 502, error: `Google refused the request — ${err.body}` };
    /* A thread id Gmail will not accept, or one it no longer holds, is a 404
       about a conversation rather than a 502 about a service: nothing is
       broken and retrying will not help. They are separated here because a
       502 sends somebody to check whether the server is up. */
    if (err.status === 404 || err.status === 400)
      return {
        status: 404,
        error:
          "That conversation is not in this mailbox. It may have been deleted, " +
          "or the id may belong to another Google account.",
      };
    return { status: 502, error: `Gmail answered HTTP ${err.status} — ${err.body}` };
  }
  if (err instanceof ResendError) {
    if (err.status === 401)
      return {
        status: 401,
        error: `Resend rejected that key — ${err.body}`,
        fix: "/integrations/resend",
      };
    return { status: 502, error: `Resend answered HTTP ${err.status} — ${err.body}` };
  }
  if (err instanceof Error && err.name === "TimeoutError")
    return { status: 503, error: "The mail provider did not answer in time." };
  return {
    status: 502,
    error: `Could not reach the mail provider (${err instanceof Error ? err.name : "Error"}).`,
  };
}

/** Every route below is one try/catch over the same translation. Written once
 *  so that a new route cannot forget to say what happened. */
async function answered<T>(fn: () => Promise<T>) {
  try {
    return { ok: true as const, value: await fn() };
  } catch (err) {
    return { ok: false as const, ...failure(err) };
  }
}

/** The account a request names, or none. An unparseable `?account=` is treated
 *  as absent rather than refused: it means "the primary", which is what an
 *  absent one means. */
const accountParam = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/* ====================================================================== */
/*  GET /api/mailbox/threads                                              */
/* ====================================================================== */

mailbox.get("/threads", async (c) => {
  const typed = (c.req.query("q") ?? "").slice(0, 500);
  const chip = (c.req.query("mailbox") ?? "").trim().toLowerCase() || null;
  const page = c.req.query("page") ?? undefined;
  const max = Math.min(MAX_PAGE, Math.max(1, Number(c.req.query("limit") ?? PAGE) || PAGE));

  const { gmail } = chips();
  const domains = inboundDomains();

  /* A chip naming nothing we hold falls back to everything rather than to an
     empty list. An empty list reads as "this venture has no mail", which is a
     claim; a typo should not be able to make it. */
  const known = chip === null || chip === "all" || chip === "gmail" || domains.has(chip);
  const mailboxKey = known ? chip : null;

  const result = await answered(async () => {
    const session: Session = await open("mailbox_threads", accountParam(c.req.query("account")));
    const q = composeQuery(scopeFor(mailboxKey, gmail?.address ?? null), typed);
    const listed = await listThreads(session, { q, max, pageToken: page });
    return { session, q, listed };
  });

  if (!result.ok) return c.json({ error: result.error, fix: result.fix }, result.status);

  const { session, q, listed } = result.value;

  return c.json({
    accountId: session.account.id,
    accountLabel: session.account.label,
    address: gmail?.address ?? null,
    /** The query that was actually run, verbatim. It is the one thing that
     *  makes an empty result readable: "no mail" and "the chip and the search
     *  box between them asked for something impossible" look identical
     *  otherwise, and this is also what somebody would paste into Gmail to
     *  check the answer. */
    query: q,
    mailbox: mailboxKey,
    /** Set when the chip named a domain no connected key covers, so the page
     *  can say the filter was ignored rather than quietly widening. */
    mailboxIgnored: chip && !known ? chip : null,
    threads: listed.threads.map((t: ThreadRow) => ({
      id: t.id,
      subject: t.subject,
      from: t.from,
      fromName: t.fromName,
      to: t.to,
      at: t.at,
      snippet: t.snippet,
      unread: t.unread,
      labels: t.labels,
      messages: t.messages,
      mailbox: mailboxOf(t.recipients, domains, gmail?.address ?? null),
    })),
    /** Gmail's own opaque cursor, passed straight through. It is not an
     *  ordinal and cannot be turned into one: an ordinal page would mean
     *  re-walking every page before it on the server, at ten quota units a
     *  thread, to reach a row the browser already knows how to ask for. */
    nextPage: listed.nextPageToken,
    /** Threads that vanished between the listing and the hydration — deleted
     *  mid-request. Named rather than silently shortening the page, because a
     *  page of 23 with a cap of 25 is otherwise unexplainable. */
    dropped: listed.dropped,
    limit: max,
  });
});

/* ====================================================================== */
/*  GET /api/mailbox/threads/:id                                          */
/* ====================================================================== */

mailbox.get("/threads/:id", async (c) => {
  const id = c.req.param("id");
  /**
   * `?images=<message id>` or `?images=all`.
   *
   * PER MESSAGE, AND BY RE-FETCHING. The alternative — sending every URL and
   * letting the browser decide — is the design where "images off" is a CSS
   * rule, and a CSS rule is not a promise that nothing was fetched. Turning
   * images on for one message costs one `threads.get`, which is ten quota
   * units and about a fifth of a second: the right price for a decision the
   * reader makes deliberately and rarely.
   */
  const imagesFor = (c.req.query("images") ?? "").trim();

  const result = await answered(async () => {
    const session = await open("mailbox_thread", accountParam(c.req.query("account")));
    const thread = await readThread(session, id);
    return { session, thread };
  });

  if (!result.ok) return c.json({ error: result.error, fix: result.fix }, result.status);
  const { session, thread } = result.value;
  if (!thread)
    return c.json({ error: "No such thread in this mailbox — it may have been deleted." }, 404);

  const domains = inboundDomains();
  const { gmail } = chips();

  const recipients = new Set<string>();
  for (const m of thread.messages)
    for (const a of [m.to, m.cc].join(",").toLowerCase().matchAll(/[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+/g))
      recipients.add(a[0].replace(/[.,;>]+$/, ""));

  return c.json({
    id: thread.id,
    accountId: session.account.id,
    /** Decided from the messages this route has in hand, by the same rule the
     *  list uses. The reader must not disagree with the row that opened it. */
    mailbox: mailboxOf([...recipients], domains, gmail?.address ?? null),
    subject: thread.messages.map((m) => m.subject).find(Boolean) ?? "",
    messages: thread.messages.map((m: LiveMessage) => {
      const wanted = imagesFor === "all" || imagesFor === m.id;
      const body = m.html ? sanitise(m.html, wanted) : null;
      return {
        id: m.id,
        /** The RFC 5322 header, which is what a reply must reference — Gmail's
         *  own id above threads replies inside this mailbox and means nothing
         *  to the recipient's client. Carried now so that reply, if it is ever
         *  built, does not need a second shape. */
        messageId: m.messageId,
        from: m.from,
        fromName: m.fromName,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        at: m.at,
        unread: m.unread,
        labels: m.labels,
        text: m.text,
        /** A complete document, sanitised, carrying its own CSP. It goes
         *  straight into a sandboxed frame; nothing on the client parses,
         *  rewrites or wraps it. */
        html: body ? document_(body.html, wanted) : null,
        /** How many pictures are being withheld, and whether they are. The
         *  count is what makes the button worth pressing — a message with none
         *  gets no button at all. */
        remoteImages: body?.remoteImages ?? 0,
        imagesLoaded: body ? wanted : false,
        /** Named and sized, never fetched. */
        attachments: m.attachments,
      };
    }),
  });
});

/* ====================================================================== */
/*  POST /api/mailbox/threads/:id/read  — THE ONE WRITE                   */
/* ====================================================================== */

/**
 * Mark a thread read, or unread.
 *
 * THIS IS THE EXCEPTION THE READ-ONLY STANCE HAS TO NAME. Every other route on
 * this server is a read, and `providers/gmail.ts` used to be able to say that
 * about itself as a property of its code. It still nearly can: the function
 * behind this cannot construct a path that is not `/threads/{id}/modify` and
 * cannot construct a body that is not one of two frozen constants naming the
 * UNREAD label. There is no archive here, no trash, no send, and no route that
 * could be extended into one without saying so in the same place this comment
 * is.
 *
 * It is a POST because it changes something. `unread: true` exists because a
 * thread opened by accident should be returnable to the state it was in — a
 * mail client that can only ever consume the unread flag is one you stop
 * trusting to open anything.
 */
mailbox.post("/threads/:id/read", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ unread?: boolean; account?: number }>().catch(() => ({}) as { unread?: boolean; account?: number });
  const unread = body.unread === true;

  const result = await answered(async () => {
    const session = await open("mailbox_mark_read", accountParam(String(body.account ?? "")));
    return modify(session, id, unread);
  });

  if (!result.ok) return c.json({ error: result.error, fix: result.fix }, result.status);
  return c.json({ threadId: result.value.threadId, unread: result.value.unread });
});

/* ====================================================================== */
/*  Sent by apps                                                          */
/* ====================================================================== */

/**
 * What the products sent people.
 *
 * THE SAME LIST AND THE SAME READER, AND NO REPLY. A bounce is half the story
 * and "what did we actually send them" is the other half, which is why this is
 * a mode of the mailbox rather than a page of its own. But there is no reply to
 * a password reset: the From address is a robot, the recipient did not write to
 * it, and a compose box here would be an invitation to answer a machine. So
 * this half has a reader and no composer, deliberately.
 *
 * WITHOUT `?domain=` IT MERGES, AND PAGING IS ONLY OFFERED PER DOMAIN. Each
 * key sees its own domain and nothing else, so the merged view is one page from
 * each and one sort; there is no cursor that would mean anything across ten
 * independent lists, and inventing one — an offset, say — would skip and repeat
 * rows as mail is sent mid-read. Picking a domain is what turns paging on, and
 * the response says so rather than showing a dead "next" button.
 */
mailbox.get("/sent", async (c) => {
  const wanted = (c.req.query("domain") ?? "").trim().toLowerCase() || null;
  const after = c.req.query("page") ?? undefined;
  const all = chips().chips.filter((m) => m.domain);
  const picked = wanted ? all.filter((m) => m.domain === wanted) : all;

  if (wanted && !picked.length)
    return c.json(
      {
        error: `No connected Resend key covers ${wanted}.`,
        domains: all.map((m) => m.domain),
      },
      404,
    );

  const used = picked.slice(0, MERGE_DOMAINS);

  const result = await answered(async () =>
    /*
      ALL AT ONCE, BECAUSE THE PACING IS THE PROVIDER'S JOB AND NOT THIS
      LOOP'S. Sequentially this was ten seconds — ten round trips of about a
      second each, one after another, to draw one list. The provider spaces
      request STARTS a quarter-second apart and lets the responses overlap, so
      firing all ten costs the spacing plus one latency rather than ten
      latencies. It is the same trade the Gmail side makes with its quota gate.

      `Promise.all` and not `allSettled`: one key refusing is a fact about the
      whole answer here — the list would silently be missing a domain — and the
      error translation above says which provider refused and why. A key that
      has merely been restricted to sending is not a refusal and comes back as
      a row in `restricted`.
    */
    Promise.all(used.map((chip) => sentList(chip.accountId, { limit: SENT_PAGE, after }))),
  );

  if (!result.ok) return c.json({ error: result.error, fix: result.fix }, result.status);

  const rows: SentRow[] = result.value.flatMap((p) => p.rows);
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const restricted = result.value
    .map((p, i) => (p.restricted ? (used[i]!.domain ?? p.domain) : null))
    .filter((d): d is string => d !== null);

  return c.json({
    domain: wanted,
    emails: rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      at: r.at,
      from: r.from,
      to: r.to,
      subject: r.subject,
      lastEvent: r.lastEvent,
    })),
    /** Only a single-domain view has a cursor — see the header above. Null in
     *  the merged view is "there is no next page from here", not "there is no
     *  more mail". */
    nextPage:
      wanted && result.value[0]?.hasMore ? (rows[rows.length - 1]?.id ?? null) : null,
    pageable: !!wanted,
    domains: all.map((m) => m.domain),
    domainsRead: used.length,
    /** A key that has been restricted to sending since it was pasted. Its
     *  domain can send and cannot be read, which is a different sentence from
     *  "this domain sent nothing" and is why it is a list rather than silence. */
    restricted,
    truncated: picked.length > used.length ? picked.length - used.length : 0,
  });
});

/**
 * One sent email, body and all.
 *
 * The domain is in the path because an id alone is not enough to fetch it:
 * each key sees only its own domain, so "which key" is part of the address of
 * the resource rather than a hint.
 */
mailbox.get("/sent/:domain/:id", async (c) => {
  const domain = c.req.param("domain").trim().toLowerCase();
  const id = c.req.param("id");
  const images = (c.req.query("images") ?? "") === "1";

  const chip = chips().chips.find((m) => m.domain === domain);
  if (!chip) return c.json({ error: `No connected Resend key covers ${domain}.` }, 404);

  const result = await answered(() => sentEmail(chip.accountId, id));
  if (!result.ok) return c.json({ error: result.error, fix: result.fix }, result.status);

  const { email, restricted } = result.value;
  if (restricted)
    return c.json(
      {
        error:
          `The key for ${domain} is restricted to sending, so what it sent ` +
          "cannot be read back. A Full-access key for this domain would answer.",
        fix: "/integrations/resend",
      },
      403,
    );
  if (!email)
    return c.json(
      {
        error:
          "Resend has no message with that id. Its retention window is not " +
          "forever, so an old row in the list can outlive the body behind it.",
      },
      404,
    );

  const e: SentEmail = email;
  /* Our own template rather than a stranger's markup, and sanitised on exactly
     the same path anyway — see the route header. The one difference is the
     image default: a product's own email is not tracking the person reading it
     here, and its pictures are its logo. It still starts gated, because the
     reader is one component and a second policy in it is a second thing to get
     wrong. */
  const body = e.html ? sanitise(e.html, images) : null;

  return c.json({
    id: e.id,
    domain: e.domain,
    at: e.at,
    from: e.from,
    to: e.to,
    cc: e.cc,
    bcc: e.bcc,
    subject: e.subject,
    lastEvent: e.lastEvent,
    messageId: e.messageId,
    text: e.text,
    html: body ? document_(body.html, images) : null,
    remoteImages: body?.remoteImages ?? 0,
    imagesLoaded: body ? images : false,
    /** Resend returns no attachment bytes and lists no attachments either, so
     *  this is empty rather than absent: the shape matches the Gmail side so
     *  one reader renders both, and the emptiness is a fact about the API. */
    attachments: [] as { filename: string; mimeType: string; size: number | null }[],
  });
});

/* ====================================================================== */
/*  What is deliberately not here                                         */
/* ====================================================================== */

/*
  PRIORITY AND PROMISES ARE NOT BUILT, AND THIS IS THE SHAPE THEY WOULD TAKE.

  Workdash's version of this page has four modes; this has two. The missing two
  are not missing routes — they are missing a MODEL:

    priority   the same inbox, reordered by importance rather than arrival.
               Ranking needs something that can read a thread and judge it, and
               the rule-based fallback workdash carries ("is it from a human,
               does it mention money") is the kind of heuristic that looks like
               a measurement and is not.
    promises   commitments lifted out of the owner's own SENT prose — "I'll
               send that on Friday" — and filed as tasks. Every row is a
               quotation, which means every row is an extraction that can be
               wrong, and a task list you cannot trust is worse than none.

  Both are LLM features and this box has an agent behind /api/chat that could
  answer them. Neither is stubbed here: an endpoint returning an empty list is
  a promise the page has no way to keep, and the mode tab in the client says
  what it would take rather than showing a spinner that never resolves.
*/
