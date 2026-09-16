import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { db, now, setConfig, upsertPlugin } from "../../db.ts";
import { assetRow, defaultReferenceIds, markUsed, removeAsset, updateAsset } from "./assets.ts";
import { resolveLibraryReferences } from "./manifest.ts";
import { brandOverrides, saveGuide } from "../references/guide.ts";
import { createItem, itemRow, cancel, patchItem } from "./items.ts";
import { sourceDeletionProblem } from "./sourceDeletion.ts";
import { nextSlot } from "./autopilot-hook.ts";
import { queuedToday, nextRunAt, nextVideoFormat, schedule as autopilotSchedule } from "../video/autopilot.ts";
import { remember } from "../socialfeed/novelty.ts";
import { sweep } from "../socialfeed/deliver.ts";

function venture(id: string) {
  db.prepare(`INSERT INTO ventures (id,slug,name,description,stage,color,color_source,position,brand,created_at,updated_at)
    VALUES (?,?,?,'Test venture','launched','#123456','default',0,'{}',?,?)`).run(id,id,id,now(),now());
  return id;
}
function file(id: string) {
  const path = resolve(DATA_DIR, "fixtures", id);
  mkdirSync(resolve(DATA_DIR, "fixtures"), { recursive: true });
  writeFileSync(path, Buffer.from([0x89,0x50,0x4e,0x47,13,10,26,10,0]));
  return path;
}
function asset(id: string, ventureId: string, kind = "reference") {
  const path = file(id + ".png");
  db.prepare(`INSERT INTO venture_assets (id,venture_id,kind,path,mime,source,prompt,notes,created_at,updated_at)
    VALUES (?,?,?,?,'image/png','upload','Keep the blue hands','Private library note',?,?)`).run(id,ventureId,kind,path,now(),now());
  return path;
}
function clips(run: string, ventureId: string) {
  db.prepare(`INSERT INTO agent_runs (id,kind,venture_id,title,status,queued_at,finished_at)
    VALUES (?,'video',?,'Test Shorts','done',?,?)`).run(run,ventureId,now(),now());
  db.prepare("INSERT INTO video_jobs (run_id,venture_id,format,ts) VALUES (?,?,'shorts',?)").run(run,ventureId,now());
  for (const index of [1,2]) db.prepare(`INSERT INTO video_clips (run_id,idx,title,chosen_by,start_s,end_s,path)
    VALUES (?,?,?,'test',0,10,?)`).run(run,index,`Clip ${index}`,file(`${run}-${index}.mp4`));
}
function log(ts: string, kind: string, action = "queued", ref: string | null = null) {
  db.prepare("INSERT INTO video_autopilot_log (ts,pass_id,kind,action,ref) VALUES (?,'test-pass',?,?,?)").run(ts,kind,action,ref);
}

test("daily cap counts generated items on the owner's local day, excluding pass summaries", () => {
  log("2030-09-15T18:29:00.000Z","post");
  log("2030-09-15T18:31:00.000Z","post");
  log("2030-09-15T18:32:00.000Z","video");
  log("2030-09-15T18:33:00.000Z","pass");
  log("2030-09-15T18:34:00.000Z","video","skipped");
  log("2030-09-16T05:00:00.000Z","video");
  assert.equal(queuedToday("Asia/Kolkata",new Date("2030-09-16T04:00:00Z")),2);
});

test("scheduling honours fractional UTC offsets and the Dublin daylight-saving change", () => {
  const at = new Date("2030-09-16T00:00:00Z");
  assert.equal(nextSlot("Asia/Kolkata",9,30,at),"2030-09-16T04:00:00.000Z");
  assert.equal(nextSlot("Asia/Kathmandu",9,0,at),"2030-09-16T03:15:00.000Z");
  assert.equal(nextSlot("Europe/Dublin",9,0,new Date("2026-03-28T12:00:00Z")),"2026-03-29T08:00:00.000Z");
  assert.equal(nextRunAt({...autopilotSchedule(),enabled:true,hour:9,timezone:"Asia/Kathmandu"},at),"2030-09-16T03:15:00.000Z");
});

test("Autopilot rotates selected formats per venture instead of repeating the first", () => {
  const id = venture("rotation");
  const formats = ["faceless","motion","shorts"];
  assert.equal(nextVideoFormat(id,formats),"faceless");
  const one = remember({ventureId:id,format:"faceless",topic:"first"});
  db.prepare("UPDATE content_history SET created_at = '2026-01-01' WHERE id = ?").run(one.id);
  assert.equal(nextVideoFormat(id,formats),"motion");
  remember({ventureId:id,format:"motion",topic:"second"});
  assert.equal(nextVideoFormat(id,formats),"shorts");
  assert.equal(nextVideoFormat(id,[]),null);
});

test("reference instructions can be cleared without clearing fields omitted from the edit", () => {
  const id = venture("ref-edit"); asset("edit-ref",id);
  assert.ok(updateAsset("edit-ref",{prompt:"  "}).ok);
  assert.equal(assetRow("edit-ref")?.prompt,null);
  assert.equal(assetRow("edit-ref")?.notes,"Private library note");
});

test("logo selection validates ownership, kind and bytes; moving or deleting clears selection", () => {
  const a = venture("brand-a"), b = venture("brand-b");
  asset("logo-a",a,"logo"); asset("logo-b",b,"logo"); asset("photo-a",a);
  assert.equal(saveGuide(a,{logo:"absent"}).ok,false);
  assert.equal(saveGuide(a,{logo:"logo-b"}).ok,false);
  assert.equal(saveGuide(a,{logo:"photo-a"}).ok,false);
  assert.equal(saveGuide(a,{logo:"logo-a"}).ok,true);
  assert.equal(updateAsset("logo-a",{ventureId:b}).ok,true);
  assert.equal(brandOverrides(a).logo,null);
  assert.equal(saveGuide(b,{logo:"logo-a"}).ok,true);
  assert.equal(removeAsset("logo-a").ok,true);
  assert.equal(brandOverrides(b).logo,null);
  unlinkSync(assetRow("logo-b")!.path);
  assert.equal(saveGuide(b,{logo:"logo-b"}).ok,false);
});

test("automatic references rotate available photos and retain per-photo instructions with image inputs", async () => {
  const id = venture("ref-rotation");
  for (const name of ["rotate-1","rotate-2","rotate-3","rotate-4"]) asset(name,id);
  asset("rotate-logo",id,"logo");
  const gone = asset("rotate-gone",id); unlinkSync(gone);
  assert.deepEqual(defaultReferenceIds(id),["rotate-1","rotate-2","rotate-3"]);
  markUsed(["rotate-1"]);
  assert.deepEqual(defaultReferenceIds(id),["rotate-2","rotate-3","rotate-4"]);
  const refs = await resolveLibraryReferences(id,["rotate-2","logo-b"],"openai/gpt-image-2.5-sunburst");
  assert.equal(refs.dataUrls.length,1);
  assert.ok(refs.texts.some(text => text.includes("Keep the blue hands")));
  assert.equal(refs.texts.length,1);
});

test("each Shorts clip has its own idempotent draft and protects the source from deletion", () => {
  const id = venture("clip-owner"); clips("run-clips",id);
  const a = createItem({source:{kind:"video_clip",id:"run-clips:1"}});
  const b = createItem({source:{kind:"video_clip",id:"run-clips:2"}});
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.item.id,b.item.id);
  assert.equal(a.item.caption,"Clip 1");
  const again = createItem({source:{kind:"video_clip",id:"run-clips:1"}});
  assert.ok(again.ok); assert.equal(again.item.id,a.item.id);
  assert.ok(sourceDeletionProblem("video_job","run-clips"));
  assert.equal(createItem({ventureId:venture("wrong-owner"),source:{kind:"video_clip",id:"run-clips:1"}}).ok,false);
  assert.equal(createItem({source:{kind:"video_clip",id:"run-clips:0"}}).ok,false);
  assert.ok(cancel(a.item.id).ok); assert.ok(cancel(b.item.id).ok);
  assert.equal(sourceDeletionProblem("video_job","run-clips"),null);
});

test("Autopilot files all clips as unapproved drafts and retries partial filing without duplicates", async () => {
  const id = venture("delivery-owner"); clips("run-deliver",id);
  upsertPlugin("socialfeed",false,null); setConfig("socialfeed","deliverTo","off");
  upsertPlugin("publishing",false,null); setConfig("publishing","autoSchedule","* = 09:30"); setConfig("publishing","timezone","Asia/Kolkata");
  db.prepare(`INSERT INTO publish_destinations (id,venture_id,plugin_id,account_id,account_label,kind,external_id,enabled,created_at,updated_at)
    VALUES ('dest-delivery',?,'meta',1,'Fixture','page','fixture-page',1,?,?)`).run(id,now(),now());
  log(now(),"video","queued","run-deliver");
  const path = (db.prepare("SELECT path FROM video_clips WHERE run_id='run-deliver' AND idx=2").get() as {path:string}).path;
  unlinkSync(path);
  const first = await sweep();
  assert.ok(first.delivered.some(row => row.ref === "run-deliver" && row.reason));
  assert.equal(db.prepare("SELECT ref FROM socialfeed_deliveries WHERE ref='run-deliver'").get(),undefined);
  const partial = db.prepare("SELECT id FROM publish_items WHERE source_kind='video_clip' AND source_id='run-deliver:1'").get() as { id: string };
  assert.ok(patchItem(partial.id,{ caption: "Owner edited this draft", destinationId: null }).ok);
  writeFileSync(path,"fixture");
  await sweep();
  const drafts = db.prepare("SELECT id FROM publish_items WHERE source_kind='video_clip' AND source_id LIKE 'run-deliver:%'").all() as {id:string}[];
  assert.equal(drafts.length,2);
  for (const draft of drafts) {
    const row = itemRow(draft.id)!;
    assert.equal(row.status,"draft"); assert.equal(row.approved_at,null);
    if (row.id === partial.id) {
      assert.equal(row.caption,"Owner edited this draft"); assert.equal(row.destination_id,null);
    } else assert.equal(row.destination_id,"dest-delivery");
    assert.ok(row.scheduled_for);
  }
  assert.equal((await sweep()).delivered.some(row => row.ref === "run-deliver"),false);
});


test("Autopilot follows the same canonical timezone as Publishing, with legacy fallback", () => {
  upsertPlugin("autopilot",false,null);
  setConfig("autopilot","timezone","America/New_York");
  setConfig("publishing","timezone","Asia/Kathmandu");
  assert.equal(autopilotSchedule().timezone,"Asia/Kathmandu");
  setConfig("publishing","timezone","");
  assert.equal(autopilotSchedule().timezone,"America/New_York");
});
