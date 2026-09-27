/**
 * WHICH ROWS A RAIL PICK HOLDS, AND WHICH GESTURES CHANGE IT.
 *
 * The rails on the Outputs page pick several rows and run them all (see
 * `usePick` in pages/Outputs.tsx). The gesture was mouse-only — shift-click
 * and ⌘/Ctrl-click — which left a keyboard user unable to batch at all: Tab
 * moves through the rail fine, and then Enter only ever navigates. This file
 * keeps the decision — click or key, does this pick, what is the new set —
 * apart from the DOM, the way the repo keeps every other meaning-decision
 * testable without one (`inboxView.ts`, `boardCompletion.ts`).
 *
 * THE KEYBOARD RULE, in one line: Enter navigates as it always has; SPACE
 * picks; SHIFT+ENTER picks too, for the hand already on Enter. That is the
 * file-manager convention (arrows to move, a key to mark, Enter to open), and
 * it is deliberately NOT "Space activates the link" — these rows are
 * navigation, and a picker that hijacked Space from its usual scroll meaning
 * only to navigate would be a worse scroll AND a worse picker.
 */

/** The modifier keys of an event, reduced to what the rule reads. */
export type Modifiers = { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean };

/** A plain click clears the pick; a modified one toggles the row. */
export function clickPicks(e: Modifiers): boolean {
  return Boolean(e.shiftKey || e.metaKey || e.ctrlKey);
}

/**
 * What a key press on a rail row means: `navigate` (let the link act) or
 * `pick` (toggle this row instead). A plain Enter keeps navigating — the row
 * is a link first and a picker second, and navigating away puts the batch
 * down exactly as a plain click does.
 */
export function keyAction(e: Modifiers & { key: string }): "navigate" | "pick" {
  if (e.key === " " && !e.shiftKey && !e.metaKey && !e.ctrlKey) return "pick";
  if (e.key === "Enter" && e.shiftKey) return "pick";
  return "navigate";
}

/** Add `key` if absent, drop it if present. Order of insertion is kept. */
export function toggle(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}
