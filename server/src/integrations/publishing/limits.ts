/**
 * WHAT EACH NETWORK WILL ACTUALLY ACCEPT, CHECKED BEFORE ANYTHING IS SENT.
 *
 * WHY THIS IS A PURE FILE WITH NO IMPORTS. Every rule below is a claim about
 * somebody else's API — a caption ceiling, a media type, a byte cap — and the
 * only honest way to hold a claim like that is where it can be asserted against
 * without a network, a credential or a queue. publishing.test.ts does exactly
 * that. A limit check that could only be exercised by publishing to a real
 * account is a limit check nobody exercises.
 *
 * A REFUSAL HERE IS CHEAPER THAN A REFUSAL THERE, and much more useful. Meta
 * answering "(#100) Invalid parameter" three seconds after an upload started
 * tells the owner nothing about which of the eleven things they might change;
 * "Instagram containers accept JPEG and this post's picture is a PNG" tells
 * them exactly one thing to do. So the pipeline runs these first and never
 * treats a pass here as a promise that the platform will agree — the platform
 * is still the judge, and its refusal is recorded verbatim when it comes.
 *
 * WHERE THE NUMBERS COME FROM, and where they are deliberately conservative:
 *
 *   FACEBOOK PAGE  A post's message field is documented at 63,206 characters.
 *                  Photos go up as multipart on /photos; videos on /videos.
 *                  The byte caps here (25 MB image, 1 GB video) are BELOW
 *                  Facebook's own documented ceilings on purpose — a 3 GB
 *                  upload over a domestic line is not a thing this box should
 *                  start without the owner having said so, and the refusal
 *                  names the cap as this app's rather than Meta's.
 *   INSTAGRAM      2,200 characters, at most 30 hashtags, and the container
 *                  endpoint takes `image_url` — a PUBLIC URL it fetches
 *                  itself, JPEG only. PNG is the trap: the Studio renders PNG
 *                  because a browser and a backup both open one, and an IG
 *                  container handed a PNG fails at Meta's fetcher minutes
 *                  later. That is caught here as a sentence rather than there
 *                  as a 400.
 *   LINKEDIN       `commentary` is documented at 3,000 characters. Images go
 *                  through the Images API as PNG, JPEG or GIF. Video is a
 *                  different multi-step register and is NOT implemented — see
 *                  publish.ts — so a video for LinkedIn is refused here with
 *                  that sentence rather than half-attempted.
 *   TIKTOK         Title 90 characters, description 4,000. This app posts
 *                  VIDEO ONLY through the Content Posting API: the photo mode
 *                  exists and needs a second set of portal permissions, and an
 *                  unaudited client is restricted to a private post whatever
 *                  the account is — both facts belong on the destination's
 *                  probe, not in a silent success.
 *
 * NOTHING HERE IS A SETTING. These are other companies' rules; a box where the
 * owner could raise Instagram's caption ceiling would be a box that fails at
 * Instagram instead of here.
 */

/** The four places a publish item can go. One plugin (meta) serves two. */
export type DestinationKind = "page" | "ig" | "linkedin" | "tiktok";

export const DESTINATION_KINDS: DestinationKind[] = ["page", "ig", "linkedin", "tiktok"];

/** What the item is carrying. `none` is a caption with no picture, which only
 *  Facebook and LinkedIn accept — the other two are media networks. */
export type MediaKind = "image" | "video" | "none";

export type Limits = {
  kind: DestinationKind;
  label: string;
  /** The caption ceiling, in characters. */
  caption: number;
  /** Hashtags allowed in the caption, or null where the network does not cap
   *  them separately. */
  hashtags: number | null;
  /** Media this app can send to this destination. An empty list would mean a
   *  destination that can take nothing, which none of these is. */
  media: MediaKind[];
  /** Image mime types the network's own endpoint accepts. */
  imageTypes: string[];
  /** This app's cap on an image, in bytes. */
  imageBytes: number;
  /** This app's cap on a video, in bytes. Null where video is not implemented
   *  for this destination at all. */
  videoBytes: number | null;
  /** True when the network fetches the media from a URL rather than taking
   *  bytes — which makes a publicly reachable base URL a precondition. */
  needsPublicUrl: boolean;
  /** The one sentence a page shows under the destination. */
  note: string;
};

const MB = 1024 * 1024;

export const LIMITS: Record<DestinationKind, Limits> = {
  page: {
    kind: "page",
    label: "Facebook Page",
    caption: 63_206,
    hashtags: null,
    media: ["image", "video", "none"],
    imageTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
    imageBytes: 25 * MB,
    videoBytes: 1024 * MB,
    needsPublicUrl: false,
    note:
      "Bytes go up as multipart, so nothing has to be publicly reachable. " +
      "A photo posts to /photos and a video to /videos; a caption on its own " +
      "posts to /feed.",
  },
  ig: {
    kind: "ig",
    label: "Instagram business account",
    caption: 2_200,
    hashtags: 30,
    media: ["image"],
    /* JPEG ONLY, and this is the single most common way an Instagram publish
       fails silently. The container endpoint takes a URL and fetches it
       asynchronously; a PNG is accepted by the create call and refused by the
       fetcher afterwards, which surfaces as a container that never becomes a
       post. */
    imageTypes: ["image/jpeg"],
    imageBytes: 8 * MB,
    videoBytes: null,
    needsPublicUrl: true,
    note:
      "Instagram fetches the picture from a URL it can reach, so this needs a " +
      "public base URL. JPEG only, and Reels are not implemented here.",
  },
  linkedin: {
    kind: "linkedin",
    label: "LinkedIn page or member",
    caption: 3_000,
    hashtags: null,
    media: ["image", "none"],
    imageTypes: ["image/png", "image/jpeg", "image/gif"],
    imageBytes: 10 * MB,
    videoBytes: null,
    needsPublicUrl: false,
    note:
      "The image is uploaded as bytes and confirmed AVAILABLE before the post " +
      "is made. Video is a separate multi-step register and is not implemented.",
  },
  tiktok: {
    kind: "tiktok",
    /* The title is what TikTok calls the caption on a video post; the
       description field only exists on the photo mode this app does not use. */
    label: "TikTok account",
    caption: 90,
    hashtags: null,
    media: ["video"],
    imageTypes: [],
    imageBytes: 0,
    videoBytes: 512 * MB,
    needsPublicUrl: true,
    note:
      "Video only, pulled by TikTok from a public URL, so this needs a public " +
      "base URL whose domain is verified in the TikTok developer portal. An " +
      "unaudited client may only post privately.",
  },
};

/** How many hashtags a caption carries. The same rule the Studio's splitter
 *  uses: a `#word`, anywhere in the text. */
export function countHashtags(caption: string): number {
  return (caption.match(/#[\wÀ-ɏ]+/g) ?? []).length;
}

export type MediaFacts = {
  kind: MediaKind;
  /** The mime this app believes the file is, from its magic bytes rather than
   *  from its extension — see assets.ts's `sniff`. */
  mime?: string | null;
  bytes?: number | null;
  /** Whether a publicly reachable URL for this media exists. Null means the
   *  question was not asked, which is only ever true in a unit test. */
  publicUrl?: string | null;
};

export type LimitProblem = {
  /** What the check was about, so a page can group them. */
  field: "caption" | "media" | "hashtags" | "public-url";
  /** One sentence, addressed to the owner, naming the fix. */
  message: string;
};

/**
 * Everything wrong with sending THIS to THERE, in one pass.
 *
 * EVERY problem rather than the first one: a caption that is too long for
 * Instagram and a picture that is a PNG are two edits, and returning one of
 * them means the owner fixes it, presses again, and is told about the other.
 *
 * An empty list is not a promise that the post will go out. It is this app
 * having nothing left to object to.
 */
export function checkLimits(
  kind: DestinationKind,
  post: { caption: string | null; media: MediaFacts },
): LimitProblem[] {
  const limits = LIMITS[kind];
  const problems: LimitProblem[] = [];
  const caption = post.caption ?? "";

  if (!caption.trim() && post.media.kind === "none")
    problems.push({
      field: "caption",
      message: "There is nothing to post — no caption and no media.",
    });

  if (caption.length > limits.caption)
    problems.push({
      field: "caption",
      message:
        `The caption is ${caption.length} characters and ${limits.label} takes ` +
        `${limits.caption}. Shorten it by ${caption.length - limits.caption}.`,
    });

  if (limits.hashtags !== null) {
    const n = countHashtags(caption);
    if (n > limits.hashtags)
      problems.push({
        field: "hashtags",
        message: `${n} hashtags; ${limits.label} allows ${limits.hashtags}.`,
      });
  }

  if (!limits.media.includes(post.media.kind))
    problems.push({
      field: "media",
      message:
        post.media.kind === "none"
          ? `${limits.label} will not take a caption with no media.`
          : `A ${post.media.kind} is not supported for this destination — ${limits.note}`,
    });
  else if (post.media.kind === "image") {
    if (post.media.mime && !limits.imageTypes.includes(post.media.mime))
      problems.push({
        field: "media",
        message:
          `${limits.label} accepts ${limits.imageTypes.join(", ")} and this picture is ` +
          `${post.media.mime}. Convert it, or send this post somewhere that takes it.`,
      });
    if (typeof post.media.bytes === "number" && post.media.bytes > limits.imageBytes)
      problems.push({
        field: "media",
        message:
          `The picture is ${Math.round(post.media.bytes / MB)} MB and this app's cap ` +
          `for ${limits.label} is ${Math.round(limits.imageBytes / MB)} MB.`,
      });
  } else if (post.media.kind === "video") {
    if (limits.videoBytes === null)
      problems.push({
        field: "media",
        message: `Video is not supported for this destination — ${limits.note}`,
      });
    else if (typeof post.media.bytes === "number" && post.media.bytes > limits.videoBytes)
      problems.push({
        field: "media",
        message:
          `The clip is ${Math.round(post.media.bytes / MB)} MB and this app's cap ` +
          `for ${limits.label} is ${Math.round(limits.videoBytes / MB)} MB.`,
      });
  }

  if (limits.needsPublicUrl && post.media.kind !== "none" && post.media.publicUrl === null)
    problems.push({
      field: "public-url",
      message:
        `${limits.label} fetches the media itself, so this box has to be able to hand ` +
        "it a URL. Set `publicBaseUrl` under Integrations → Publishing to a base URL " +
        "that reaches this API from the internet.",
    });

  return problems;
}
