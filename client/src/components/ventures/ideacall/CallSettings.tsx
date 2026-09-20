import { useEffect, useId, useState } from "react";
import { ideaCallApi, type IdeaCallSettings, type IdeaCallSettingsPatch } from "@/lib/api/ideaCall";

/**
 * WHO THINKS, WHO HEARS, WHO SPEAKS — chosen from inside the call, because
 * that is where the difference is felt: a slow model is a long silence, a poor
 * ear is a wrong sentence on screen, and a server voice that takes six seconds
 * a paragraph is a worse call than the browser's instant one.
 *
 * TWO KINDS OF CHOICE. Which MODEL answers, transcribes or voices a clip is the
 * box's and is saved there (PUT /api/idea-call/settings). Whether the BROWSER
 * listens and speaks instead is this browser's — Chrome has an ear, Firefox has
 * none, every machine has different voices — so that half is `CallPrefs`, kept
 * in localStorage by the call.
 *
 * Every model field is a text box with suggestions, never a closed list: a
 * gateway's `/models` says what exists, not what it is for, so the suggestions
 * are a guess by name and the owner may know better.
 */
export type CallPrefs = { listen: "auto" | "browser" | "server"; speak: "browser" | "server"; browserVoice: string };
export const DEFAULT_PREFS: CallPrefs = { listen: "auto", speak: "browser", browserVoice: "" };

export function CallSettings({ prefs, onPrefs, browserListens, onClose, onSaved }: {
  prefs: CallPrefs; onPrefs: (next: CallPrefs) => void; browserListens: boolean; onClose: () => void;
  onSaved: (doc: IdeaCallSettings) => void;
}) {
  const [doc, setDoc] = useState<IdeaCallSettings | null>(null);
  const [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const id = useId();

  useEffect(() => {
    let alive = true;
    ideaCallApi.settings().then(d => { if (alive) setDoc(d); }).catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    const synth = window.speechSynthesis;
    const read = () => setVoices((synth?.getVoices() ?? []).filter(v => v.lang.toLowerCase().startsWith("en")));
    read(); synth?.addEventListener?.("voiceschanged", read);
    return () => { alive = false; synth?.removeEventListener?.("voiceschanged", read); };
  }, []);

  async function save(patch: IdeaCallSettingsPatch) {
    setSaving(true); setError(null);
    try { const next = await ideaCallApi.saveSettings(patch); setDoc(next); onSaved(next); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  const provider = doc?.text.providers.find(p => p.id === (doc.text.provider ?? doc.text.answering?.id));
  /** A model box that saves when left, and offers what the endpoint lists. */
  const model = (label: string, key: keyof IdeaCallSettingsPatch, value: string | null, options: string[], placeholder: string) => <label className="ic-set-row">
    <span>{label}</span>
    <input key={`${key}:${value ?? ""}`} list={`${id}-${key}`} defaultValue={value ?? ""} placeholder={placeholder} spellCheck={false} autoComplete="off"
      onBlur={e => { const next = e.target.value.trim(); if (next !== (value ?? "")) void save({ [key]: next || null }); }}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); e.stopPropagation(); }} />
    <datalist id={`${id}-${key}`}>{options.map(o => <option key={o} value={o} />)}</datalist>
  </label>;

  return <aside className="ic-settings" role="dialog" aria-label="Call settings" onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
    <div className="ic-set-head"><h2>Call settings</h2><button type="button" className="ic-set-close" onClick={onClose} aria-label="Close settings">Done</button></div>
    {error && <p className="ic-set-note" role="alert">{error}</p>}
    {!doc && !error && <p className="ic-set-note">Reading what this box can use…</p>}
    {doc && <>
      <section>
        <h3>Thinking</h3>
        <label className="ic-set-row"><span>Provider</span>
          <select value={doc.text.provider ?? ""} disabled={saving} onChange={e => { void save({ provider: e.target.value || null }); }}>
            <option value="">Automatic{doc.text.provider ? "" : doc.text.answering ? ` · ${doc.text.answering.label}` : ""}</option>
            {doc.text.providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        {doc.text.provider
          ? model("Model", "model", doc.text.model, provider?.models ?? [], "The provider's default")
          : <p className="ic-set-note">{doc.text.answering?.reason ?? "The workspace's model answers. Choose a provider to pick one of its models."}</p>}
      </section>

      <section>
        <h3>Listening</h3>
        <div className="ic-set-choice" role="radiogroup" aria-label="Who transcribes">
          {([["auto", "Automatic"], ["server", "This box"], ["browser", "The browser"]] as const).map(([value, label]) =>
            <button key={value} type="button" role="radio" aria-checked={prefs.listen === value} disabled={(value === "server" && !doc.listen.configured) || (value === "browser" && !browserListens)}
              onClick={() => onPrefs({ ...prefs, listen: value })}>{label}</button>)}
        </div>
        {doc.listen.configured
          ? model("Transcription model", "sttModel", doc.listen.chosen, doc.listen.models, doc.listen.model ?? "whisper-1")
          : <p className="ic-set-note">No transcription endpoint is connected (Integrations → Voice), so only the browser can listen{browserListens ? "." : ", and this browser cannot. Type instead."}</p>}
        <p className="ic-set-note">{browserListens ? "Automatic uses this box when it can: a recording works the same in every browser. The browser's own recognition shows words as you speak, in Chrome." : "This browser has no speech recognition of its own, so the box transcribes a recording."}</p>
      </section>

      <section>
        <h3>Speaking</h3>
        <div className="ic-set-choice" role="radiogroup" aria-label="Who speaks">
          {([["browser", "The browser"], ["server", "This box"]] as const).map(([value, label]) =>
            <button key={value} type="button" role="radio" aria-checked={prefs.speak === value} disabled={value === "server" && !doc.speak.ready}
              onClick={() => onPrefs({ ...prefs, speak: value })}>{label}</button>)}
        </div>
        {prefs.speak === "browser"
          ? <label className="ic-set-row"><span>Voice</span>
              <select value={prefs.browserVoice} onChange={e => onPrefs({ ...prefs, browserVoice: e.target.value })}>
                <option value="">Automatic</option>
                {voices.map(v => <option key={v.voiceURI} value={v.voiceURI}>{v.name} · {v.lang}</option>)}
              </select>
            </label>
          : <>
              {model("Speech model", "ttsModel", doc.speak.chosenModel, doc.speak.models, doc.speak.model ?? "tts-1")}
              {model("Voice", "ttsVoice", doc.speak.chosenVoice, ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"], doc.speak.voice || "The model's default")}
            </>}
        <p className="ic-set-note">{doc.speak.ready ? "The browser's voice starts at once. The box's is a real model's voice and takes a few seconds a paragraph." : "No speech model is connected (Integrations → Voice), so the browser speaks."}</p>
      </section>
    </>}
  </aside>;
}
