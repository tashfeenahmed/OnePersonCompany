/**
 * LinkedIn — posting as a page or as a member, through the versioned REST API.
 *
 * WHAT THE OWNER PASTES: an access token and an AUTHOR URN. Two fields, and
 * the second is not optional, because LinkedIn has no "post as whoever this
 * token is" endpoint — every post names its author explicitly and a token that
 * administers three pages could mean any of them.
 *
 * THERE IS NO OAUTH DANCE IN THIS APP, DELIBERATELY. workdash runs one: a
 * client id and secret in the vault, an authorise URL the owner opens, a
 * callback on a public host, a state table with a ten-minute TTL. That needs a
 * redirect URI reachable from the internet, and this server binds to loopback.
 * A half-built sign-in that only works behind a tunnel would be worse than
 * none, so the token is pasted — from LinkedIn's own token generator or from
 * whatever exchange the owner already has — and this file says so rather than
 * offering a button that cannot work. The cost is real and is named on the
 * plugin: these tokens expire, typically in sixty days, and this app cannot
 * refresh one it did not mint.
 *
 * `LinkedIn-Version` IS A YYYYMM STRING WITH A HARD SUNSET about a year out,
 * and there is NO implicit default — an absent or expired header is an error
 * on every call rather than an older behaviour. It is pinned here and
 * overridable by an environment variable, exactly as Meta's graph version is,
 * so bumping it is a one-line change rather than a hunt.
 *
 * WHAT IT DOES: text posts and image posts. NOT video. LinkedIn's video
 * register is a different multi-part upload with its own finalise call, and a
 * publisher that half-attempted it would upload a file the API then refuses —
 * which is a worse answer than the sentence the limits file returns.
 *
 * THREE CALLS AND A POLL FOR AN IMAGE, AND THE POLL IS NOT OPTIONAL. The
 * Images API is asynchronous only; a post created against an image that is
 * still PROCESSING renders blank to members. So the image is confirmed
 * AVAILABLE before the post is made, and a poll that runs out refuses the post
 * rather than making a broken one.
 */
import { failed, type PublishOutcome, type Transport } from "./social.ts";
import { liveTransport } from "./social.ts";

export const API = "https://api.linkedin.com";

/** Bumped when LinkedIn sunsets a version. There is no default on their side,
 *  so this is required on every REST call. */
export const LINKEDIN_VERSION = process.env.LINKEDIN_VERSION ?? "202605";

const TIMEOUT_MS = 25_000;

const headers = (token: string, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${token}`,
  "LinkedIn-Version": LINKEDIN_VERSION,
  "X-Restli-Protocol-Version": "2.0.0",
  ...extra,
});

/**
 * The author URN, as LinkedIn writes it.
 *
 * `urn:li:organization:1234567` posts as a company page;
 * `urn:li:person:AbC123` posts as the member. Both are accepted and they are
 * NOT interchangeable — a token with `w_organization_social` cannot post as a
 * person and vice versa — so the shape is checked at paste time and the error
 * says which two shapes exist.
 */
export function parseUrn(raw: string | null | undefined): {
  urn: string | null;
  kind: "organization" | "person" | null;
} {
  const v = (raw ?? "").trim();
  if (/^urn:li:organization:[A-Za-z0-9_-]+$/.test(v)) return { urn: v, kind: "organization" };
  if (/^urn:li:person:[A-Za-z0-9_-]+$/.test(v)) return { urn: v, kind: "person" };
  /* A bare organisation id is the commonest paste — the number in the page's
     admin URL — and turning it into a URN is unambiguous. A bare person id is
     not offered, because a person's id is also alphanumeric and would swallow
     typos of everything else. */
  if (/^\d{3,}$/.test(v)) return { urn: `urn:li:organization:${v}`, kind: "organization" };
  return { urn: null, kind: null };
}

/** LinkedIn's error bodies nest the readable part; a status alone is not a
 *  sentence anybody can act on. Never echoes a whole body — it can carry the
 *  request back. */
function describe(what: string, status: number, body: unknown): string {
  const b = body as { message?: string; error_description?: string; error?: string } | null;
  const msg = b?.message ?? b?.error_description ?? b?.error ?? null;
  return `${what} (${status}${msg ? `: ${String(msg).slice(0, 160)}` : ""})`;
}

/* ------------------------------------------------------------------ verify */

/**
 * Is this token real, and can it post as that author?
 *
 * TWO QUESTIONS, ASKED SEPARATELY. `/rest/organizationAcls` answers whether
 * the token administers anything at all, which is the only cheap read a
 * posting-scoped token is reliably granted. A token for a MEMBER author has no
 * organisation ACLs by definition, so an empty list there is not a refusal —
 * it is checked against `/v2/userinfo` instead, and a token that answers
 * neither is the one that gets refused.
 */
export async function verify(
  values: Record<string, string>,
): Promise<string | null> {
  const token = (values.token ?? "").trim();
  const { urn, kind } = parseUrn(values.author);
  if (!token) return "Paste the access token.";
  if (!urn)
    return (
      "The author is `urn:li:organization:1234567` for a company page or " +
      "`urn:li:person:AbC123` for a member. A bare page id number is accepted too."
    );

  const t = liveTransport();
  if (kind === "organization") {
    try {
      const url = new URL(`${API}/rest/organizationAcls`);
      url.searchParams.set("q", "roleAssignee");
      url.searchParams.set("state", "APPROVED");
      url.searchParams.set("count", "20");
      const res = await t.fetch(url.toString(), {
        headers: headers(token),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => null)) as {
        elements?: { role?: string; organizationTarget?: string; organization?: string }[];
      } | null;
      if (res.status === 401) return "LinkedIn refused the token (401). These expire — mint a new one.";
      if (!res.ok)
        return describe("LinkedIn would not list the pages this token administers", res.status, body);
      const found = (body?.elements ?? []).map((e) => e.organizationTarget ?? e.organization);
      if (found.length && !found.includes(urn))
        return (
          `That token administers ${found.filter(Boolean).slice(0, 3).join(", ")} and not ${urn}. ` +
          "Paste the URN of a page this token can post as."
        );
      /* An EMPTY list with a 200 is not a refusal. `r_organization_admin` is a
         separate product grant from `w_organization_social`, and a token with
         only the second reads nothing here and posts perfectly well. Storing
         it and saying so is the honest outcome. */
      return null;
    } catch (err) {
      return `Could not reach LinkedIn (${err instanceof Error ? err.name : "Error"}).`;
    }
  }

  try {
    const res = await t.fetch(`${API}/v2/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) return "LinkedIn refused the token (401). These expire — mint a new one.";
    if (!res.ok)
      return describe("LinkedIn would not say who this token is", res.status, await res.json().catch(() => null));
    return null;
  } catch (err) {
    return `Could not reach LinkedIn (${err instanceof Error ? err.name : "Error"}).`;
  }
}

/* ------------------------------------------------------------------- probe */

export type LinkedInProbe = {
  ok: boolean;
  author: string | null;
  kind: "organization" | "person" | null;
  /** The pages this token can actually post as, where it was allowed to read
   *  them. Empty with `ok: true` means the read scope is absent, not that
   *  there are none. */
  administers: string[];
  administersKnown: boolean;
  error: string | null;
};

export async function probe(
  values: Record<string, string>,
  t: Transport,
): Promise<LinkedInProbe> {
  const token = (values.token ?? "").trim();
  const { urn, kind } = parseUrn(values.author);
  if (!token || !urn)
    return {
      ok: false,
      author: urn,
      kind,
      administers: [],
      administersKnown: false,
      error: "The token and the author URN are not both stored.",
    };
  try {
    const url = new URL(`${API}/rest/organizationAcls`);
    url.searchParams.set("q", "roleAssignee");
    url.searchParams.set("state", "APPROVED");
    url.searchParams.set("count", "20");
    const res = await t.fetch(url.toString(), {
      headers: headers(token),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as {
      elements?: { organizationTarget?: string; organization?: string }[];
    } | null;
    if (res.status === 401)
      return {
        ok: false,
        author: urn,
        kind,
        administers: [],
        administersKnown: false,
        error: "LinkedIn refused the token (401). These expire; mint a new one and paste it again.",
      };
    if (!res.ok)
      return {
        ok: true,
        author: urn,
        kind,
        administers: [],
        administersKnown: false,
        error: describe("the page list could not be read", res.status, body),
      };
    const administers = (body?.elements ?? [])
      .map((e) => e.organizationTarget ?? e.organization)
      .filter((u): u is string => typeof u === "string");
    return { ok: true, author: urn, kind, administers, administersKnown: true, error: null };
  } catch (err) {
    return {
      ok: false,
      author: urn,
      kind,
      administers: [],
      administersKnown: false,
      error: `Could not reach LinkedIn (${err instanceof Error ? err.name : "Error"}).`,
    };
  }
}

/* ----------------------------------------------------------------- publish */

/** A text-only post. One call. */
export async function postText(
  cred: { token: string; author: string },
  caption: string,
  t: Transport,
): Promise<PublishOutcome> {
  return createPost(cred, caption, null, null, t);
}

/**
 * An image post: initialise, PUT the bytes, wait for AVAILABLE, then post.
 *
 * The upload PUT carries the Bearer token; LinkedIn's VIDEO upload endpoint
 * explicitly does not, which is a trap worth naming here because the two live
 * one paragraph apart in their documentation — and is one more reason video is
 * not implemented in this file rather than approximated.
 */
export async function postImage(
  cred: { token: string; author: string },
  caption: string,
  media: { bytes: Uint8Array; mime: string },
  altText: string | null,
  t: Transport,
): Promise<PublishOutcome> {
  let uploadUrl: string;
  let imageUrn: string;
  try {
    const init = await t.fetch(`${API}/rest/images?action=initializeUpload`, {
      method: "POST",
      headers: headers(cred.token, { "Content-Type": "application/json" }),
      body: JSON.stringify({ initializeUploadRequest: { owner: cred.author } }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await init.json().catch(() => null)) as {
      value?: { uploadUrl?: string; image?: string };
    } | null;
    if (!init.ok || !body?.value?.uploadUrl || !body.value.image)
      return failed(describe("LinkedIn would not start the image upload", init.status, body));
    uploadUrl = body.value.uploadUrl;
    imageUrn = body.value.image;
  } catch (err) {
    return failed(`The image upload did not start (${err instanceof Error ? err.name : "Error"}).`);
  }

  try {
    const put = await t.fetch(uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${cred.token}`, "Content-Type": media.mime },
      body: media.bytes,
      signal: AbortSignal.timeout(120_000),
    });
    if (!put.ok) return failed(`LinkedIn rejected the image bytes (${put.status}).`);
  } catch (err) {
    return failed(`The image bytes did not upload (${err instanceof Error ? err.name : "Error"}).`);
  }

  const ready = await imageReady(cred.token, imageUrn, t);
  if (!ready.ok) return failed(ready.error!);

  return createPost(cred, caption, imageUrn, altText, t);
}

/** WAITING_UPLOAD → PROCESSING → AVAILABLE. A dry transport answers AVAILABLE
 *  at once, so a rehearsal does not spend thirty seconds asleep. */
async function imageReady(
  token: string,
  urn: string,
  t: Transport,
): Promise<{ ok: boolean; error: string | null }> {
  const tries = t.dry ? 1 : 10;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await t.fetch(`${API}/rest/images/${encodeURIComponent(urn)}`, {
        headers: headers(token),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => null)) as
        | { status?: string; elements?: { status?: string }[] }
        | null;
      const status = body?.status ?? body?.elements?.[0]?.status;
      if (status === "AVAILABLE") return { ok: true, error: null };
      if (status === "PROCESSING_FAILED")
        return { ok: false, error: "LinkedIn could not process the image." };
    } catch {
      /* one unanswered poll is not a verdict */
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 3_000));
  }
  return {
    ok: false,
    error: "LinkedIn is still processing the image — nothing was posted. Try again in a minute.",
  };
}

async function createPost(
  cred: { token: string; author: string },
  caption: string,
  imageUrn: string | null,
  altText: string | null,
  t: Transport,
): Promise<PublishOutcome> {
  try {
    const res = await t.fetch(`${API}/rest/posts`, {
      method: "POST",
      headers: headers(cred.token, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        author: cred.author,
        commentary: caption.slice(0, 3_000),
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        ...(imageUrn
          ? {
              content: {
                media: { id: imageUrn, ...(altText ? { altText: altText.slice(0, 120) } : {}) },
              },
            }
          : {}),
        /* The only value accepted on creation. A draft is not a thing this API
           makes, which is why the review step in this app is the app's own. */
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok)
      return failed(describe("LinkedIn refused the post", res.status, await res.json().catch(() => null)));
    /* The post's URN comes back in a HEADER — `x-restli-id` — and is
       `urn:li:share:…` or `urn:li:ugcPost:…` depending on how LinkedIn
       classified it. The permalink takes either verbatim, colons and all, so
       nothing is parsed out of it. */
    const urn = res.headers.get("x-restli-id");
    return {
      ok: true,
      id: urn,
      url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null,
      configured: true,
      error: null,
      note: urn ? null : "Posted; LinkedIn returned no id header, so there is no link.",
    };
  } catch (err) {
    return failed(`The post did not go out (${err instanceof Error ? err.name : "Error"}).`);
  }
}
