/**
 * VIDEOPLUS — three things the video area could not do, added beside it rather
 * than inside it.
 *
 * The `video` area makes two kinds of video: a faceless one out of stock
 * footage, and vertical clips out of somebody else's long video. This area
 * adds the third and fourth — a DIALOGUE WALKTHROUGH of the venture's own
 * pages, and a MOTION-GRAPHICS video built from a structured scene list — and
 * makes the clipping pipeline measure three things it was guessing at: word
 * timings, camera cuts, and where in the frame the subject is.
 *
 * ITS OWN CONFIG PLUGIN AND NOT THE VIDEO ONE. `manifestConfig()` merges every
 * area's `config` BY PLUGIN ID, so an entry here under `video` would REPLACE
 * the video area's own entry and its encoder paths would quietly stop being
 * settable. Two pages under Integrations is the correct cost of that rule.
 *
 * NO CREDENTIAL AND NO COLLECTOR. Everything that needs a key is keyed
 * elsewhere — the script and the scene list are the model provider's, the
 * voices are the voice plugin's, the browser is a binary on this machine — and
 * nothing here is a measurement on a schedule: a video is made when it is
 * asked for. There is no timer either; the video area's autopilot already owns
 * the clock, and a second one would be a second thing spending the same money.
 *
 * NO NEW RUN KIND. `reel` and `motion` are formats of the existing `video`
 * kind, so they inherit its queue, its lease on this machine, its cancellation,
 * its page and its ledger row. A kind of their own would have been four copies
 * of that furniture to change one branch in video/execute.ts.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { upsertPlugin } from "../../db.ts";
import { motionRoutes } from "./routes.ts";
import { stewieRoutes } from "./stewie-routes.ts";
import { WORKDASH_PLUGIN } from "./stewie.ts";
import { VIDEOPLUS_PLUGIN } from "./settings.ts";
import { SKILLS, PACKS } from "./skills.ts";

const path = (value: string): string | null => {
  if (!value.trim()) return null;
  if (!value.trim().startsWith("/"))
    return "An absolute path, please — a relative one would mean something different depending on where the server was started from.";
  return null;
};

const number = (value: string, lo: number, hi: number, what: string, whole = true): string | null => {
  if (!value.trim()) return null;
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n < lo || n > hi || (whole && !Number.isInteger(n))) return `${what}, between ${lo} and ${hi}.`;
  return null;
};

/** The Workdash agent answers its reel document to a good key and 401 to a
 *  bad one, which is the whole check: nothing is started and nothing woken. */
async function verifyWorkdash(values: Record<string, string>): Promise<string | null> {
  const url = (values.url ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) return "The address needs http:// or https:// in front of it — the agent usually listens on http://<pi>:3010.";
  try {
    const res = await fetch(`${url}/agent/reel`, {
      headers: { Authorization: `Bearer ${(values.key ?? "").trim()}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403) return "The agent refused that key. It is the contents of /opt/workdash/service-key on the Pi.";
    if (!res.ok) return `The agent answered ${res.status} rather than its reel document — is that the Workdash agent's address?`;
    return null;
  } catch (err) {
    return `Nothing answered at ${url}: ${err instanceof Error ? err.message : String(err)}. The Pi has to be on the same network as this machine.`;
  }
}

export const manifest: IntegrationManifest = {
  id: "videoplus",

  /*
    THE ONE CREDENTIAL THIS AREA HOLDS, and it is not a model's or a voice's:
    it is the Workdash agent's service key, so the Stewie format can hand a
    reel to the Pi and fetch the file back. One account is one agent; the
    label is the Pi's name.
  */
  plugins: {
    [WORKDASH_PLUGIN]: {
      secret: "workdash",
      fields: ["url", "key"],
      verify: verifyWorkdash,
    },
  },

  config: {
    [VIDEOPLUS_PLUGIN]: {
      keys: {
        /* ------------------------------------------------------- motion */
        motionFps: {
          label: "Motion frames a second",
          hint:
            "How many frames a second the scenes are DRAWN at. The finished " +
            "file is always 30 — ffmpeg repeats frames to get there — so this " +
            "is a render-time cost rather than a look. Twelve is the default " +
            "and reads as smooth on typography. Every eight frames is one " +
            "headless browser launch of about two and a half seconds, so " +
            "doubling this doubles the render.",
          ph: "12",
          check: (v) => number(v, 6, 30, "A whole number of frames"),
        },
        motionScenes: {
          label: "Most scenes in one spec",
          hint:
            "The ceiling on a scene list. A spec with more is CLAMPED to this " +
            "and the extra scenes are dropped from the end, with a sentence " +
            "saying so — never silently. Default 8.",
          ph: "8",
          check: (v) => number(v, 1, 12, "A whole number of scenes"),
        },
        motionSceneSeconds: {
          label: "Longest single scene (seconds)",
          hint:
            "One card of typography past about eight seconds reads as a stall. " +
            "A scene asking for longer becomes this. Default 8.",
          ph: "8",
          check: (v) => number(v, 2, 15, "A number of seconds", false),
        },
        motionSeconds: {
          label: "Longest motion video (seconds)",
          hint:
            "The whole video's ceiling. Scenes past it are dropped from the " +
            "END rather than every scene being squeezed, so the ones that " +
            "survive keep the pacing they were written with. Default 60.",
          ph: "60",
          check: (v) => number(v, 5, 180, "A number of seconds", false),
        },

        /* --------------------------------------------------------- reel */
        reelVoices: {
          label: "Reel voices",
          hint:
            "One voice name per speaking role, comma separated — the host " +
            "first, then the guest. These are names your speech endpoint " +
            "knows (an OpenAI-compatible one takes alloy, echo, fable, onyx, " +
            "nova, shimmer). WITH FEWER THAN TWO NAMES THERE IS ONLY ONE " +
            "VOICE, and rather than pretend otherwise the guest's lines are " +
            "the same voice pitched down about a tone by ffmpeg, with the run " +
            "saying so in a sentence. Piper takes its voice from a model file " +
            "rather than a name, so this does nothing there.",
          ph: "onyx, nova",
          check(value) {
            const n = value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
            return n.length > 4 ? "Two is what a reel uses. More than four is certainly a mistake." : null;
          },
        },
        reelPages: {
          label: "Pages a reel may capture",
          hint:
            "How many of the venture's own addresses one reel screenshots. " +
            "Each is one headless browser launch of a few seconds. Default 4. " +
            "The addresses come from the run's form, or from the venture's " +
            "website when the form is empty — never from the model, which is " +
            "the whole reason this feature cannot be pointed at an arbitrary " +
            "site by something that wrote a script.",
          ph: "4",
          check: (v) => number(v, 1, 8, "A whole number of pages"),
        },
        reelPageHeight: {
          label: "Page capture height (pixels)",
          hint:
            "How much of each page is rendered, and therefore how far the " +
            "walkthrough can scroll: the page is drawn ONCE into a window this " +
            "tall and ffmpeg then pans a 1280×800 crop down that one picture. " +
            "Default 3600, about four screens. THE COST OF A TALL WINDOW is " +
            "that a page whose layout responds to viewport height — a " +
            "full-screen hero, a sticky header, anything using 100vh — is " +
            "drawn as it would look in a window this tall, which is not what a " +
            "visitor sees. Every reel says so on its run.",
          ph: "3600",
          check: (v) => number(v, 1200, 8000, "A whole number of pixels"),
        },

        /* ------------------------------------------------------- shorts */
        whisper: {
          label: "whisper binary",
          hint:
            "A local whisper.cpp CLI, for WORD-LEVEL timings on a video with " +
            "no subtitles. Blank probes /opt/homebrew/bin, /usr/local/bin, " +
            "/usr/bin, /bin, /snap/bin and PATH for whisper-cli, whisper-cpp, " +
            "whisper and main. Without it a shorts job falls back to the " +
            "voice plugin's transcription endpoint, which returns text with NO " +
            "timestamps in it, and the clips say so.",
          ph: "/opt/homebrew/bin/whisper-cli",
          check: (v) => path(v),
        },
        whisperModel: {
          label: "whisper model file",
          hint:
            "The ggml model whisper should load — a file you downloaded on " +
            "purpose. NOTHING HERE FETCHES ONE, and there is no conventional " +
            "place to probe for it, so with this blank there are no word " +
            "timings however many binaries are installed. A `small` or " +
            "`medium` English model is the useful size.",
          ph: "/path/to/ggml-small.bin",
          check: (v) => path(v),
        },
        sceneThreshold: {
          label: "Scene-change threshold",
          hint:
            "How different two frames must be for ffmpeg to call it a cut, " +
            "between 0.15 and 0.9. Default 0.4, which is ffmpeg's own usual " +
            "value. Lower finds more — including slow pans, which are not " +
            "cuts — and the floor is where the boundaries stop being useful.",
          ph: "0.4",
          check: (v) => number(v, 0.15, 0.9, "A number", false),
        },
        tracking: {
          label: "Follow the subject",
          hint:
            "“on” (the default) lets a shorts clip's crop window MOVE with the " +
            "horizontal centre of measured motion instead of sitting in the " +
            "middle of the frame. It is not face detection — there is no " +
            "vision model on this box — and every clip records which of the " +
            "two it got. “off” keeps the fixed centre crop everywhere. A " +
            "letterboxed clip is never tracked: it keeps the whole picture, so " +
            "there is nothing to choose between.",
          ph: "on",
          check(value) {
            const v = value.trim().toLowerCase();
            return !v || v === "on" || v === "off" ? null : "Either “on” or “off”.";
          },
        },
        visionModel: {
          label: "Vision model",
          hint:
            "A local subject or face detector, if you have one. Blank is the " +
            "ordinary case and is what this machine has: with nothing here the " +
            "tracked crop follows measured MOTION, which gets a speaker who " +
            "moves right and a slide changing behind a still speaker wrong. " +
            "The setting exists so that answer can change on a box that has " +
            "one, and so the run can say what is missing rather than quietly " +
            "being the weaker version.",
          ph: "",
          check: (v) => path(v),
        },
      },
      /* CONNECTED MEANS "SOMETHING HERE IS SET", the same reading the video
         plugin next door uses: there are no accounts to derive it from. It is
         not a claim that a motion video can be rendered — GET /api/motion
         answers that, per capability. */
      after(values) {
        upsertPlugin(VIDEOPLUS_PLUGIN, Object.values(values).some((v) => (v ?? "").trim().length > 0), null);
      },
    },
  },

  skills: SKILLS,
  packs: PACKS,

  routes: [
    { path: "/api/motion", app: motionRoutes },
    { path: "/api/stewie", app: stewieRoutes },
  ],
};
