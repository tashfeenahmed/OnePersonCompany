import { SHOT_FLOOR } from "../../tools/chrome.ts";
import { decodePng } from "../../tools/png.ts";

/** Validate the DOM from the same browser run as the PNG. A browser error
 * screen is a valid image, but must never replace the last good website shot. */
export function captureError(html: string, bytes: Buffer): string | null {
  if (!html.includes("</html>")) return "The browser did not finish loading the page.";
  if (/<body\b[^>]*\bclass=["'][^"']*\bneterror\b/i.test(html) ||
      /id=["'](?:main-frame-error|interstitial-wrapper)["']/i.test(html)) {
    const code = html.match(/\b(?:ERR|DNS_PROBE)_[A-Z_]+\b/)?.[0];
    return `The browser could not open the website${code ? ` (${code})` : " (network or security error)"}.`;
  }
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
  if (/^(?:(?:error\s*)?[45]\d\d\b|just a moment|attention required)|\b(bad gateway|service unavailable|internal server error|application error|site can[’']?t be reached|privacy error)\b/i.test(title))
    return `The website returned an error or verification page: ${title.slice(0, 180)}.`;
  const decoded = decodePng(bytes);
  if (!decoded.stats) return `The browser did not produce a readable image: ${decoded.error}`;
  const { width, height, stdev, dominantShare } = decoded.stats;
  if (width < SHOT_FLOOR.width || height < SHOT_FLOOR.height)
    return `The browser image is too small (${width}×${height}).`;
  if (stdev < 4 || dominantShare > 0.985)
    return "The website produced a blank image before it finished rendering.";
  return null;
}
