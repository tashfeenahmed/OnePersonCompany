import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { baseArgs, SHOT_VIEWPORT, withProfile, type ShotResult } from "../../tools/chrome.ts";
import { connect, waitForPort, type Cdp } from "../../tools/chrome-cdp.ts";
import { captureError } from "./capture-validation.ts";

export const RENDER_RETRY_MS = 45_000;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A real-time retry for pages whose loaders/animations do not finish under
 * Chrome's virtual clock. Uses a fresh profile, never the owner's browser. */
export async function captureRendered(bin: string, url: string, out: string): Promise<ShotResult> {
  return withProfile(async profile => {
    const deadline = Date.now() + RENDER_RETRY_MS;
    // Canvas/WebGL sites need normal GPU rendering to leave their loader.
    const child = spawn(bin, [...baseArgs({profile, virtualTimeMs:0}).filter(arg => arg !== "--disable-gpu"), "--remote-debugging-port=0", "about:blank"], {stdio:"ignore"});
    let failure: string | null = null;
    child.on("error", error => { failure = error.message; });
    child.on("exit", () => { failure ??= "The browser stopped before it finished rendering."; });
    let cdp: Cdp | null = null;
    let html = "";
    const stop = () => { try { child.kill("SIGKILL"); } catch { /* Already stopped. */ } };
    const timer = setTimeout(stop, RENDER_RETRY_MS);
    try {
      const port = await waitForPort(profile, Math.min(deadline, Date.now()+10_000), () => failure !== null);
      if (!port) throw new Error(failure ?? "The browser did not start in time.");
      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, {signal:AbortSignal.timeout(5000)})).json() as {webSocketDebuggerUrl?:string};
      if (!version.webSocketDebuggerUrl) throw new Error("The browser did not publish a capture connection.");
      cdp = await connect(version.webSocketDebuggerUrl, deadline);
      const target = await cdp.send("Target.createTarget", {url:"about:blank"});
      const attached = await cdp.send("Target.attachToTarget", {targetId:target.targetId, flatten:true});
      if (typeof attached.sessionId !== "string") throw new Error("The browser could not open the website.");
      const session = attached.sessionId;
      await cdp.send("Page.enable", {}, session);
      await cdp.send("Emulation.setDeviceMetricsOverride", {...SHOT_VIEWPORT, deviceScaleFactor:1, mobile:false}, session);
      await cdp.send("Page.bringToFront", {}, session);
      const navigation = await cdp.send("Page.navigate", {url}, session);
      if (navigation.errorText) throw new Error(`The browser could not open the website (${String(navigation.errorText)}).`);
      const readyBy = Math.min(deadline - 5000, Date.now() + 18_000);
      while (Date.now() < readyBy) {
        const state = await cdp.send("Runtime.evaluate", {expression:"document.readyState", returnByValue:true}, session) as {result?:{value?:string}};
        if (state.result?.value === "complete") break;
        await pause(250);
      }
      let error = "The website did not finish rendering in time.";
      while (Date.now() < deadline - 2500) {
        // Allow actual paint frames, font loads and entrance animations.
        await pause(2000);
        const dom = await cdp.send("Runtime.evaluate", {expression:"document.documentElement.outerHTML", returnByValue:true}, session) as {result?:{value?:string}};
        html = dom.result?.value ?? "";
        const shot = await cdp.send("Page.captureScreenshot", {format:"png", captureBeyondViewport:false}, session);
        if (typeof shot.data !== "string") throw new Error("The browser returned no screenshot.");
        const bytes = Buffer.from(shot.data, "base64");
        const invalid = captureError(html, bytes);
        if (!invalid) {
          writeFileSync(out, bytes);
          return {ok:true, path:out, stdout:html, error:null};
        }
        error = invalid;
        if (!invalid.includes("blank image")) break;
      }
      return {ok:false, path:null, stdout:html, error};
    } catch (error) {
      return {ok:false, path:null, stdout:html, error:error instanceof Error ? error.message : String(error)};
    } finally {
      clearTimeout(timer);
      cdp?.close();
      stop();
    }
  }, "capture-render-");
}
