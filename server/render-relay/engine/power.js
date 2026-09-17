/**
 * Dell power state and control.
 *
 * State is probed over TCP rather than ICMP: `ping` needs either root or a
 * sysctl on the Pi, and a successful ping would anyway only prove the box
 * answers, not that llama-swap is accepting requests. Two ports give us the
 * distinction that matters to the UI:
 *
 *   11434 open -> "ready"     the model server is up, chat will work
 *   22 open    -> "starting"  box is up, llama-swap still coming up (~30s)
 *   neither    -> "off"
 */

import { createConnection } from "node:net"
import { execFile } from "node:child_process"
import { DELL_IP, DELL_MAC, DELL_USER, POWER_KEY, LLM_PORT } from "./config.js"

function probe(port, timeout = 1500) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: DELL_IP, port, timeout })
    const done = (ok) => {
      sock.destroy()
      resolve(ok)
    }
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
    sock.once("timeout", () => done(false))
  })
}

/**
 * Set while a wake is in flight. Without it the UI would flip back to "off"
 * between the magic packet and the first ping — a cold boot is ~55s to ping
 * and ~85s to llama-swap, which is a long time to show the wrong state.
 */
let wakingUntil = 0

export async function powerState() {
  const [llm, ssh] = await Promise.all([probe(LLM_PORT), probe(22)])
  if (llm) {
    wakingUntil = 0
    return "ready"
  }
  if (ssh) return "starting"
  return Date.now() < wakingUntil ? "waking" : "off"
}

export function wake() {
  // ~2 min covers a cold boot to llama-swap accepting connections
  wakingUntil = Date.now() + 120_000
  return new Promise((resolve) => {
    execFile("/usr/bin/wakeonlan", [DELL_MAC], (err, _out, stderr) => {
      if (err) {
        wakingUntil = 0
        resolve({ ok: false, error: stderr?.trim() || String(err.message) })
      } else {
        resolve({ ok: true })
      }
    })
  })
}

/**
 * Manual only — deliberately never called on a timer. The render box runs
 * other work (chat bots that depend on its model server, a job that runs every
 * minute), so an idle-timeout shutdown would kill jobs that have nothing to
 * do with this dashboard.
 *
 * The key is pinned to a forced `shutdown` command on the Dell, so this is
 * the only thing it can do even if the Pi is compromised.
 */
export function sleep() {
  wakingUntil = 0
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/ssh",
      [
        "-i", POWER_KEY,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=8",
        "-o", "StrictHostKeyChecking=accept-new",
        `${DELL_USER}@${DELL_IP}`,
        "shutdown",
      ],
      (err, _out, stderr) => {
        // A clean shutdown drops the connection mid-command, so ssh exits
        // non-zero (255) on success. Treat "connection closed" as expected.
        const msg = (stderr ?? "").toLowerCase()
        const closedEarly =
          msg.includes("closed by remote host") || msg.includes("connection reset")
        if (err && !closedEarly) {
          resolve({ ok: false, error: stderr?.trim() || String(err.message) })
        } else {
          resolve({ ok: true })
        }
      },
    )
  })
}
