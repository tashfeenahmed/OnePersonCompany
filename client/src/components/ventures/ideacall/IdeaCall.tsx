import { useEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "@/lib/theme";
import { integrations } from "@/lib/api/integrations";
import { ideaCallApi, type IdeaCallTool, type IdeaCallTurn, type IdeaCallUpdate } from "@/lib/api/ideaCall";
import { mountOrb, type OrbHandle, type OrbVoice } from "./orb";
import { sentence, splitSay, threadLayout, updatedCaption } from "./thread";
import "./idea-call.css";

/**
 * THE IDEA CALL — a full-screen conversation about one venture's idea.
 *
 * It is a phone call, not a chat window, and every decision here follows from
 * that. There is no scrollbar and no bubble list: one column of large type,
 * one turn in focus, the rest falling away by distance. An orb above it shows
 * what the other end is doing — breathing, speaking, listening, or throwing its
 * own surface into an orbit while it looks something up. Hanging up files what
 * was settled into the idea page, which is the only thing the call leaves
 * behind.
 *
 * WHY THE ANIMATION IS NOT IN REACT STATE. The thread animates per WORD, the
 * orb per frame, and every message's height has to be measured out of the
 * document and fed back into a layout equation. Driving that through render
 * would be hundreds of commits a second over a tree of measured DOM, and each
 * one would fight the CSS transitions that do the actual work. So the column is
 * built with `document.createElement` and direct style writes, held in refs,
 * exactly as the design's prototype does it; React owns the chrome around it —
 * the header, the dock, the caption — and nothing that moves at 60fps.
 *
 * WHY THE CALL CARRIES ITS OWN THEME. It is the one surface in this app that
 * covers the whole screen and holds attention for minutes at a time, and the
 * room somebody takes a call in is not the room they browse a dashboard in. So
 * the header has a sun/moon that flips THIS call and nothing else: it starts
 * from the app's resolved theme and is forgotten when the call ends, because a
 * preference set for one conversation is not a preference set for the product.
 *
 * WHY A PORTAL. It is fixed, inset-0 and above everything; rendered in place it
 * would inherit a transformed or clipped ancestor somewhere up the dashboard
 * and stop being full-screen for reasons no one could find later.
 */

type Props = {
  venture: { id: string; name: string };
  onClose: (changed: boolean) => void;
};

/* The design's pacing, kept to the millisecond. 82ms a word is the speed a
   sentence reads at when you are also listening to it. */
const AI_WORD_MS = 82;
/* Your own words are already yours — they land faster, because re-reading what
   you just said at dictation speed is a wait with nothing at the end of it. */
const ME_WORD_MS = 46;
/* The blur-to-sharp rise is a 1s animation; the last word needs its own second
   before the turn is "done" and the orb stops speaking. */
const RISE_TAIL_MS = 700;
/* After the orbit folds back into the pearl, a beat before the answer. */
const SETTLE_MS = 900;
const VOICE_KEY = "opc-idea-call-voice";
const FONT_ID = "idea-call-font";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- speech in */

/**
 * The Web Speech API is not in `lib.dom` (only its event types are), and it is
 * prefixed everywhere but Safari's own spelling. So the shape it is used
 * through is declared here rather than pulled in as a dependency, and the
 * constructor is looked up once: a browser without it gets a disabled mic
 * button and an open text field, not a button that does nothing.
 */
type SpeechRec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type RecognitionCtor = new () => SpeechRec;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** A plain English voice, preferring one that lives on the machine. */
function pickVoice(): SpeechSynthesisVoice | null {
  const all = window.speechSynthesis?.getVoices() ?? [];
  const english = all.filter((v) => v.lang.toLowerCase().startsWith("en"));
  if (!english.length) return null;
  const named = english.find((v) => /samantha|daniel|karen|google us english/i.test(v.name));
  return named ?? english.find((v) => v.localService) ?? english[0] ?? null;
}

/* ------------------------------------------------------------------ fonts */

/**
 * Instrument Serif is this design and nothing else in the app uses it, so it is
 * not in the bundle's font stack — it is fetched the first time a call opens
 * and then left in the document. Ids rather than a flag: two calls in one
 * session, or a second copy of this component, must not append it twice, and
 * the check has to survive a hot reload that threw the module's own state away.
 */
function ensureFont() {
  if (document.getElementById(FONT_ID)) return;
  const pre = (href: string, cors: boolean, id: string) => {
    if (document.getElementById(id)) return;
    const l = document.createElement("link");
    l.id = id;
    l.rel = "preconnect";
    l.href = href;
    if (cors) l.crossOrigin = "";
    document.head.appendChild(l);
  };
  pre("https://fonts.googleapis.com", false, `${FONT_ID}-pre1`);
  pre("https://fonts.gstatic.com", true, `${FONT_ID}-pre2`);
  const link = document.createElement("link");
  link.id = FONT_ID;
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap";
  document.head.appendChild(link);
}

/* ------------------------------------------------------------------- glyphs */
/* The design's own strokes rather than the icon set's: everything in this
   surface is hairline-thin at a size the library's icons are not drawn for. */

const XMark = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5.5 5.5l13 13M18.5 5.5l-13 13" />
  </svg>
);
const Sun = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="4.4" />
    <path d="M12 2.6v2.4M12 19v2.4M2.6 12h2.4M19 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M18.7 5.3L17 7M7 17l-1.7 1.7" />
  </svg>
);
const Moon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z" />
  </svg>
);
const SpeakerOn = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 9.4h3.4L12 5.4v13.2l-4.6-4H4z" />
    <path d="M15.6 9.2a4 4 0 0 1 0 5.6M18.2 6.6a7.6 7.6 0 0 1 0 10.8" />
  </svg>
);
const SpeakerOff = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 9.4h3.4L12 5.4v13.2l-4.6-4H4z" />
    <path d="M16 10l4 4M20 10l-4 4" />
  </svg>
);
const MicGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
    <path d="M12 18v3.5" />
  </svg>
);
const KeyGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2.5" y="6" width="19" height="12" rx="2.6" />
    <path d="M6.2 9.8h.01M9.7 9.8h.01M13.2 9.8h.01M16.7 9.8h.01M6.2 13h.01M9.7 13h.01M13.2 13h.01M16.7 13h.01M8.6 15.6h6.8" />
  </svg>
);

/* --------------------------------------------------------------- the call */

type Msg = {
  el: HTMLDivElement;
  inner: HTMLDivElement;
  body: HTMLDivElement;
  /** Natural height at full size. The layout equation's only input. */
  h: number;
  /** What is currently written, so a live transcript can be extended in place. */
  words: string[];
};

export function IdeaCall({ venture, onClose }: Props): JSX.Element {
  const app = useTheme();
  const [theme, setTheme] = useState<"light" | "dark">(() => app.resolved);
  const [voiceOn, setVoiceOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem(VOICE_KEY) !== "off";
    } catch {
      /* private window or blocked storage: speaking aloud is the default */
      return true;
    }
  });
  const [recCtor] = useState<RecognitionCtor | null>(() => recognitionCtor());
  /* WHO IS ON THE LINE. Said quietly in the header, with the reason on hover
     when it is not the workspace's own model — see `callProvider` on the
     server. An idea spoken to a box in the cupboard and one sent to a gateway
     are different things. */
  const [answering, setAnswering] = useState<{ label: string; reason: string | null } | null>(null);
  const [fieldOpen, setFieldOpen] = useState(() => recognitionCtor() === null);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [behind, setBehind] = useState(false);
  const [noOrb, setNoOrb] = useState(false);
  const [dockLive, setDockLive] = useState(false);
  const [captionText, setCaptionText] = useState("");
  const [captionDots, setCaptionDots] = useState(true);
  const [captionOn, setCaptionOn] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const colRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const nodesRef = useRef<Msg[]>([]);
  const focusRef = useRef(0);
  const followRef = useRef(true);
  const orbRef = useRef<OrbHandle | null>(null);
  const reducedRef = useRef(false);

  const ttsRef = useRef(false);
  const voiceOnRef = useRef(voiceOn);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recRef = useRef<SpeechRec | null>(null);
  const liveMsgRef = useRef<Msg | null>(null);

  const busyRef = useRef(false);
  const inflightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(new Map<string, string>());
  const settleRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  /* Bumped by a barge-in or a hang-up. Everything queued carries the epoch it
     was queued in and simply does not run if the call has moved on since. */
  const epochRef = useRef(0);
  const endedRef = useRef(false);
  const finishingRef = useRef(false);
  const changedRef = useRef(false);
  const baseCaptionRef = useRef<{ text: string; dots: boolean } | null>(null);
  const flashRef = useRef<number | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /* ------------------------------------------------------------- caption */

  function paintCaption() {
    if (flashRef.current !== null) return; // a flash owns the line for its 4s
    const b = baseCaptionRef.current;
    if (!b) {
      setCaptionOn(false);
      return;
    }
    setCaptionText(b.text);
    setCaptionDots(b.dots);
    setCaptionOn(true);
  }

  function setBaseCaption(v: { text: string; dots: boolean } | null) {
    baseCaptionRef.current = v;
    paintCaption();
  }

  /** "Updated · Problem, First customer" and its kind: said once, then gone. */
  function flashCaption(text: string) {
    if (flashRef.current !== null) clearTimeout(flashRef.current);
    setCaptionText(text);
    setCaptionDots(false);
    setCaptionOn(true);
    flashRef.current = window.setTimeout(() => {
      flashRef.current = null;
      paintCaption();
    }, 4000);
  }

  /* -------------------------------------------------------------- thread */

  function layout(instant = false) {
    const col = colRef.current;
    const thread = threadRef.current;
    const main = mainRef.current;
    if (!col || !thread || !main) return;
    const list = nodesRef.current;
    if (!list.length) return;

    const out = threadLayout(
      list.map((m) => m.h),
      focusRef.current,
      main.clientHeight,
    );
    focusRef.current = out.focus;
    list.forEach((m, i) => {
      m.el.style.setProperty("--s", String(out.scales[i] ?? 1));
      m.el.style.opacity = String(out.opacities[i] ?? 1);
    });
    if (instant) thread.style.transition = "none";
    thread.style.transform = `translateY(${out.y}px)`;
    if (instant) {
      void thread.getBoundingClientRect();
      thread.style.transition = "";
    }
    setBehind(out.behind);
  }

  function remeasure(m: Msg) {
    const s = Number.parseFloat(m.el.style.getPropertyValue("--s")) || 1;
    m.h = m.inner.offsetHeight / s;
    m.el.style.setProperty("--h", String(m.h));
  }

  function createMsg(kind: "me" | "ai", dim = false): Msg {
    const el = document.createElement("div");
    el.className = kind === "me" ? "ic-msg ic-me" : "ic-msg";
    if (dim) el.dataset.dim = "1";
    el.style.setProperty("--h", "0");
    el.style.setProperty("--s", "1");
    el.style.opacity = "0";
    const inner = document.createElement("div");
    inner.className = "ic-inner";
    const body = document.createElement("div");
    body.className = "ic-body";
    inner.appendChild(body);
    el.appendChild(inner);
    colRef.current?.appendChild(el);
    const m: Msg = { el, inner, body, h: 0, words: [] };
    nodesRef.current.push(m);
    return m;
  }

  /** Commit the zero-height start, then measure and let the message open. */
  function reveal(m: Msg) {
    void threadRef.current?.getBoundingClientRect();
    remeasure(m);
    if (followRef.current) focusRef.current = nodesRef.current.length - 1;
    layout();
  }

  function appendWord(body: HTMLElement, w: string, delay: number, animate: boolean) {
    const s = document.createElement("span");
    s.className = "ic-w";
    s.textContent = w;
    if (animate) s.style.animationDelay = `${Math.round(delay)}ms`;
    else {
      s.style.animation = "none";
      s.style.opacity = "1";
      s.style.filter = "none";
      s.style.transform = "none";
    }
    body.appendChild(s);
    /* A real text node, not a margin: the line has to be able to break here. */
    body.appendChild(document.createTextNode(" "));
  }

  /** Words land one at a time. Returns how long the last one waits. */
  function writeWords(m: Msg, text: string, step: number, animate: boolean): number {
    m.body.textContent = "";
    m.words = text.split(/\s+/).filter(Boolean);
    let d = 0;
    for (const w of m.words) {
      appendWord(m.body, w, d, animate);
      d += step;
    }
    return d;
  }

  /**
   * A live transcript grows a word at a time and occasionally rewrites its own
   * tail when the recogniser changes its mind. Only the changed tail is
   * replaced, so the words already standing do not flash back through the blur.
   */
  function renderLive(m: Msg, text: string) {
    const ws = text.split(/\s+/).filter(Boolean);
    let same = 0;
    while (same < ws.length && same < m.words.length && ws[same] === m.words[same]) same++;
    while (m.body.childNodes.length > same * 2) m.body.lastChild?.remove();
    for (let i = same; i < ws.length; i++) appendWord(m.body, ws[i] ?? "", 0, !reducedRef.current);
    m.words = ws;
  }

  /** A turn that is already history: no rise, no pacing, just there. */
  function addInstant(kind: "me" | "ai", text: string, dim = false): Msg {
    const m = createMsg(kind, dim);
    writeWords(m, dim ? text : sentence(text), 0, false);
    return m;
  }

  function refit() {
    const list = nodesRef.current;
    if (!list.length) return;
    const root = rootRef.current;
    root?.classList.add("ic-noanim");
    const saved = list.map((m) => m.el.style.getPropertyValue("--s"));
    for (const m of list) m.el.style.setProperty("--s", "1");
    void threadRef.current?.getBoundingClientRect();
    for (const m of list) {
      m.h = m.inner.offsetHeight;
      m.el.style.setProperty("--h", String(m.h));
    }
    list.forEach((m, i) => m.el.style.setProperty("--s", saved[i] ?? "1"));
    layout(true);
    requestAnimationFrame(() => root?.classList.remove("ic-noanim"));
  }

  function stepFocus(dir: number) {
    const n = nodesRef.current.length;
    if (!n) return;
    const next = Math.max(0, Math.min(n - 1, focusRef.current + dir));
    if (next === focusRef.current) return;
    focusRef.current = next;
    followRef.current = next === n - 1;
    layout();
  }

  function toLive() {
    followRef.current = true;
    focusRef.current = nodesRef.current.length - 1;
    layout();
  }

  /* --------------------------------------------------------------- voice */

  const setOrbVoice = (v: OrbVoice) => orbRef.current?.setVoice(v);

  function stopSpeech() {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.onended = null;
      a.onerror = null;
      audioRef.current = null;
    }
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* a browser without speech synthesis has nothing to cancel */
    }
  }

  /**
   * One paragraph, out loud. The box's own speech endpoint when it has one —
   * a real voice beats the browser's every time — and the browser's otherwise,
   * which is why a failure here falls through rather than throwing: losing the
   * audio must never lose the words.
   */
  async function speakAloud(text: string): Promise<void> {
    if (!voiceOnRef.current || endedRef.current) return;
    if (ttsRef.current) {
      try {
        const clip = await integrations.speak(text);
        if (!voiceOnRef.current || endedRef.current) return;
        const audio = new Audio(clip.url);
        audioRef.current = audio;
        await new Promise<void>((done) => {
          audio.onended = () => done();
          audio.onerror = () => done();
          void audio.play().catch(() => done());
        });
        return;
      } catch {
        /* the endpoint is off or down: the browser still has a voice */
      }
    }
    const synth = window.speechSynthesis;
    if (!synth || !voiceOnRef.current || endedRef.current) return;
    await new Promise<void>((done) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice();
      if (v) u.voice = v;
      u.lang = v?.lang ?? "en-US";
      u.rate = 1.02;
      u.onend = () => done();
      u.onerror = () => done();
      synth.speak(u);
    });
  }

  /* --------------------------------------------------------------- queue */

  function enqueue(task: () => Promise<void>) {
    const epoch = epochRef.current;
    queueRef.current = queueRef.current
      .then(() => (epoch === epochRef.current && !endedRef.current ? task() : undefined))
      .catch(() => undefined);
  }

  /** Nothing is said over a search. Wait for the orbit to fold back in first. */
  async function waitForTools() {
    while (runningRef.current.size > 0 && !endedRef.current) await sleep(120);
    const left = settleRef.current - performance.now();
    if (left > 0) await sleep(left);
  }

  async function sayParagraph(text: string) {
    const epoch = epochRef.current;
    await waitForTools();
    if (epoch !== epochRef.current || endedRef.current) return;

    setBaseCaption(null);
    const m = createMsg("ai");
    const span = writeWords(m, sentence(text), AI_WORD_MS, !reducedRef.current);
    reveal(m);
    setOrbVoice("speak");

    const spoken = voiceOnRef.current ? speakAloud(text) : null;
    await sleep(reducedRef.current ? 380 : span + RISE_TAIL_MS);
    /* The clip usually outlasts the words. Stay "speaking" until it is done,
       but never hang the call on an audio element that will not fire. */
    if (spoken) await Promise.race([spoken, sleep(30_000)]);
    if (epoch !== epochRef.current) return;
    setOrbVoice("idle");
    await sleep(reducedRef.current ? 120 : 620);
  }

  function dimLine(text: string) {
    followRef.current = true;
    const m = addInstant("ai", text, true);
    reveal(m);
  }

  /* ---------------------------------------------------------- one turn */

  async function runTurn(message: string | null) {
    if (busyRef.current || endedRef.current) return;
    const epoch = epochRef.current;
    busyRef.current = true;
    setBusy(true);
    inflightRef.current = true;
    const ctl = new AbortController();
    abortRef.current = ctl;
    /* No orbit for plain waiting — the throw means "it is looking something
       up", and spending it on every pause would make it mean nothing. */
    setBaseCaption({ text: "Thinking", dots: true });

    try {
      await ideaCallApi.turn(
        venture.id,
        message,
        {
          onTool: (t: IdeaCallTool) => handleTool(t),
          onUpdated: (u: IdeaCallUpdate) => handleUpdated(u),
          onSay: (t: IdeaCallTurn) => handleSay(t),
          onError: (m: string) => enqueue(async () => dimLine(m)),
        },
        ctl.signal,
      );
    } catch (err) {
      if (!ctl.signal.aborted && epoch === epochRef.current) {
        const text = err instanceof Error ? err.message : String(err);
        enqueue(async () => dimLine(text));
      }
    } finally {
      if (epoch === epochRef.current) {
        inflightRef.current = false;
        busyRef.current = false;
        setBusy(false);
        abortRef.current = null;
        if (!runningRef.current.size) setBaseCaption(null);
      }
    }
  }

  function handleTool(t: IdeaCallTool) {
    const running = runningRef.current;
    if (t.status === "running") {
      running.set(t.id, t.label);
      setOrbVoice("search");
      orbRef.current?.setSearching(true);
      setBaseCaption({ text: t.label, dots: true });
      return;
    }
    running.delete(t.id);
    if (running.size) {
      const next = [...running.values()][0];
      if (next) setBaseCaption({ text: next, dots: true });
      return;
    }
    orbRef.current?.setSearching(false);
    setOrbVoice("idle");
    settleRef.current = performance.now() + SETTLE_MS;
    setBaseCaption(inflightRef.current ? { text: "Thinking", dots: true } : null);
  }

  function handleUpdated(u: IdeaCallUpdate) {
    const line = updatedCaption(u);
    if (!line) return;
    changedRef.current = true;
    flashCaption(line);
  }

  function handleSay(t: IdeaCallTurn) {
    /* One reply, paced as the design paces it: short paragraphs, each waiting
       for the one before it to finish landing. */
    for (const part of splitSay(t.text)) enqueue(() => sayParagraph(part));
  }

  /* ------------------------------------------------------------- sending */

  /**
   * A barge-in. Whatever was being said or fetched stops now, because the owner
   * talking over the assistant is the assistant being wrong, and making them
   * wait out a paragraph they have already answered is the rudest thing a call
   * can do.
   */
  function bargeIn() {
    epochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    stopSpeech();
    runningRef.current.clear();
    settleRef.current = 0;
    orbRef.current?.setSearching(false);
    setOrbVoice("idle");
    setBaseCaption(null);
    inflightRef.current = false;
    busyRef.current = false;
    setBusy(false);
  }

  function submit(text: string, live: Msg | null) {
    const clean = sentence(text);
    if (!clean || endedRef.current) return;
    followRef.current = true;
    if (live) {
      renderLive(live, clean);
      reveal(live);
    } else {
      const m = createMsg("me");
      writeWords(m, clean, ME_WORD_MS, !reducedRef.current);
      reveal(m);
    }
    void runTurn(clean);
  }

  /* ----------------------------------------------------------- listening */

  function stopRecognition(abort = false) {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    try {
      if (abort) rec.abort();
      else rec.stop();
    } catch {
      /* already stopped: the onend handler has run or will not run */
    }
  }

  function startListening() {
    if (!recCtor || endedRef.current) return;
    bargeIn(); // never listen over our own voice

    const Recognition = recCtor;
    let rec: SpeechRec;
    try {
      rec = new Recognition();
    } catch {
      return;
    }
    rec.interimResults = true;
    rec.continuous = false;
    rec.lang = navigator.language || "en-US";
    recRef.current = rec;
    liveMsgRef.current = null;

    let settled = "";
    let refused = false;

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const alt = r?.[0];
        if (!r || !alt) continue;
        if (r.isFinal) settled = `${settled} ${alt.transcript}`.trim();
        else interim = `${interim} ${alt.transcript}`.trim();
      }
      const shown = `${settled} ${interim}`.trim();
      if (!shown) return;
      const live = (liveMsgRef.current ??= createMsg("me"));
      renderLive(live, shown);
      /* It grows while it is spoken, so its height is never the same twice. */
      reveal(live);
    };

    rec.onerror = (e: { error: string }) => {
      if (e.error !== "not-allowed" && e.error !== "service-not-allowed") return;
      refused = true;
      dimLine("Microphone permission was refused. Type instead.");
      setFieldOpen(true);
    };

    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      setOrbVoice("idle");
      const live = liveMsgRef.current;
      liveMsgRef.current = null;
      const heard = settled.trim() || live?.words.join(" ").trim() || "";
      if (refused || endedRef.current || !heard) return;
      submit(heard, live);
    };

    try {
      rec.start();
    } catch {
      recRef.current = null;
      return;
    }
    setListening(true);
    setOrbVoice("listen");
  }

  /* -------------------------------------------------------------- hang up */

  async function hangUp() {
    /* A second press while the write-up runs means "just go". */
    if (finishingRef.current) {
      closeRef.current(changedRef.current);
      return;
    }
    finishingRef.current = true;
    endedRef.current = true;
    epochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    stopSpeech();
    stopRecognition(true);
    runningRef.current.clear();
    orbRef.current?.setSearching(false);
    setOrbVoice("idle");
    setListening(false);
    setFieldOpen(false);
    setBusy(false);
    busyRef.current = false;
    dimLine("Call ended.");
    setBaseCaption({ text: "Writing up the call", dots: true });

    let filed = false;
    try {
      const out = await ideaCallApi.finish(venture.id);
      filed = out.fields.length > 0 || out.competitors.length > 0 || out.names.length > 0;
    } catch {
      /* The call is over either way; a failed write-up is not worth a dialog. */
    }
    setBaseCaption(null);
    closeRef.current(changedRef.current || filed);
  }

  /* -------------------------------------------------------------- effects */

  /* The font, the scroll lock and the reduced-motion answer: once, on mount. */
  useEffect(() => {
    ensureFont();
    reducedRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const body = document.body;
    const prev = body.style.overflow;
    body.style.overflow = "hidden";
    dockRef.current?.focus();
    return () => {
      body.style.overflow = prev;
    };
  }, []);

  /* Everything that is still making noise when the component goes away. */
  useEffect(
    () => {
      /* SET ON THE WAY IN AS WELL AS CLEARED ON THE WAY OUT. StrictMode mounts,
         unmounts and mounts again in development; a flag only ever set by the
         cleanup left the second mount believing the call had already ended,
         and it never opened the line or sent a word. */
      endedRef.current = false;
      busyRef.current = false;
      return () => {
      endedRef.current = true;
      epochRef.current += 1;
      abortRef.current?.abort();
      stopSpeech();
      stopRecognition(true);
      if (flashRef.current !== null) clearTimeout(flashRef.current);
      };
    },
    [],
  );

  /* The orb. Mounted once; the theme reaches it through a setter, because
     tearing down a WebGL context to change a colour is a black flash. */
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const orb = mountOrb(canvas, wrap, { light: theme === "light" });
    orbRef.current = orb;
    let alive = true;
    void orb.ready.then((ok) => {
      if (alive && !ok) setNoOrb(true);
    });
    return () => {
      alive = false;
      orb.dispose();
      orbRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    orbRef.current?.setLight(theme === "light");
  }, [theme]);

  useEffect(() => {
    voiceOnRef.current = voiceOn;
    if (!voiceOn) stopSpeech();
    try {
      localStorage.setItem(VOICE_KEY, voiceOn ? "on" : "off");
    } catch {
      /* nothing to remember it with; the choice still holds for this call */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceOn]);

  /* Open the line: prior turns first, instantly, then the assistant's greeting
     or its pick-up from where the last call stopped. */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const doc = await ideaCallApi.read(venture.id);
        if (!alive) return;
        ttsRef.current = doc.voice.tts;
        setAnswering(doc.answering);
        /* Earlier replies are cut into the same paragraphs they were spoken
           in. One turn as one block can be taller than the whole thread, and
           the focus layout has nowhere to put a message it cannot fit. */
        for (const t of doc.turns) {
          if (t.role === "user") addInstant("me", t.text);
          else for (const part of splitSay(t.text)) addInstant("ai", part);
        }
        focusRef.current = Math.max(0, nodesRef.current.length - 1);
        refit();
        if (!doc.ready) {
          dimLine(doc.note ?? "No model is connected, so the call cannot be answered.");
          return;
        }
        setDockLive(true);
        void runTurn(null);
      } catch (err) {
        if (!alive) return;
        /* The dock stays live on a failed read: the server may be back by the
           time they type, and a dead call with no way to try again is worse
           than a call that answers with an error line. */
        setDockLive(true);
        dimLine(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venture.id]);

  /* Moving the focus: wheel, drag, arrows. All on the element rather than in
     JSX because the wheel has to be non-passive to swallow the page's scroll. */
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    let accum = 0;
    let last = 0;
    let touchY: number | null = null;

    const guard = (dir: number) => {
      const now = performance.now();
      if (now - last < 190) return;
      last = now;
      stepFocus(dir);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      accum += e.deltaY;
      if (Math.abs(accum) < 42) return;
      const dir = accum > 0 ? 1 : -1;
      accum = 0;
      guard(dir);
    };
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (touchY === null || y === undefined) return;
      const dy = touchY - y;
      if (Math.abs(dy) < 40) return;
      touchY = y;
      guard(dy > 0 ? 1 : -1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        /* Escape closes the field. It does NOT end the call: hanging up files
           the conversation, and a stray key press must not do that. */
        e.stopPropagation();
        setFieldOpen(false);
        inputRef.current?.blur();
        return;
      }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (document.activeElement === inputRef.current && inputRef.current?.value) return;
      e.preventDefault();
      guard(e.key === "ArrowDown" ? 1 : -1);
    };

    main.addEventListener("wheel", onWheel, { passive: false });
    main.addEventListener("touchstart", onTouchStart, { passive: true });
    main.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      main.removeEventListener("wheel", onWheel);
      main.removeEventListener("touchstart", onTouchStart);
      main.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* The column is measured in pixels, so anything that changes what a pixel of
     this type is has to re-measure it: a resize, and the web font arriving. */
  useEffect(() => {
    const on = () => refit();
    window.addEventListener("resize", on);
    let timer = 0;
    void document.fonts?.ready.then(() => {
      timer = window.setTimeout(on, 60);
    });
    return () => {
      window.removeEventListener("resize", on);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------------- view */

  const micTitle = recCtor
    ? listening
      ? "Stop and send"
      : "Talk"
    : "Voice input is not supported in this browser — use the keyboard";

  return createPortal(
    <div
      ref={rootRef}
      className={`idea-call${behind ? " ic-behind" : ""}`}
      data-theme={theme}
      data-orb={noOrb ? "off" : "on"}
      role="dialog"
      aria-modal="true"
      aria-label="Refine idea call"
    >
      <header className="ic-head">
        <div className="ic-head-left">
          <button
            type="button"
            className="ic-icon ic-quiet"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            aria-label={theme === "dark" ? "Light theme for this call" : "Dark theme for this call"}
            title={theme === "dark" ? "Light" : "Dark"}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </button>
          <button
            type="button"
            className="ic-icon ic-quiet"
            onClick={() => setVoiceOn((v) => !v)}
            aria-pressed={voiceOn}
            aria-label={voiceOn ? "Stop speaking the answers aloud" : "Speak the answers aloud"}
            title={voiceOn ? "Voice on" : "Voice off"}
          >
            {voiceOn ? <SpeakerOn /> : <SpeakerOff />}
          </button>
          {answering && <span className="ic-answering" title={answering.reason ?? "The workspace's model"}>{answering.label}</span>}
        </div>
        <button
          type="button"
          className="ic-icon ic-dismiss"
          onClick={() => void hangUp()}
          aria-label={`End the call on ${venture.name}`}
        >
          <XMark />
        </button>
      </header>

      <div className="ic-orbwrap" ref={wrapRef}>
        <canvas className="ic-orb" ref={canvasRef} />
        <div className="ic-fallback" />
      </div>

      <div
        className={`ic-caption${captionOn ? " ic-on" : ""}`}
        data-dots={captionDots ? "1" : "0"}
        aria-live="polite"
      >
        <span>{captionText}</span>
        <i />
        <i />
        <i />
      </div>

      <main className="ic-main" ref={mainRef}>
        <div className="ic-thread" ref={threadRef}>
          <div className="ic-col" ref={colRef} />
        </div>
      </main>

      <footer className="ic-foot">
        <button type="button" className="ic-jump" onClick={toLive} tabIndex={behind ? 0 : -1}>
          ↓ &nbsp;return to live
        </button>

        <div className={`ic-dock${fieldOpen ? " ic-open" : ""}`} ref={dockRef} tabIndex={-1}>
          <div className="ic-field">
            <input
              ref={inputRef}
              className="ic-input"
              placeholder={busy ? "One moment…" : "Type your answer…"}
              autoComplete="off"
              spellCheck={false}
              disabled={!dockLive || busy}
              aria-label="Type your answer"
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const v = e.currentTarget.value.trim();
                if (!v) return;
                e.currentTarget.value = "";
                submit(v, null);
              }}
            />
          </div>

          <button
            type="button"
            className={`ic-btn ic-mic${listening ? " ic-live" : ""}`}
            onClick={() => (listening ? stopRecognition() : startListening())}
            disabled={!recCtor || !dockLive}
            aria-label={micTitle}
            title={micTitle}
          >
            <MicGlyph />
          </button>

          <button
            type="button"
            className="ic-btn ic-key"
            onClick={() => {
              const next = !fieldOpen;
              setFieldOpen(next);
              if (next) setTimeout(() => inputRef.current?.focus(), 80);
              else inputRef.current?.blur();
            }}
            disabled={!dockLive}
            aria-label={fieldOpen ? "Hide the keyboard" : "Type instead"}
            aria-pressed={fieldOpen}
          >
            <KeyGlyph />
          </button>
        </div>
      </footer>
    </div>,
    document.body,
  );
}
