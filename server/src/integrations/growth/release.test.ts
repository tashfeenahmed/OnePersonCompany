import assert from "node:assert/strict";
import { test } from "node:test";
import { db, insertAccount, now, upsertPlugin, ventureRowById } from "../../db.ts";
import { appsForVenture, unreleased } from "./aso.ts";
import { queueReleaseAudits, releasedSince } from "./release.ts";

upsertPlugin("appstore", false, null);
const accountId = insertAccount("appstore", "acct");

function venture() {
  db.prepare(
    "INSERT INTO ventures(id,slug,name,description,website,host,stage,color,color_source,created_at,updated_at,position,brand) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("v-sketchapp", "sketchapp", "Sketch App", "", "https://sketchapp.example", "sketchapp.example", "pre-launch", "#123456", "owner", now(), now(), 0, "{}");
  db.prepare(
    `INSERT INTO appstore_apps (account_id, account_label, app_id, bundle_id, name, sku, primary_locale, state, version, on_store, storefront, listed, rating_avg, rating_count, released_at, seen_at)
     VALUES (?,'acct','1000000001','com.example.sketch','Sketch App: Doodles','s','en-US','WAITING_FOR_REVIEW','1.0.0',0,'us',0,NULL,NULL,NULL,?)`,
  ).run(accountId, now());
  return ventureRowById("v-sketchapp")!;
}

test("an app in review is reported as not released with its correct id, never as a wrong id", () => {
  const v = venture();
  const [ref] = appsForVenture(v);
  assert.equal(ref?.onStore, false);
  const why = unreleased(ref!);
  assert.match(why ?? "", /not released yet — App Store Connect state WAITING_FOR_REVIEW; id 1000000001 is the correct id/);
});

test("a release (0 → 1) queues exactly one ASO run for the venture", () => {
  const before = new Map([
    ["1000000001", false],
    ["other", true],
  ]);
  const released = releasedSince(before, [
    { id: "1000000001", onStore: true },
    { id: "other", onStore: true },
    { id: "brand-new", onStore: true },
  ]);
  assert.deepEqual(released, ["1000000001"]);
  db.prepare("UPDATE appstore_apps SET on_store = 1, state = 'READY_FOR_DISTRIBUTION' WHERE app_id = '1000000001'").run();
  const first = queueReleaseAudits(released);
  assert.equal(first.length, 1);
  const again = queueReleaseAudits(released);
  assert.equal(again.length, 0, "an ASO run already queued is not queued twice");
  const row = db.prepare("SELECT kind, venture_id, status FROM agent_runs WHERE id = ?").get(first[0]!) as {
    kind: string;
    venture_id: string;
    status: string;
  };
  assert.deepEqual({ ...row }, { kind: "aso", venture_id: "v-sketchapp", status: "queued" });
});
