/**
 * TikTok — a video post through the Content Posting API.
 *
 * WHAT THE OWNER PASTES: an access token, and optionally the open id the token
 * belongs to. The open id is only a LABEL here — every call is made as the
 * token — but a portfolio with two TikTok accounts needs something on the page
 * that tells one from the other, and TikTok's own `creator_info` answer gives
 * a nickname rather than an id.
 *
 * NO OAUTH DANCE, for the reason providers/linkedin.ts gives at length: the
 * redirect URI has to be reachable from the internet and this server binds to
 * loopback. The token is pasted, it expires (24 hours for a plain access token,
 * and a refresh needs the client secret and a stored refresh token), and the
 * plugin says so instead of offering a sign-in button that cannot work here.
 *
 * VIDEO ONLY, AND THAT IS A DECISION RATHER THAN AN OMISSION. The photo mode
 * (`/v2/post/publish/content/init/` with `media_type: PHOTO`) exists and needs
 * a second portal grant; more to the point, it is the mode where every
 * limitation below bites twice. So this file publishes a clip and the limits
 * file refuses everything else with that sentence.
 *
 * THE THREE THINGS THAT MAKE A "SUCCESS" NOT ONE, all of them account-side and
 * all of them named on the probe rather than discovered afterwards:
 *
 *   PULL_FROM_URL ONLY. This app hands TikTok a URL and TikTok fetches it,
 *   minutes later, from its own network. The URL's DOMAIN must be verified in
 *   the developer portal under URL properties, or the fetch fails long after
 *   this call reported success. Hence the status poll below, and hence the
 *   publishing area refusing to attempt this at all without a public base URL.
 *
 *   AN UNAUDITED CLIENT MAY ONLY POST PRIVATELY. `creator_info` returns the
 *   privacy levels the account may actually use; an app that has not passed
 *   TikTok's audit is restricted to SELF_ONLY whatever the account's own
 *   settings say. So the levels are READ and the most public one offered is
 *   taken, and the answer says which — a post the owner believes is public and
 *   TikTok made private is exactly the failure this reporting exists to
 *   prevent.
 *
 *   SEND_TO_USER_INBOX IS A REAL TERMINAL STATE. With `video.upload` rather
 *   than `video.publish`, a clip lands in the creator's TikTok inbox for them
 *   to finish and post by hand. That is a success — the file arrived — and it
 *   is NOT a published post, so it is reported with its own sentence and no
 *   permalink.
 *
 * TIKTOK ANSWERS 200 WITH AN ERROR INSIDE THE BODY. `error.code === "ok"` is
 * the only success test; a caller that checked `res.ok` alone would file every
 * refusal as a publish.
 */
import { failed, liveTransport, type PublishOutcome, type Transport } from "./social.ts";

export const API = "https://open.tiktokapis.com";

const TIMEOUT_MS = 30_000;

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json; charset=UTF-8",
});

type TtReply = {
  ok: boolean;
  status: number;
  code: string;
  data: Record<string, unknown> | null;
};

async function post(
  t: Transport,
  path: string,
  token: string,
  body: unknown,
  timeout = TIMEOUT_MS,
): Promise<TtReply> {
  const res = await t.fetch(`${API}${path}`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeout),
  });
  const doc = (await res.json().catch(() => null)) as {
    error?: { code?: string };
    data?: Record<string, unknown>;
  } | null;
  const code = doc?.error?.code ?? (res.ok ? "ok" : String(res.status));
  return { ok: code === "ok", status: res.status, code, data: doc?.data ?? null };
}

/** The error codes worth a sentence rather than a code. Everything else is
 *  reported as the code TikTok sent, because inventing a friendly paraphrase
 *  for an unknown code is how a real cause gets hidden. */
export function reason(code: string, nickname: string | null): string {
  const who = nickname ? ` (${nickname})` : "";
  switch (code) {
    case "unaudited_client_can_only_post_to_private_accounts":
      return `TikTok refused it: this app has not been audited, so it may only post to a PRIVATE account${who}.`;
    case "url_ownership_unverified":
      return "TikTok refused the URL: its domain is not verified in the developer portal — add it under URL properties.";
    case "spam_risk_too_many_posts":
      return "TikTok refused it: too many posts from this account today.";
    case "access_token_invalid":
      return "TikTok rejected the token. These expire in about a day — paste a fresh one.";
    case "scope_not_authorized":
      return "TikTok rejected the scope: the app does not have video.publish granted.";
    default:
      return `TikTok refused the post (${code}).`;
  }
}

/* ------------------------------------------------------------------ verify */

/**
 * `creator_info` is the verification, and it is the same call the publish path
 * makes first.
 *
 * TikTok's own guidelines make querying it part of the posting contract, so
 * using it as the credential check costs nothing extra and proves exactly the
 * thing that matters: this token can be used to post as somebody.
 */
export async function verify(values: Record<string, string>): Promise<string | null> {
  const token = (values.token ?? "").trim();
  if (!token) return "Paste the access token.";
  try {
    const info = await post(liveTransport(), "/v2/post/publish/creator_info/query/", token, {});
    if (info.ok) return null;
    if (info.code === "access_token_invalid" || info.status === 401)
      return "TikTok rejected the token. A plain access token lasts about a day — paste a fresh one.";
    return reason(info.code, null);
  } catch (err) {
    return `Could not reach TikTok (${err instanceof Error ? err.name : "Error"}).`;
  }
}

/* ------------------------------------------------------------------- probe */

export type TikTokProbe = {
  ok: boolean;
  nickname: string | null;
  username: string | null;
  /** The privacy levels this token may actually use. SELF_ONLY alone is the
   *  unaudited-client restriction and is the single most important thing on
   *  this probe. */
  privacyLevels: string[];
  /** TikTok's own ceiling for this account, in seconds. Null when it did not
   *  say — never a guess. */
  maxVideoSeconds: number | null;
  error: string | null;
};

export async function probe(
  values: Record<string, string>,
  t: Transport,
): Promise<TikTokProbe> {
  const token = (values.token ?? "").trim();
  if (!token)
    return {
      ok: false,
      nickname: null,
      username: null,
      privacyLevels: [],
      maxVideoSeconds: null,
      error: "No token is stored.",
    };
  try {
    const info = await post(t, "/v2/post/publish/creator_info/query/", token, {});
    if (!info.ok)
      return {
        ok: false,
        nickname: null,
        username: null,
        privacyLevels: [],
        maxVideoSeconds: null,
        error: reason(info.code, null),
      };
    const data = info.data ?? {};
    const levels = Array.isArray(data.privacy_level_options)
      ? (data.privacy_level_options as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const max = typeof data.max_video_post_duration_sec === "number"
      ? data.max_video_post_duration_sec
      : null;
    return {
      ok: true,
      nickname: typeof data.creator_nickname === "string" ? data.creator_nickname : null,
      username: typeof data.creator_username === "string" ? data.creator_username : null,
      privacyLevels: levels,
      maxVideoSeconds: max,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      nickname: null,
      username: null,
      privacyLevels: [],
      maxVideoSeconds: null,
      error: `Could not reach TikTok (${err instanceof Error ? err.name : "Error"}).`,
    };
  }
}

/** The most public level the account may use, out of what it said it may use.
 *  Pure, so the test can assert that an unaudited account lands on SELF_ONLY
 *  rather than on the first thing in the list. */
export function bestPrivacy(levels: string[]): string {
  const order = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"];
  return order.find((p) => levels.includes(p)) ?? "SELF_ONLY";
}

/* ----------------------------------------------------------------- publish */

/**
 * One clip, pulled by TikTok from a URL this box does not control the fetch of.
 *
 * The status is POLLED rather than assumed, because every account-side failure
 * above happens minutes after the init call has already answered 200.
 */
export async function postVideo(
  cred: { token: string },
  video: { url: string; title: string },
  t: Transport,
): Promise<PublishOutcome> {
  let info: TtReply;
  try {
    info = await post(t, "/v2/post/publish/creator_info/query/", cred.token, {});
  } catch (err) {
    return failed(`Could not reach TikTok (${err instanceof Error ? err.name : "Error"}).`);
  }
  if (!info.ok) return failed(reason(info.code, null), info.code !== "access_token_invalid");

  const nickname =
    typeof info.data?.creator_nickname === "string" ? info.data.creator_nickname : null;
  const levels = Array.isArray(info.data?.privacy_level_options)
    ? (info.data!.privacy_level_options as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const privacy = bestPrivacy(levels);

  let init: TtReply;
  try {
    init = await post(t, "/v2/post/publish/video/init/", cred.token, {
      post_info: {
        title: video.title.slice(0, 90),
        privacy_level: privacy,
        disable_comment: false,
      },
      source_info: { source: "PULL_FROM_URL", video_url: video.url },
    });
  } catch (err) {
    return failed(`Could not reach TikTok (${err instanceof Error ? err.name : "Error"}).`);
  }
  if (!init.ok) return failed(reason(init.code, nickname));

  const publishId = typeof init.data?.publish_id === "string" ? init.data.publish_id : null;
  if (!publishId) return failed("TikTok accepted the post and named no publish id.");

  const settled = await status(cred.token, publishId, t);
  return {
    ok: settled.ok,
    id: publishId,
    /* TikTok returns no post URL, and the documentation specifies no way to
       build one from the id — so none is claimed. */
    url: null,
    configured: true,
    error: settled.ok ? null : settled.error,
    note:
      settled.state === "SEND_TO_USER_INBOX"
        ? "The clip is in the account's TikTok inbox for the owner to finish and post — it is not published."
        : privacy === "SELF_ONLY"
          ? "Posted PRIVATELY: an unaudited TikTok client may only post SELF_ONLY. The account owner makes it public in the app."
          : `Posted with privacy ${privacy}.`,
  };
}

async function status(
  token: string,
  publishId: string,
  t: Transport,
): Promise<{ ok: boolean; state: string | null; error: string | null }> {
  const tries = t.dry ? 1 : 12;
  for (let i = 0; i < tries; i++) {
    if (!t.dry) await new Promise((r) => setTimeout(r, 5_000));
    let s: TtReply;
    try {
      s = await post(t, "/v2/post/publish/status/fetch/", token, { publish_id: publishId });
    } catch {
      continue;
    }
    const state = typeof s.data?.status === "string" ? s.data.status : null;
    if (state === "PUBLISH_COMPLETE" || state === "SEND_TO_USER_INBOX")
      return { ok: true, state, error: null };
    if (state === "FAILED")
      return {
        ok: false,
        state,
        error: `TikTok could not publish it: ${String(s.data?.fail_reason ?? "no reason given").slice(0, 140)}`,
      };
  }
  /* A poll that runs out is "still working", not a failure: the post may well
     land after this stopped watching, and calling it failed would send the
     owner to post it a second time. */
  return {
    ok: false,
    state: null,
    error:
      "TikTok is still fetching the clip. It may still land — check the app in a few minutes " +
      "before retrying, or this will post it twice.",
  };
}
