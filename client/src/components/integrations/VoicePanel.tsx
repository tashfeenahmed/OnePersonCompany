import { useState } from "react";
import { Volume2 } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { integrations, type SpokenClip } from "@/lib/api/integrations";
import { cn } from "@/lib/utils";
import { DASH, count } from "@/lib/format";
import { ago } from "./format";
import { Note, PanelSection, Row, Rows, Tiles } from "./Panel";

const DEFAULT_LINE =
  "This is the speech endpoint on this machine, saying a sentence so you can hear it.";

/**
 * THE SPEECH PATH, AND WHAT CAN HONESTLY BE TESTED FROM A PAGE.
 *
 * There are two halves and only one of them can be exercised here. SPEECH OUT
 * is a POST and an <audio> tag, so there is a button for it. TRANSCRIPTION IN
 * needs audio, and a page cannot record any without asking for the microphone —
 * so there is no "record something" button pretending to be one. What stands
 * in for it is the collector's own half-second silent probe, whose result and
 * latency are printed below: an empty transcript is a SUCCESS there, because
 * silence transcribes to nothing.
 *
 * `connected` MEANS AN ENDPOINT IS SET, not that it answers. The two are
 * different sentences everywhere in this integration and they are two lines
 * here.
 *
 * NOTHING SAID IS STORED. No word that was spoken and no byte that was heard
 * is kept: the rows below are timings and outcomes. A transcript goes into the
 * chat transcript where the typed message would have gone, and nowhere else.
 */
export function VoicePanel({ onCollected }: { onCollected?: () => void }) {
  const report = useApi(() => integrations.voice(), []);
  const [collecting, setCollecting] = useState(false);
  const [text, setText] = useState(DEFAULT_LINE);
  const [clip, setClip] = useState<SpokenClip | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function collect() {
    setCollecting(true);
    try {
      await api.collect("voice");
      report.reload();
      onCollected?.();
    } finally {
      setCollecting(false);
    }
  }

  async function speak() {
    setSpeaking(true);
    setProblem(null);
    setClip(null);
    try {
      setClip(await integrations.speak(text.trim() || DEFAULT_LINE));
      report.reload();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSpeaking(false);
    }
  }

  if (report.error || !report.data) return null;
  const d = report.data;
  const stt = d.state.stt;
  const tts = d.state.tts;
  const probe = d.counts.find((c) => c.kind === "probe");

  return (
    <PanelSection
      title="What it can do"
      meta={`last attempt ${ago(d.latency.lastAt)}`}
      onCollect={() => void collect()}
      collecting={collecting}
    >
      <Tiles
        items={[
          {
            v: stt.configured ? "set" : "not set",
            k: "transcription endpoint",
          },
          {
            v: d.latency.transcriptionMedian === null ? "—" : `${d.latency.transcriptionMedian} ms`,
            k: "median transcription",
          },
          { v: tts.ready ? tts.mode : "off", k: "speech" },
          {
            v: d.state.ffmpeg ? "found" : "missing",
            k: d.state.ffmpeg ? "ffmpeg — voice notes possible" : "ffmpeg — no voice note",
          },
        ]}
      />

      <Rows>
        <Row first>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                probe && probe.failed === 0 && probe.ok > 0 ? "bg-ok" : "bg-border",
              )}
            />
            <span className="text-[12.5px] font-medium">Transcription</span>
            <span className="text-muted-foreground min-w-0 truncate font-mono text-[11.5px]">
              {stt.url ?? "no endpoint set"}
            </span>
            <Badge variant="secondary" className="ml-auto font-mono font-normal">
              {stt.model}
            </Badge>
            <Badge variant="secondary">{stt.keyed ? "keyed" : "no key sent"}</Badge>
          </div>
          <p className="text-muted-foreground mt-1 text-[11.5px]">
            {probe
              ? `The collector's own probe — half a second of silence — has answered ${probe.ok} time${probe.ok === 1 ? "" : "s"} and failed ${probe.failed}. An empty transcript is a success there: silence transcribes to nothing.`
              : "The endpoint is set and has not been probed yet."}
          </p>
        </Row>

        <Row>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                tts.ready ? "bg-ok" : "bg-border",
              )}
            />
            <span className="text-[12.5px] font-medium">Speech</span>
            <span className="text-muted-foreground min-w-0 truncate font-mono text-[11.5px]">
              {tts.mode === "piper" ? "a piper binary on this machine" : (tts.url ?? "no endpoint set")}
            </span>
            <Badge variant="secondary" className="ml-auto font-mono font-normal">
              {tts.model} · {tts.voice}
            </Badge>
          </div>
          {tts.why && (
            <p className="text-muted-foreground mt-1 text-[11.5px]">{tts.why}</p>
          )}
        </Row>
      </Rows>

      <div className="mt-4">
        <div className="text-muted-foreground mb-2 text-[11px] tracking-[0.06em] uppercase">
          Say something
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={DEFAULT_LINE}
            className="min-w-[240px] flex-1 text-[12.5px]"
          />
          <Button onClick={() => void speak()} disabled={speaking || !tts.ready}>
            <Volume2 className="size-3.5" strokeWidth={1.8} />
            {speaking ? "Speaking…" : "Speak a test sentence"}
          </Button>
        </div>

        {!tts.ready && (
          <Note>
            Speech is off, which is the default and a real answer: it costs money
            on a hosted endpoint and disk on a local one. Set{" "}
            <code>tts</code> to <code>openai</code> or <code>piper</code> in
            Settings above to turn it on.
          </Note>
        )}

        {clip && (
          <div className="mt-2.5">
            <audio src={clip.url} controls className="w-full max-w-[420px]" />
            <Note>
              {count(clip.bytes)} bytes of {clip.format} in{" "}
              {clip.ms} ms, via {clip.via}. The clip is a file on this machine
              and the route returns its bytes — it is never held in the browser
              and it may be deleted once it has been sent.
            </Note>
          </div>
        )}
        {problem && <p className="text-destructive mt-2 text-[12px]">{problem}</p>}

        <Note>
          <b className="text-foreground font-medium">
            There is no record button, and that is not an omission.
          </b>{" "}
          A page cannot make audio without asking for the microphone, so the
          transcription half is exercised by the collector's silent probe above
          rather than by a control here that would only ever be half a test.
        </Note>
      </div>

      <Note>
        <b className="text-foreground font-medium">On Telegram:</b> a voice note
        sent to the bot is transcribed and answered like any typed message, and
        the text answer is sent first, always.{" "}
        {d.state.replyWithVoice
          ? d.state.ffmpeg
            ? "“Answer a voice note with a voice note” is on, so a spoken reply follows it as a voice note."
            : "“Answer a voice note with a voice note” is on, but ffmpeg was not found on this machine — Telegram needs an ogg/opus file, so only the text reply is sent."
          : "“Answer a voice note with a voice note” is off, so only the text reply is sent. Turn it on in Settings above."}{" "}
        The words are the answer and the audio is a convenience, which is why a
        speech endpoint that is down costs a nicety rather than the reply.
      </Note>

      {!!d.runs.length && (
        <div className="mt-4">
          <div className="text-muted-foreground mb-2 text-[11px] tracking-[0.06em] uppercase">
            Last attempts
          </div>
          <div className="flex flex-col gap-1.5">
            {d.runs.slice(0, 8).map((r, i) => (
              <div key={`${r.ts}:${r.kind}:${i}`} className="flex items-baseline gap-2.5 text-[12px]">
                <span
                  className={cn(
                    "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
                    r.ok ? "bg-ok" : "bg-destructive",
                  )}
                />
                <span className="text-muted-foreground w-[64px] shrink-0 font-mono text-[11.5px]">
                  {r.kind}
                </span>
                <span className="text-muted-foreground min-w-0 truncate">
                  {r.error ?? `${count(r.bytes)} bytes in ${r.ms ?? DASH} ms`}
                </span>
                <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[11px]">
                  {ago(r.ts)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Note>{d.notes[0]}</Note>
    </PanelSection>
  );
}
