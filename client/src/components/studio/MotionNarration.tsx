import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CircleCheck, CircleAlert, Loader2, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useApi } from "@/hooks/useApi";
import { integrations, type SpokenClip } from "@/lib/api/integrations";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Configuration is not proof of a connection. Only an audio response verifies it. */
export function MotionNarration({ checked, onCheckedChange, onReadyChange }: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  onReadyChange: (value: boolean) => void;
}) {
  const report = useApi(() => integrations.voice(), []);
  const [testing, setTesting] = useState(false);
  const [clip, setClip] = useState<SpokenClip | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const speech = report.data?.state.tts;
  const ready = !!speech?.ready && !report.error && !report.loading;
  const check = speech?.check;
  const connected = ready && check?.ok === true && !problem;
  const failed = !!problem || check?.ok === false || !!report.error;

  useEffect(() => { onReadyChange(ready); }, [ready, onReadyChange]);
  useEffect(() => {
    const refresh = () => { setProblem(null); report.reload(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("opc:data-changed", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("opc:data-changed", refresh);
    };
  }, [report.reload]);

  async function test() {
    setTesting(true); setProblem(null); setClip(null);
    try { setClip(await integrations.speak("Motion narration is connected. Your scenes can now have a voice.")); }
    catch (error) { setProblem(error instanceof Error ? error.message : "The speech test failed."); }
    finally { setTesting(false); report.reload(); }
  }

  const label = report.loading ? "Checking speech…" : report.error ? "Could not check speech"
    : !speech?.ready ? "Speech not connected" : failed ? "Speech test failed"
    : connected ? "Speech connected" : "Speech configured · not tested";
  const provider = speech?.mode === "freellmapi" ? "FreeLLMAPI" : speech?.mode === "piper" ? "Piper" : "Speech endpoint";
  return (
    <div className="border-line-soft grid gap-2.5 rounded-xl border p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2.5 text-[13.5px]">
          <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={!ready && !checked} />
          Add narration
        </label>
        <span role="status" className={cn("flex items-center gap-1.5 text-[12px]", connected ? "text-ok" : failed ? "text-destructive" : "text-muted-foreground")}>
          {report.loading ? <Loader2 className="size-3.5 animate-spin" /> : connected ? <CircleCheck className="size-3.5" /> : <CircleAlert className="size-3.5" />}
          {label}
        </span>
      </div>
      <p className="text-muted-foreground text-[12.5px] leading-relaxed">
        {report.error ? "Retry the check or open speech settings." : !speech?.ready ? speech?.why ?? "Checking your speech integration."
          : <>{provider} · {speech.model === "auto" ? "automatic speech model" : speech.model}{speech.voice ? ` · ${speech.voice}` : " · provider’s default voice"}.
            {check && <> Last attempt {ago(check.at)}{check.ok && check.via ? ` via ${check.via}` : ""}.</>}
            {checked ? " Narrates each scene’s spoken text." : " Turn narration on to include speech in this video."}</>}
      </p>
      {(problem || check?.error) && <p className="text-destructive text-[12.5px]">{problem ?? check?.error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        {speech?.ready && <Button size="sm" variant="outline" onClick={() => void test()} disabled={testing || !ready}>
          {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Volume2 className="size-3.5" />}{testing ? "Testing voice…" : "Test voice"}
        </Button>}
        {report.error && <Button size="sm" variant="outline" onClick={report.reload}>Retry</Button>}
        <Link to="/integrations/voice" className="text-muted-foreground hover:text-foreground text-[12.5px] underline decoration-dotted underline-offset-4">
          {speech?.ready ? "Speech settings" : "Connect speech"}
        </Link>
      </div>
      {clip && <audio controls preload="metadata" src={clip.url} className="h-9 w-full max-w-sm" aria-label="Narration voice sample" />}
    </div>
  );
}
