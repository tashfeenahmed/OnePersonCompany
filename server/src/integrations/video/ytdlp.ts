import { run, tail, type Ran } from "./tools.ts";

export function isYoutubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")
      || host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com");
  } catch { return false; }
}

/** Workdash enabled the official EJS solver. Node is already present wherever OPC runs. */
export function youtubeRuntimeArgs(url: string, nodePath = process.execPath): string[] {
  return isYoutubeUrl(url) ? ["--js-runtimes", `node:${nodePath}`, "--remote-components", "ejs:github"] : [];
}

/** Python dependency warnings can precede the actual download error. */
export function ytdlpFailure(result: Ran, fallback: string): string {
  if (result.error) return result.error;
  const errors = result.stderr.split("\n").filter(line => /^\s*ERROR:/i.test(line));
  return tail(errors.length ? errors.join("\n") : result.stderr) || fallback;
}

/** Refresh extraction once after a YouTube media 403, within the original time budget.
 *  The URL must be the last argument. Restart partial media so signed links/fragment
 *  layouts from the previous attempt are never mixed with the fresh extraction. */
export async function downloadWithRefresh(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal; onRefresh?: () => void },
  execute: typeof run = run,
): Promise<{ result: Ran; refreshed: boolean }> {
  const started = Date.now();
  const result = await execute(bin, args, { timeoutMs: opts.timeoutMs, signal: opts.signal });
  const url = args.at(-1) ?? "";
  const remaining = opts.timeoutMs - (Date.now() - started);
  if (result.ok || result.error || opts.signal?.aborted || remaining <= 0 || !isYoutubeUrl(url)
    || !/HTTP(?:\s+Error|\s+error)?\s*403\b/i.test(result.stderr)) return { result, refreshed: false };
  opts.onRefresh?.();
  return {
    result: await execute(bin, [...args.slice(0, -1), "--force-overwrites", "--no-continue", url], {
      timeoutMs: remaining, signal: opts.signal,
    }),
    refreshed: true,
  };
}
