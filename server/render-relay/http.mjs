import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const MAX_BODY = 128_000;
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value;
}

/** Only the four rendering operations used by OPC. No dashboard, chat,
 * Telegram, collector, schedule, shell or arbitrary file endpoint. */
export function createRelayServer({ engine, key }) {
  if (!key || key.length < 16) throw new Error("A render relay key is required");
  const expected = Buffer.from(`Bearer ${key}`);
  return createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return json(res, 401, { error: "Unauthorized" });
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "GET" && path === "/agent/reel") {
        return json(res, 200, { ...engine.reelState(), relay: "opc", externalScript: true,
          running: engine.reelRunning(), sleepDueAt: null, worker: await engine.reelCapabilities() });
      }
      if (req.method === "POST" && path === "/agent/reel/prepare-script")
        return json(res, 200, await engine.prepareReelScript(await readBody(req)));
      if (req.method === "POST" && path === "/agent/reel/start") {
        const body = await readBody(req);
        if (!body.script) return json(res, 400, { error: "OPC must supply the script before rendering." });
        const result = engine.startReel(body);
        return json(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "GET" && path.startsWith("/agent/reel/video/")) {
        const file = decodeURIComponent(path.slice("/agent/reel/video/".length));
        if (!/^[a-zA-Z0-9_-]+\.mp4$/.test(file)) return json(res, 404, { error: "No such video" });
        const found = engine.reelFile(file);
        if (!found) return json(res, 404, { error: "No such video" });
        res.writeHead(200, { "Content-Type": found.type, "Content-Length": found.bytes.length,
          "Cache-Control": "private, max-age=86400" });
        return res.end(found.bytes);
      }
      return json(res, 404, { error: "No such render operation" });
    } catch (error) {
      return json(res, 400, { error: String(error.message || "Render request failed").slice(0, 300) });
    }
  });
}
