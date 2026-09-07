/**
 * WHERE A WATCHED PERSON'S LINKS ACTUALLY GO.
 *
 * ---------------------------------------------------------------------------
 * THE BOX SAYS "GITHUB" AND WHAT PEOPLE TYPE INTO IT IS A HANDLE ABOUT AS
 * OFTEN AS IT IS A URL. `janedoe`, `@janedoe`, `github.com/janedoe` and
 * `https://github.com/janedoe` are four spellings of one fact, and a card that
 * hung an `href` off the raw string would send three of those four to a page
 * on this app. So there is one function that turns a stored string into an
 * address, and every surface that draws a link — the person card, the file
 * header, the hint under the form box — goes through it.
 *
 * FOUR READINGS, IN THIS ORDER, AND THE ORDER IS THE WHOLE RULE:
 *
 *   1. A full URL is used EXACTLY as given. Somebody who pasted an address
 *      knows where they want to go, and no prefix of ours improves it.
 *   2. A value with a `/` in it is a URL missing its scheme —
 *      `github.com/janedoe`, `youtube.com/@her` — so it gets `https://` and
 *      nothing else. Prefixing that with a site base is how
 *      `github.com/github.com/janedoe` happens.
 *   3. A value that IS the site's own domain, or a subdomain of it, is the
 *      same case one segment shorter: `janedoe.substack.com` is an address,
 *      not a handle to hang off `.substack.com` a second time.
 *   4. Anything else is a handle, with a leading `@` dropped, put where that
 *      site puts handles. Which for Substack is a SUBDOMAIN and for Hacker
 *      News is a query parameter — the reason this is a function per site
 *      rather than a table of prefixes.
 *
 * BLUESKY IS THE EXCEPTION THAT DECIDES RULE 3'S SHAPE. A Bluesky handle IS a
 * domain — `tomasberg.se` — so "looks like a domain" cannot be the test for
 * "is a URL". Only the site's OWN host counts, which is why each site carries
 * one rather than this file guessing from the dots.
 *
 * A WEBSITE OR AN RSS BOX HAS NO HANDLE FORM at all, so it stops at rule 2:
 * `example.com/feed.xml` gets `https://` and a relative path is never
 * produced. `example.com` as a bare `href` would be a link to a page on this
 * app, which is the one reading that takes somebody somewhere wrong.
 *
 * NO IMPORTS, EVER — the same rule `@/lib/format` and `components/org/dossiers`
 * keep, and for the same reason: this is a leaf a node test can strip the
 * types from and run, and it is the piece of this feature most worth a test.
 */

/** The nine places a watched person can be read. The server accepts exactly
 *  these keys and no others; a tenth is a change on both sides of the wire. */
export type LinkKey =
  | "website"
  | "github"
  | "x"
  | "linkedin"
  | "bluesky"
  | "hn"
  | "rss"
  | "substack"
  | "youtube";

export type LinkSite = {
  key: LinkKey;
  /** What the chip and the form box are labelled. */
  label: string;
  /** The site's own host, for rule 3. Empty for the two boxes that take any
   *  host at all — a website and a feed. */
  host: string;
  /** A bare handle, as an address. Null for the boxes that have no handle
   *  form, which is how rule 4 knows to stop. */
  handle: ((handle: string) => string) | null;
  /** What the empty box says. The shape of the thing, not a slogan. */
  hint: string;
};

export const LINK_SITES: LinkSite[] = [
  { key: "website", label: "Website", host: "", handle: null, hint: "https://example.com" },
  {
    key: "github",
    label: "GitHub",
    host: "github.com",
    handle: (h) => `https://github.com/${h}`,
    hint: "janedoe",
  },
  { key: "x", label: "X", host: "x.com", handle: (h) => `https://x.com/${h}`, hint: "@janedoe" },
  {
    key: "linkedin",
    label: "LinkedIn",
    host: "linkedin.com",
    handle: (h) => `https://www.linkedin.com/in/${h}`,
    hint: "jane-doe",
  },
  {
    key: "bluesky",
    label: "Bluesky",
    host: "bsky.app",
    handle: (h) => `https://bsky.app/profile/${h}`,
    hint: "jane.bsky.social",
  },
  {
    key: "hn",
    label: "Hacker News",
    host: "news.ycombinator.com",
    /* A user page is a QUERY, not a path segment, which is the whole reason
       this table holds functions rather than prefixes. */
    handle: (h) => `https://news.ycombinator.com/user?id=${encodeURIComponent(h)}`,
    hint: "janedoe",
  },
  { key: "rss", label: "RSS", host: "", handle: null, hint: "https://example.com/feed.xml" },
  {
    key: "substack",
    label: "Substack",
    host: "substack.com",
    /* A SUBDOMAIN rather than a path. `janedoe` is janedoe.substack.com. */
    handle: (h) => `https://${h}.substack.com`,
    hint: "janedoe",
  },
  {
    key: "youtube",
    label: "YouTube",
    host: "youtube.com",
    handle: (h) => `https://www.youtube.com/@${h}`,
    hint: "@janedoe",
  },
];

const BY_KEY = new Map(LINK_SITES.map((s) => [s.key as string, s]));

/** The label for a key, or the key itself for one this client has not heard
 *  of — a link the server knows about is still a link worth drawing. */
export function linkLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key;
}

/**
 * A stored string, as somewhere to go — or null when the box was left empty.
 *
 * Null rather than "" or "#", because every caller's next move is to decide
 * whether to draw a chip at all, and a chip that goes nowhere is worse than no
 * chip. Whitespace is empty: a box containing a space is a box nobody filled.
 */
export function hrefFor(key: string, value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  /* 1. Already an address. */
  if (/^https?:\/\//i.test(raw)) return raw;
  /* A scheme this client will not open — `javascript:`, `data:` — is not a
     link, it is an attempt at one. Refused rather than rewritten, because
     `https://javascript:alert(1)` would be a chip that looks fine. */
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;

  const site = BY_KEY.get(key);
  const handle = raw.replace(/^@+/, "");
  /* 2. A path means they typed a URL and left the scheme off. */
  if (raw.includes("/")) return `https://${raw}`;
  /* 3. The site's own host, one segment short of a URL. */
  if (site?.host && (handle === site.host || handle.endsWith(`.${site.host}`)))
    return `https://${handle}`;
  /* 4. A handle, where that site puts handles — and for a website, a feed, or
        a key this client does not know, a bare host. */
  return site?.handle ? site.handle(handle) : `https://${raw}`;
}
