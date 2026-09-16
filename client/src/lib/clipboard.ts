/** Clipboard API on HTTPS/localhost; selection-based copy on the Pi's HTTP URL. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Try the browser's selection-based clipboard operation. */ }

  const previous = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.setAttribute("aria-hidden", "true");
  input.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  // Radix menus/dialogs trap focus. Keep the temporary selection inside the
  // active surface so its focus guard does not steal it before copying.
  const surface = previous instanceof Element ? previous.closest('[role="dialog"], [role="menu"]') : null;
  (surface ?? document.body).append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch { return false; }
  finally {
    input.remove();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
