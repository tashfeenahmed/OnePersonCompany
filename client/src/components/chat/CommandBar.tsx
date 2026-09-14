import { useId, type CSSProperties, type RefObject } from "react";
import { ArrowUp, CornerDownLeft, Plus, Square } from "lucide-react";
import { Liquid } from "liquid-gooey";
import { Textarea } from "@/components/ui/textarea";
import "./command-bar.css";

type CommandBarProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onAttach: () => void;
  busy: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  error?: string | null;
  corner?: number;
  bridge?: number;
  edge?: number;
};

const BUTTON = 56;
const GAP = 12;

/** Bencho's command-bar pattern: one stationary slab, a morphing send button.
 * Liquid owns BOTH the button's transform and its silhouette. The reserved
 * gutter keeps text/caret positions unchanged when it splits or rejoins.
 * Chat state, attachments and streaming stay owned by the caller. */
export function CommandBar({
  value, onChange, onSend, onStop, onAttach, busy, inputRef, placeholder,
  error, corner = 28, bridge = 3, edge = 22,
}: CommandBarProps) {
  const hintId = useId();
  const errorId = useId();
  const expanded = busy || !!value.trim();

  function submit() {
    if (!busy && value.trim()) onSend();
  }

  return (
    <div className="chat-command" data-expanded={expanded}>
      <Liquid
        className="chat-command-liquid"
        blur={bridge}
        contrast={edge}
        fill="var(--chat-command-fill)"
        style={{ "--chat-command-corner": `${corner}px` } as CSSProperties}
      >
        <Liquid.Item className="chat-command-bar" radius={corner}>
          <div className="chat-command-inputs">
            <button type="button" className="chat-command-attach" onClick={onAttach}
              aria-label="Attach a text file" title="Attach a text file">
              <Plus size={19} strokeWidth={1.6} />
            </button>
            <Textarea
              ref={inputRef}
              aria-label="Message"
              aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
              value={value}
              rows={1}
              autoFocus
              onChange={event => onChange(event.target.value)}
              onKeyDown={event => {
                // Enter accepts an IME candidate; it must never submit it.
                if (event.key === "Enter" && !event.shiftKey &&
                    !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={placeholder}
              className="chat-command-textarea"
            />
            <span className="chat-command-idle" data-show={!expanded} aria-hidden="true">
              <CornerDownLeft size={17} strokeWidth={1.6} />
            </span>
          </div>
        </Liquid.Item>
        <Liquid.Item
          className="chat-command-action"
          radius={BUTTON / 2}
          x={expanded ? 0 : -(BUTTON + GAP)}
          transition={{ stiffness: 460, damping: 32 }}
        >
          <button
            type="button"
            className="chat-command-send"
            disabled={!expanded}
            tabIndex={expanded ? 0 : -1}
            aria-hidden={!expanded}
            aria-label={busy ? "Stop" : "Send"}
            title={busy ? "Stop response" : "Send message"}
            onClick={() => {
              if (busy) onStop(); else submit();
              inputRef.current?.focus();
            }}
          >
            <span className="chat-command-send-icon" data-show={expanded}>
              {busy ? <Square size={16} fill="currentColor" strokeWidth={1.6} /> : <ArrowUp size={22} strokeWidth={1.8} />}
            </span>
          </button>
        </Liquid.Item>
      </Liquid>
      <span id={hintId} className="sr-only">Enter to send. Shift and Enter for a new line.</span>
      {error && <p id={errorId} role="alert" className="chat-command-error">{error}</p>}
    </div>
  );
}
