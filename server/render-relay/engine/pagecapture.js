/**
 * One URL in, one full-page desktop screenshot out.
 *
 * WHY A PROTOCOL AND NOT A FLAG. collect_shots.py takes the weekly portfolio
 * shots with `--screenshot=file.png` and that is the right tool for what it
 * does — a viewport-sized picture of a home page. It is the wrong tool here,
 * twice over. `--screenshot` only ever gets the viewport, and the obvious
 * workaround — asking for a very tall `--window-size` — breaks the pages
 * worth filming: a 100vh hero becomes a 4800px hero, sticky headers unstick,
 * and half the layout is measuring itself against a window no human has. So
 * this speaks the DevTools Protocol instead, keeps the window an honest
 * 1280x800 desktop, and asks for a screenshot BEYOND that viewport — which is
 * a thing only the protocol can express.
 *
 * OVER A PIPE, NOT A PORT. `--remote-debugging-pipe` hands the protocol to us
 * on fds 3 and 4 of the child. The alternative, `--remote-debugging-port`,
 * opens a socket that anything on the Pi can drive — a debugger with full
 * control of a browser, listening, on a box that also runs the dashboard. The
 * pipe cannot be connected to by anyone; it dies with the child.
 *
 * WHY THE PI. Same argument the rest of the reel pipeline makes: this is
 * network-bound work with no GPU in it, and a URL that turns out to be a
 * parked domain must cost a few seconds of headless Chromium rather than the
 * ninety-second boot and 360W of waking the Dell to discover it. Captures
 * happen before the wake, always.
 *
 * WHY THE HEIGHT CAP. Six screens. Past that the scroll on the finished video
 * is either faster than the eye or never reaches the bottom, so the extra
 * pixels are weight on the LAN and nothing on the screen.
 *
 * THE URL IS NOT TRUSTED. It arrives from a box on the internet or from a
 * text field, and what it points at gets its JavaScript executed by a real
 * browser on the LAN. fetchpage.js's `assertPublic` — resolve first, reject
 * anything RFC1918, loopback, link-local or CGNAT — is the same guard, reused
 * rather than reimplemented, and it runs before Chromium is launched at all.
 *
 * TWO EXPORTS, ONE SESSION. `capturePage` is what this file was written for.
 * `withPage` is the same session with the screenshot taken out of it: spawn,
 * attach, navigate, settle, hand the caller an `evaluate`, then close the
 * browser whatever happened. branddna.js reads a homepage's computed colours
 * and fonts through it, and the alternative — a second Chromium driver with
 * its own pipe framing, its own kill path and its own copy of the
 * assertPublic call — would be a second place for the browser to be left
 * running on a box with eight gigabytes of disk.
 */

import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  CHROMIUM_BIN,
  REEL_CAPTURE_HEIGHT,
  REEL_CAPTURE_MAX_HEIGHT,
  REEL_CAPTURE_TIMEOUT_MS,
  REEL_CAPTURE_WIDTH,
} from "./config.js"
import { assertPublic } from "./fetchpage.js"

/* ------------------------------------------------------------ the flags */

/**
 * Inherited wholesale from collect_shots.py, including the comment that
 * matters most: WEBGL, IN SOFTWARE. `--disable-gpu` does not mean "draw it on
 * the CPU", it means no WebGL context at all, and a site whose intro waits on
 * one then waits forever. SwiftShader rasterises it and the page renders. It
 * costs seconds on the sites that use it and nothing on the ones that do not.
 */
function chromiumArgs(profileDir) {
  return [
    "--headless",
    "--no-sandbox",
    "--hide-scrollbars",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--ignore-gpu-blocklist",
    // No first-run junk and no profile written into the pi user's home on a
    // box where this runs unattended.
    "--no-first-run",
    "--disable-extensions",
    // Nothing here signs in, syncs, or wants a push channel. Without these
    // two Chromium keeps trying to register with GCM and fills stderr with
    // PHONE_REGISTRATION_ERROR — noise that buries the one line that matters
    // when a capture actually fails.
    "--disable-background-networking",
    "--disable-sync",
    // /dev/shm on the Pi is small; Chromium falls over in it rather than
    // reporting anything useful.
    "--disable-dev-shm-usage",
    `--window-size=${REEL_CAPTURE_WIDTH},${REEL_CAPTURE_HEIGHT}`,
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-pipe",
    "about:blank",
  ]
}

/* --------------------------------------------------------- the transport */

/**
 * The protocol on the pipe is JSON messages separated by NUL bytes — no
 * length prefix, no framing beyond that. Buffer until a \0, parse, repeat.
 * Replies carry `id`, events carry `method`; both carry `sessionId` once we
 * are attached flat, which is why every waiter matches on the session too.
 */
function connect(child) {
  const out = child.stdio[3] // we write here; the child reads fd 3
  const inp = child.stdio[4] // the child writes fd 4; we read here

  let nextId = 1
  const pending = new Map()
  const waiters = []
  let dead = null

  function fail(reason) {
    dead = reason
    for (const [, p] of pending) p.reject(new Error(reason))
    pending.clear()
    for (const w of waiters.splice(0)) w.resolve(null)
  }

  let buf = Buffer.alloc(0)
  inp.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      const end = buf.indexOf(0)
      if (end < 0) break
      const raw = buf.subarray(0, end).toString("utf8")
      buf = buf.subarray(end + 1)
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        continue
      }
      if (msg.id != null) {
        const p = pending.get(msg.id)
        if (!p) continue
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${msg.error.message ?? "protocol error"}`))
        else p.resolve(msg.result ?? {})
        continue
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]
        if (w.method !== msg.method) continue
        if (w.sessionId && w.sessionId !== msg.sessionId) continue
        waiters.splice(i, 1)
        w.resolve(msg.params ?? {})
      }
    }
  })
  inp.on("error", () => fail("the browser pipe closed"))
  out.on("error", () => fail("the browser pipe closed"))

  function send(method, params, sessionId) {
    if (dead) return Promise.reject(new Error(dead))
    const id = nextId++
    const msg = { id, method, params: params ?? {} }
    if (sessionId) msg.sessionId = sessionId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      out.write(`${JSON.stringify(msg)}\0`, (err) => {
        if (!err) return
        pending.delete(id)
        reject(new Error("could not talk to the browser"))
      })
    })
  }

  /** Resolves with the event params, or with null once `ms` has passed —
   *  a page that never fires `load` is a page we shoot anyway. */
  function waitFor(method, sessionId, ms) {
    return new Promise((resolve) => {
      const w = { method, sessionId, resolve }
      waiters.push(w)
      const t = setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) {
          waiters.splice(i, 1)
          resolve(null)
        }
      }, ms)
      t.unref?.()
    })
  }

  return { send, waitFor, fail }
}

/* ------------------------------------------------------- the page script */

/**
 * Walk the page down before shooting it.
 *
 * Modern pages do not exist until they are looked at: images below the fold
 * are `loading="lazy"`, sections fade in on an IntersectionObserver, and a
 * screenshot taken at scroll 0 of a page that has never been scrolled is a
 * hero followed by four screens of blank. So step down in viewport-ish jumps,
 * pause long enough for a decode, then come back to the top.
 *
 * `scrollBehavior: auto` is forced FIRST, not last: a site with
 * `scroll-behavior: smooth` in its CSS animates every one of these jumps, and
 * the 150ms waits become a slideshow of half-finished scrolls.
 */
const PRESCROLL = (step, maxHeight) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const root = document.documentElement
  const was = root.style.scrollBehavior
  root.style.scrollBehavior = 'auto'
  const tall = () => Math.max(root.scrollHeight, document.body?.scrollHeight || 0)
  for (let y = 0; y < ${maxHeight}; y += ${step}) {
    window.scrollTo(0, y)
    await sleep(150)
    if (y + ${step} >= tall()) break
  }
  window.scrollTo(0, 0)
  await sleep(250)
  root.style.scrollBehavior = was || 'auto'
  root.style.scrollBehavior = 'auto'
  return { title: document.title || null, height: tall() }
})()`

/* --------------------------------------------------------------- the PNG */

/** Believe the file, not the request: IHDR is bytes 16..24 of any PNG. */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/* ------------------------------------------------------------ the session */

/**
 * A live page, handed to a callback, and closed afterwards whatever happened.
 *
 * Everything up to the first frame is the same for every caller — resolve the
 * host, spawn Chromium on a pipe, attach flat, hold the viewport at an honest
 * desktop, navigate, wait for `load`, settle — and none of it is the
 * interesting part of any of them. So it lives here once and the caller gets
 * `evaluate`, which is the only thing a reader of a page actually needs.
 *
 * `fn` receives `{ send, sessionId, evaluate, url }`. `send` is the raw
 * protocol for a caller that needs a command this file does not wrap
 * (Page.captureScreenshot, below, is exactly that caller).
 *
 * Throws with a short printable reason. These strings are shown to a person
 * deciding whether to press the button again, so "could not resolve
 * example.com" beats a stack.
 */
export async function withPage(url, fn, { timeoutMs, bin, settleMs = 1500 } = {}) {
  const raw = String(url ?? "").trim()
  if (!raw) throw new Error("a url is required")
  if (typeof fn !== "function")
    throw new Error("withPage needs something to do with the page")

  let u
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`not a valid URL: ${raw.slice(0, 120)}`)
  }
  // Before the browser exists, not after. A headless Chromium pointed at the
  // LAN is a far sharper instrument than a fetch.
  const blocked = await assertPublic(u)
  if (blocked) throw new Error(`refused to open — ${blocked}`)

  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : REEL_CAPTURE_TIMEOUT_MS
  const profileDir = mkdtempSync(join(tmpdir(), "reelshot-"))

  const child = spawn(bin || CHROMIUM_BIN, chromiumArgs(profileDir), {
    // 0 and 1 are nobody's business; 2 is where Chromium reports the failures
    // it then exits 0 on; 3 and 4 are the protocol.
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  })

  let stderr = ""
  child.stderr?.on("data", (d) => {
    stderr = (stderr + d.toString("utf8")).slice(-2000)
  })

  const link = connect(child)

  let settled = false
  const killer = setTimeout(() => {
    settled = true
    try {
      child.kill("SIGKILL")
    } catch {
      /* already gone */
    }
    link.fail(`the page did not finish in ${Math.round(limit / 1000)}s`)
  }, limit)

  const spawnFailed = new Promise((_, reject) => {
    child.on("error", (err) =>
      reject(new Error(`chromium would not run: ${String(err?.message ?? err).slice(0, 120)}`)),
    )
    child.on("exit", (code) => {
      if (settled) return
      const tail = stderr.trim().split("\n").pop() ?? ""
      reject(new Error(`chromium exited (${code})${tail ? `: ${tail.slice(0, 140)}` : ""}`))
    })
  })

  try {
    return await Promise.race([spawnFailed, opened(link, u, fn, settleMs)])
  } catch (err) {
    const why = String(err?.message ?? err)
    throw new Error(why.slice(0, 200))
  } finally {
    clearTimeout(killer)
    settled = true
    // Ask nicely, then insist. A Chromium left behind on this box holds a
    // profile directory and a hundred megabytes of the Pi's eight.
    await link.send("Browser.close").catch(() => null)
    await new Promise((r) => setTimeout(r, 300))
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
    }
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* the next boot's tmp sweep gets it */
    }
  }
}

/** The protocol conversation, from a fresh browser to a loaded page. */
async function opened(link, u, fn, settleMs) {
  /*
    Attach flat. The browser-level session can create and list targets but
    cannot drive one; `flatten: true` means every subsequent message carries
    its sessionId on the same pipe rather than being tunnelled inside
    Target.sendMessageToTarget, which is the old shape and the awkward one.
  */
  const { targetInfos = [] } = await link.send("Target.getTargets")
  let targetId = targetInfos.find((t) => t.type === "page")?.targetId
  if (!targetId) {
    ;({ targetId } = await link.send("Target.createTarget", { url: "about:blank" }))
  }
  const { sessionId } = await link.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  })
  if (!sessionId) throw new Error("the browser would not attach to a page")

  await link.send("Page.enable", {}, sessionId)
  await link.send("Runtime.enable", {}, sessionId)
  /*
    The window is 1280x800 because that is a desktop, and the override says so
    again in case the window manager on a headless box had other ideas. The
    height stays 800 THROUGH the screenshot — this is the whole reason for
    using the protocol, and overriding it to the full page height here would
    reintroduce the broken hero we came to avoid.
  */
  await link.send(
    "Emulation.setDeviceMetricsOverride",
    {
      width: REEL_CAPTURE_WIDTH,
      height: REEL_CAPTURE_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    },
    sessionId,
  )

  // Registered BEFORE the navigate, because a cached page can fire `load`
  // before the navigate reply comes back.
  const loaded = link.waitFor("Page.loadEventFired", sessionId, 15_000)
  const nav = await link.send("Page.navigate", { url: u.toString() }, sessionId)
  if (nav.errorText) throw new Error(`the page would not load: ${nav.errorText}`)
  await loaded
  // Settle: fonts swap, hydration paints, the hero finishes its first frame.
  await new Promise((r) => setTimeout(r, settleMs))

  /*
    Run an expression in the page and get its value back.

    `exceptionDetails` becomes an error sentence rather than a silent null: a
    page that threw and a page that returned nothing are different failures,
    and a reader that conflated them would report an empty brand document as
    if the site simply had no colours in it.
  */
  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const out = await link.send(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true },
      sessionId,
    )
    if (out.exceptionDetails)
      throw new Error(
        `the page threw: ${String(
          out.exceptionDetails.exception?.description ??
            out.exceptionDetails.text ??
            "unknown",
        ).slice(0, 120)}`,
      )
    return out.result?.value
  }

  return fn({ send: (m, p) => link.send(m, p, sessionId), sessionId, evaluate, url: u })
}

/* ------------------------------------------------------------ the capture */

/**
 * Screenshot one page into `outFile`.
 *
 * Resolves `{ title, width, height }`; throws with a short, printable reason
 * — these strings land in a reel's `captures[].error` and are read by a human
 * deciding whether to retry, so "could not resolve example.com" beats a stack.
 *
 * `bin` exists so the module can be exercised against whatever browser the
 * developing machine has, without the Pi's paths.
 */
export async function capturePage({ url, outFile, timeoutMs, bin, maxHeight } = {}) {
  if (!outFile) throw new Error("an output file is required")
  /*
    `maxHeight` is optional and defaults to the reel's six screens, which is the
    only behaviour that existed before it. It was added for the SERP teardown,
    where the picture is handed to a vision model as a base64 data URI: six
    screens of a competitor's landing page is a two-megabyte PNG and nearly
    three of prefill, for four screens nobody reads. Two screens is what the
    teardown asks for and it is the caller's decision, not this file's — and it
    is still clamped by the reel's ceiling, never above it.
  */
  const tallest = Math.max(
    REEL_CAPTURE_HEIGHT,
    Math.min(Math.round(Number(maxHeight) || REEL_CAPTURE_MAX_HEIGHT), REEL_CAPTURE_MAX_HEIGHT),
  )
  return withPage(url, (page) => shoot(page, outFile, tallest), { timeoutMs, bin })
}

/** Walk the page down, measure it, and rasterise the whole of it. */
async function shoot({ send, evaluate }, outFile, tallest = REEL_CAPTURE_MAX_HEIGHT) {
  const measured =
    (await evaluate(PRESCROLL(REEL_CAPTURE_HEIGHT, tallest))) ?? {}
  const title = measured.title ? String(measured.title).slice(0, 160) : null
  const height = Math.max(
    REEL_CAPTURE_HEIGHT,
    Math.min(Math.round(Number(measured.height) || 0), tallest),
  )

  /*
    `captureBeyondViewport` is the flag that makes this worth doing: it
    rasterises the clip rectangle even though most of it is below the fold,
    without ever resizing the viewport the page believes it is in.
  */
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: REEL_CAPTURE_WIDTH, height, scale: 1 },
  })
  if (!shot.data) throw new Error("the browser returned no image")

  const bytes = Buffer.from(shot.data, "base64")
  const size = pngSize(bytes)
  if (!size) throw new Error("the browser returned something that is not a PNG")

  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, bytes, { mode: 0o644 })
  return { title, width: size.width, height: size.height }
}
