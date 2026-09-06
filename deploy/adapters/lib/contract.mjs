/**
 * THE TWO CONTRACTS, CHECKED HERE SO NOBODY FINDS OUT AT FOUR IN THE MORNING.
 *
 * This is a DELIBERATE SECOND COPY of the validation in the dashboard's
 * server/src/integrations/activity/users.ts, and the duplication is the point:
 * an adapter runs on the product's host, which has none of that application on
 * it, and a pre-flight check that required the dashboard to be reachable is a
 * pre-flight check that cannot run at install time.
 *
 * WHICH COPY IS AUTHORITATIVE. The server's. This one exists to fail fast and
 * to fail on the right line; the dashboard re-validates every document it
 * fetches and will refuse one this accepted. `POST /api/migrate/adapters/
 * validate` on the dashboard runs the SERVER's validator against a sample and
 * is the check to run before declaring an adapter finished — that route exists
 * precisely so this file never has to be trusted.
 *
 * IF THE TWO EVER DISAGREE, the server is right and this file is stale. The
 * server's version is the one a document is stored by.
 */

export const POPULATIONS = ["customer", "participant", "admin", "trial", "internal"];

const ISO =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isoAt(value) {
  if (typeof value !== "string" || !ISO.test(value.trim())) return null;
  const at = Date.parse(value.trim());
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function show(value) {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value === "string") return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === "object") return "an object";
  return String(value);
}

const MAX_PROBLEMS = 12;

/**
 * A users document against the contract.
 *
 * Returns `{ ok, problems, shape, users, total, populations, contactable }`.
 * `ok: false` means the dashboard would store NOTHING from this document and
 * keep whatever it last had — which is the right behaviour and a terrible
 * surprise, so it is worth catching here.
 */
export function validateUsers(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    return {
      ok: false,
      problems: [
        `The document is ${show(doc)}. It has to be a JSON object with either a "users" array or a "counts" object at the top level.`,
      ],
    };

  const top = doc;
  const problems = [];
  if (top.generatedAt !== undefined && top.generatedAt !== null && isoAt(top.generatedAt) === null)
    problems.push(`generatedAt is ${show(top.generatedAt)}, which is not an ISO 8601 timestamp.`);

  /* THE COUNTS FORM — for a product that genuinely cannot list its users.
     `{"users": []}` says "I have none"; this says "I have some and cannot name
     them". They are opposite facts. */
  if (top.users === undefined && top.counts !== undefined) {
    const c = top.counts;
    if (c === null || typeof c !== "object" || Array.isArray(c))
      return { ok: false, problems: [`counts is ${show(c)}, and it has to be an object: { "total": n, "new": { "days": 7, "n": n } }.`] };
    let total = null;
    if (c.total === undefined || c.total === null)
      problems.push("counts.total is missing. A counts-only document exists to publish a total, so this is the one field it must have.");
    else if (typeof c.total !== "number" || !Number.isFinite(c.total) || c.total < 0)
      problems.push(`counts.total is ${show(c.total)}, which is not a count.`);
    else total = Math.round(c.total);

    if (c.new !== undefined && c.new !== null) {
      const n = c.new;
      if (typeof n !== "object" || Array.isArray(n))
        problems.push(`counts.new is ${show(n)}, and it has to be an object: { "days": 7, "n": 12 }.`);
      else {
        if (!(typeof n.days === "number" && n.days > 0)) problems.push(`counts.new.days is ${show(n.days)}, which is not a window in days.`);
        if (!(typeof n.n === "number" && n.n >= 0)) problems.push(`counts.new.n is ${show(n.n)}, which is not a count.`);
      }
    }
    if (total === null) return { ok: false, problems };
    return { ok: true, problems, shape: "counts", total, users: [], populations: {}, contactable: null };
  }

  if (top.users === undefined)
    return {
      ok: false,
      problems: [
        `The document has neither "users" nor "counts" at the top level. It has: ${Object.keys(top).slice(0, 10).join(", ") || "nothing"}.`,
      ],
    };
  if (!Array.isArray(top.users))
    return { ok: false, problems: [`users is ${show(top.users)}, and it has to be an array of user objects.`] };

  let total = null;
  if (top.total !== undefined && top.total !== null) {
    if (typeof top.total !== "number" || !Number.isFinite(top.total) || top.total < 0)
      problems.push(`total is ${show(top.total)}, which is not a count. Leave it out rather than send a string.`);
    else total = Math.round(top.total);
  }

  const users = [];
  const seen = new Set();
  const populations = { customer: 0, participant: 0, admin: 0, trial: 0, internal: 0 };
  let contactable = 0;
  let skipped = 0;

  top.users.forEach((raw, i) => {
    const note = (m) => {
      skipped += 1;
      if (problems.length < MAX_PROBLEMS) problems.push(`users[${i}].${m}`);
    };
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      skipped += 1;
      if (problems.length < MAX_PROBLEMS) problems.push(`users[${i}] is ${show(raw)}, and every item of users has to be an object.`);
      return;
    }
    const u = raw;

    const id =
      typeof u.id === "string" && u.id.trim() ? u.id.trim()
        : typeof u.id === "number" && Number.isFinite(u.id) ? String(u.id)
          : null;
    if (id === null) return note(`id is ${show(u.id)}. Every user needs the product's own id for it.`);
    if (id.length > 200) return note(`id is ${id.length} characters long, which is longer than any id this stores (200).`);

    const createdAt = isoAt(u.createdAt);
    if (createdAt === null)
      return note(`createdAt is ${show(u.createdAt)}, which is not an ISO 8601 timestamp — "2026-08-01T09:00:00Z" or "2026-08-01".`);
    if (seen.has(id)) return note(`id ${show(id)} appears more than once in this document.`);
    seen.add(id);

    if (u.email !== undefined && u.email !== null && u.email !== "" && (typeof u.email !== "string" || !u.email.includes("@")))
      return note(`email is ${show(u.email)}, which is not an address. Leave the field out for a user who has none.`);
    if (u.lastSeenAt !== undefined && u.lastSeenAt !== null && u.lastSeenAt !== "" && isoAt(u.lastSeenAt) === null)
      return note(`lastSeenAt is ${show(u.lastSeenAt)}, which is not an ISO 8601 timestamp.`);
    if (u.paid !== undefined && u.paid !== null && typeof u.paid !== "boolean")
      return note(`paid is ${show(u.paid)}. It is true or false, and it is left out entirely for a product that cannot say.`);

    let population = "customer";
    if (u.population !== undefined && u.population !== null && u.population !== "") {
      if (typeof u.population !== "string" || !POPULATIONS.includes(u.population))
        return note(`population is ${show(u.population)}. It is one of ${POPULATIONS.join(", ")}, or left out entirely — a missing population is “customer”.`);
      population = u.population;
    }
    if (u.contactPermitted !== undefined && u.contactPermitted !== null && typeof u.contactPermitted !== "boolean")
      return note(`contactPermitted is ${show(u.contactPermitted)}. It is true or false and nothing else — a "true" in quotes is not consent.`);

    populations[population] += 1;
    if (u.contactPermitted === true) contactable += 1;
    users.push({ id, createdAt, population, contactPermitted: u.contactPermitted === true });
  });

  if (skipped > problems.length)
    problems.push(`…and ${skipped - problems.length} more row(s) with the same kinds of problem. ${skipped} of ${top.users.length} were skipped.`);
  if (!users.length && top.users.length) return { ok: false, problems };

  return { ok: true, problems, shape: "users", users, total, populations, contactable };
}

/**
 * A product-stats document.
 *
 * The stats contract is looser on purpose — it is "any JSON object", and which
 * numbers matter is a MAPPING the dashboard holds, not a schema the product
 * obeys. So what can be checked here is the shape and the paths: given the
 * mapping lines the dashboard is configured with, does each one resolve to a
 * number in this document? A path that resolves to nothing is a mapping error
 * and NEVER a zero, which is the one rule that side of the contract has.
 */
export function validateStats(doc, paths = []) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    return { ok: false, problems: [`The document is ${show(doc)}. A stats endpoint answers a JSON object.`], resolved: [] };

  const resolved = [];
  const problems = [];
  for (const line of paths) {
    const m = /^@count\((.+)\)$/i.exec(line.trim());
    const path = (m ? m[1] : line).trim();
    const count = !!m;
    const parts = [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((p) => (p[2] !== undefined ? Number(p[2]) : p[1]));
    let node = doc;
    const walked = [];
    let why = null;
    for (const part of parts) {
      if (node === null || node === undefined) { why = `${walked.join(".") || "the document"} is null, so ${path} goes nowhere.`; break; }
      if (typeof part === "number") {
        if (!Array.isArray(node)) { why = `${walked.join(".") || "the document"} is not an array, so [${part}] means nothing here.`; break; }
        if (part >= node.length) { why = `${walked.join(".") || "the document"} has ${node.length} item(s), so [${part}] is past the end.`; break; }
        node = node[part]; walked.push(`[${part}]`); continue;
      }
      if (typeof node !== "object" || Array.isArray(node)) { why = `${walked.join(".") || "the document"} is not an object, so “${part}” cannot be read from it.`; break; }
      if (!(part in node)) {
        why = `${walked.length ? walked.join(".") : "the document"} has no “${part}”. It has: ${Object.keys(node).slice(0, 8).join(", ") || "nothing"}.`;
        break;
      }
      node = node[part]; walked.push(part);
    }
    if (why) { problems.push(`${line}: ${why}`); resolved.push({ path: line, value: null, why }); continue; }
    if (count) {
      if (!Array.isArray(node)) { problems.push(`${line}: ${path} is not an array, so @count() has nothing to count.`); resolved.push({ path: line, value: null, why: "not an array" }); continue; }
      resolved.push({ path: line, value: node.length, why: null }); continue;
    }
    const n = typeof node === "number" ? node : typeof node === "string" && node.trim() !== "" ? Number(node) : typeof node === "boolean" ? (node ? 1 : 0) : NaN;
    if (!Number.isFinite(n)) {
      problems.push(`${line}: ${path} is ${node === null ? "null" : Array.isArray(node) ? "an array" : typeof node}, not a number.${Array.isArray(node) ? ` Did you mean @count(${path})?` : ""}`);
      resolved.push({ path: line, value: null, why: "not a number" });
      continue;
    }
    resolved.push({ path: line, value: n, why: null });
  }
  return { ok: problems.length === 0, problems, resolved };
}
