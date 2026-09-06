/**
 * THE SCENE SPEC — the whole of what a motion-graphics video is, as data.
 *
 * A motion video here is not a script and it is not a prompt. It is a SHORT
 * STRUCTURED DOCUMENT: five to eight scenes, each of a known kind, each with
 * the two or three strings and one number that kind needs. Everything about
 * how it LOOKS — the colours, the typeface, the animation — comes from the
 * venture's own measured brand and from templates.ts, and none of it is in
 * here. That split is the point of the file: the owner edits meaning, the
 * templates own appearance, and neither can break the other.
 *
 * THE VALIDATOR CLAMPS RATHER THAN ARGUES, which is ported from workdash's
 * motion spec reader and is the right shape for a document a model writes. A
 * heading of two hundred characters becomes eighty; a nine-item list becomes
 * six; a scene of four seconds where the ceiling is three becomes three. What
 * it will NOT do is guess: a scene of a kind no template exists for is the one
 * hard refusal, because a spec asking for a "quote" scene that got rendered as
 * a "title" scene would be this box silently making a different video from the
 * one it was asked for.
 *
 * EVERY REJECTION IS A SENTENCE AND THEY ARE ALL RETURNED. The editor page
 * shows them beside the JSON, so "why did my six-item list come back with
 * five" has an answer on the screen rather than in a diff.
 *
 * NUMBERS ARE STRINGS AND THE UNIT IS ITS OWN FIELD. `value: "42"` and
 * `unit: "%"` rather than `value: 42`, because the things people put on a stat
 * card are `3.2`, `12k`, `2×` and `£19` as often as they are integers, and a
 * number type would either refuse those or silently reformat them. What the
 * validator DOES insist on is that a stat's value contains a digit — a stat
 * card whose big number is a word is not a stat card — and it says so.
 *
 * NOTHING HERE INVENTS A FIGURE. A `stat` scene is a claim about a business,
 * and this file has no way to check one. The rule lives in the skill's rules
 * and in the writer's prompt; what this file contributes is that the number
 * and its label are separate fields, so a reader can always see which part of
 * a stat card is the measurement and which part is the sentence around it.
 */

export const SCENE_KINDS = ["title", "stat", "compare", "list", "cta"] as const;
export type SceneKind = (typeof SCENE_KINDS)[number];

/** One side of a comparison. `points` may be empty — a side with a label and a
 *  value and nothing else is a legitimate before/after. */
export type Side = { label: string; value: string; points: string[] };

export type SceneBase = {
  seconds: number;
  /** The small uppercase label above the scene, or null. */
  kicker: string | null;
  /** What a narrator would say over this scene, or null for a silent one.
   *  Written even when speech is off, because it is also the best description
   *  of what the scene is FOR and it goes on the run page. */
  say: string | null;
};

export type Scene =
  | (SceneBase & { kind: "title"; title: string; subtitle: string | null })
  | (SceneBase & { kind: "stat"; value: string; unit: string | null; label: string; note: string | null })
  | (SceneBase & { kind: "compare"; heading: string | null; left: Side; right: Side })
  | (SceneBase & { kind: "list"; heading: string; items: string[] })
  | (SceneBase & { kind: "cta"; headline: string; action: string; url: string | null });

export type SceneSpec = {
  title: string;
  aspect: string;
  /** A hex colour that overrides the venture's own for this video, or null to
   *  use whatever the brand reader measured. It is the ONE appearance field a
   *  spec may carry, because "make this one red" is a thing about this video
   *  and not a thing about the business. */
  accent: string | null;
  /** Whether the render should ask the voice plugin to speak each scene's
   *  `say`. Off means a silent video, which is the ordinary case here. */
  voiceover: boolean;
  scenes: Scene[];
};

/* ------------------------------------------------------------------ limits */

export type SpecLimits = {
  maxScenes: number;
  minSceneSeconds: number;
  maxSceneSeconds: number;
  maxTotalSeconds: number;
};

/**
 * The defaults, and every one of them is also a setting.
 *
 * EIGHT SCENES AND SIXTY SECONDS ARE THE BRAKE THAT MATTERS. A render is
 * roughly two and a half seconds of headless Chrome per eight frames — see
 * motion.ts — so a spec is a bill for this laptop's CPU and the owner should
 * be able to see the size of it before pressing anything. A spec over the
 * ceiling is CLAMPED rather than refused, for execute.ts's reason: by the time
 * anything reads this the run has usually been queued already.
 */
export const DEFAULT_LIMITS: SpecLimits = {
  maxScenes: 8,
  minSceneSeconds: 1.5,
  maxSceneSeconds: 8,
  maxTotalSeconds: 60,
};

/**
 * How long a scene runs when the spec does not say.
 *
 * Ported from workdash's motion driver, which learned them by watching:
 * a list needs time per item, a stat needs a beat for the number to land, a
 * call to action is read in three seconds and holding it longer reads as a
 * stall.
 */
export function defaultSeconds(kind: SceneKind, items = 0): number {
  switch (kind) {
    case "list":
      return Math.min(8, 1.6 + 0.9 * Math.max(1, items));
    case "compare":
      return 4.5;
    case "stat":
      return 3.4;
    case "cta":
      return 3;
    default:
      return 3.2;
  }
}

/* ------------------------------------------------------------------ reading */

const str = (v: unknown, cap: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, cap) : null;
};

const strings = (v: unknown, cap: number, most: number): string[] =>
  Array.isArray(v) ? (v.map((x) => str(x, cap)).filter((x): x is string => !!x)).slice(0, most) : [];

const HEX = /^#[0-9a-fA-F]{6}$/;

export type SpecRead = { spec: SceneSpec | null; problems: string[] };

/**
 * A scene spec, read out of whatever arrived.
 *
 * `problems` IS NOT AN ERROR LIST — it is a list of the things this function
 * CHANGED, plus the scenes it dropped. A spec that came back with eight
 * problems and a usable object is a spec that will render; a spec that came
 * back with `spec: null` is one that could not be made into anything, and
 * there are only three ways that happens: it is not an object, it has no
 * scenes at all, or every scene it had was dropped.
 */
export function readSceneSpec(raw: unknown, limits: SpecLimits = DEFAULT_LIMITS): SpecRead {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { spec: null, problems: ["A scene spec is one JSON object with a `scenes` array in it. This is not an object."] };
  const o = raw as Record<string, unknown>;

  const rawScenes = Array.isArray(o.scenes) ? o.scenes : [];
  if (!rawScenes.length)
    return { spec: null, problems: ["The spec has no `scenes`. A motion video is its scene list; there is nothing here to render."] };
  if (rawScenes.length > limits.maxScenes)
    problems.push(
      `${rawScenes.length} scenes were given and the ceiling is ${limits.maxScenes}, so the last ${rawScenes.length - limits.maxScenes} were dropped. Raise \`motionScenes\` under the Video extras settings if you meant it.`,
    );

  const scenes: Scene[] = [];
  for (const [i, entry] of rawScenes.slice(0, limits.maxScenes).entries()) {
    const read = readScene(entry, i + 1, limits, problems);
    if (read) scenes.push(read);
  }
  if (!scenes.length)
    return { spec: null, problems: [...problems, "Every scene in the spec was dropped, so there is nothing left to render."] };

  /* THE TOTAL IS TRIMMED FROM THE END rather than shrunk proportionally.
     Squeezing every scene to fit would change the pacing of scenes the owner
     had already timed; dropping the tail leaves the ones that survive exactly
     as written, and the report says which went. */
  let total = 0;
  const kept: Scene[] = [];
  for (const s of scenes) {
    if (total + s.seconds > limits.maxTotalSeconds) {
      problems.push(
        `Scene ${kept.length + 1} onwards would take the video past ${limits.maxTotalSeconds}s, which is the ceiling, so ${scenes.length - kept.length} scene(s) were dropped from the end.`,
      );
      break;
    }
    total += s.seconds;
    kept.push(s);
  }
  if (!kept.length)
    return { spec: null, problems: [...problems, `The first scene alone is longer than the ${limits.maxTotalSeconds}s ceiling.`] };

  const accentRaw = str(o.accent, 9);
  let accent: string | null = null;
  if (accentRaw) {
    if (HEX.test(accentRaw)) accent = accentRaw.toLowerCase();
    else problems.push(`\`accent\` must be a six-digit hex colour like #3b82f6. “${accentRaw}” is not one, so the venture's own colour is used.`);
  }

  const aspectRaw = str(o.aspect, 8) ?? "9:16";
  const aspect = ["9:16", "1:1", "16:9"].includes(aspectRaw) ? aspectRaw : "9:16";
  if (aspect !== aspectRaw) problems.push(`\`aspect\` “${aspectRaw}” is not one of 9:16, 1:1 or 16:9, so 9:16 was used.`);

  return {
    spec: {
      title: str(o.title, 120) ?? "Untitled",
      aspect,
      accent,
      voiceover: o.voiceover === true || o.voiceover === "true",
      scenes: kept,
    },
    problems,
  };
}

function readScene(raw: unknown, n: number, limits: SpecLimits, problems: string[]): Scene | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push(`Scene ${n} is not an object and was dropped.`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const kindRaw = str(o.kind, 20)?.toLowerCase() ?? "";
  if (!SCENE_KINDS.includes(kindRaw as SceneKind)) {
    /* THE ONE HARD REFUSAL. See the header. */
    problems.push(
      `Scene ${n} is of kind “${kindRaw || "(none)"}”, and there is no template for that. The kinds are ${SCENE_KINDS.join(", ")}. It was dropped rather than rendered as something else.`,
    );
    return null;
  }
  const kind = kindRaw as SceneKind;
  const kicker = str(o.kicker, 40);
  const say = str(o.say, 300);

  const items = kind === "list" ? strings(o.items, 90, 6) : [];
  const wanted = Number(o.seconds);
  let seconds = Number.isFinite(wanted) && wanted > 0 ? wanted : defaultSeconds(kind, items.length);
  const clamped = Math.min(limits.maxSceneSeconds, Math.max(limits.minSceneSeconds, seconds));
  if (Math.abs(clamped - seconds) > 0.01)
    problems.push(`Scene ${n} asked for ${seconds}s; scenes here run between ${limits.minSceneSeconds}s and ${limits.maxSceneSeconds}s, so it is ${clamped}s.`);
  seconds = Math.round(clamped * 100) / 100;
  const base = { seconds, kicker, say };

  if (kind === "title") {
    const title = str(o.title, 120);
    if (!title) {
      problems.push(`Scene ${n} is a title scene with no \`title\`, so it was dropped.`);
      return null;
    }
    return { ...base, kind, title, subtitle: str(o.subtitle, 140) };
  }

  if (kind === "stat") {
    const value = str(o.value, 12);
    const label = str(o.label, 90);
    if (!value || !label) {
      problems.push(`Scene ${n} is a stat scene and needs both a \`value\` and a \`label\`. It was dropped.`);
      return null;
    }
    if (!/\d/.test(value))
      problems.push(`Scene ${n}'s \`value\` (“${value}”) has no digit in it. It will be set in the big number position anyway, which is probably not what you want.`);
    return { ...base, kind, value, unit: str(o.unit, 10), label, note: str(o.note, 120) };
  }

  if (kind === "compare") {
    const left = readSide(o.left, "Before");
    const right = readSide(o.right, "After");
    if (!left || !right) {
      problems.push(`Scene ${n} is a compare scene and needs a \`left\` and a \`right\`, each with a \`label\` and a \`value\`. It was dropped.`);
      return null;
    }
    return { ...base, kind, heading: str(o.heading, 90), left, right };
  }

  if (kind === "list") {
    const heading = str(o.heading, 90);
    if (!heading || !items.length) {
      problems.push(`Scene ${n} is a list scene and needs a \`heading\` and at least one item. It was dropped.`);
      return null;
    }
    if (Array.isArray(o.items) && o.items.length > 6)
      problems.push(`Scene ${n}'s list had ${o.items.length} items; six is what fits on a phone, so the rest were dropped.`);
    return { ...base, kind, heading, items };
  }

  const headline = str(o.headline, 90);
  const action = str(o.action, 60);
  if (!headline || !action) {
    problems.push(`Scene ${n} is a call to action and needs a \`headline\` and an \`action\`. It was dropped.`);
    return null;
  }
  let url = str(o.url, 120);
  if (url && !/^https?:\/\/\S+$/i.test(url)) {
    problems.push(`Scene ${n}'s \`url\` (“${url}”) is not an http address, so it was left off the card.`);
    url = null;
  }
  return { ...base, kind: "cta", headline, action, url };
}

function readSide(raw: unknown, fallbackLabel: string): Side | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const value = str(o.value, 40);
  if (!value) return null;
  return { label: str(o.label, 30) ?? fallbackLabel, value, points: strings(o.points, 70, 3) };
}

/** The length of a spec, in seconds. The client shows it beside the editor so
 *  a spec's cost is visible before the render is pressed. */
export const specSeconds = (spec: SceneSpec): number =>
  Math.round(spec.scenes.reduce((n, s) => n + s.seconds, 0) * 100) / 100;

/** One line per scene, for a report or a log. Not a preview — the preview is
 *  the first frame of each scene, which is a different route. */
export function specLines(spec: SceneSpec): string[] {
  return spec.scenes.map((s, i) => {
    const head =
      s.kind === "title"
        ? s.title
        : s.kind === "stat"
          ? `${s.value}${s.unit ?? ""} — ${s.label}`
          : s.kind === "compare"
            ? `${s.left.label} ${s.left.value} vs ${s.right.label} ${s.right.value}`
            : s.kind === "list"
              ? `${s.heading}: ${s.items.join(" · ")}`
              : `${s.headline} → ${s.action}`;
    return `${i + 1}. **${s.kind}** (${s.seconds}s) — ${head}`;
  });
}
