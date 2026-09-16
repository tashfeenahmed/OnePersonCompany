import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { DATA_DIR } from "../../config.ts";
import { artifactArchive, runArtifactFiles, saveRunEvidence, deleteRunEvidence } from "./artifacts.ts";

const run = { id: "r-artifact-test", kind: "papers", title: "A paper", status: "done", output: "# Notes", queued_at: "2026-09-16", finished_at: "2026-09-16" };

test("paper archive includes the actual source dependencies, and standard tar can extract their bytes", () => {
  const dir = join(DATA_DIR, "papers", run.id);
  mkdirSync(dir, { recursive: true });
  const fixture = { "paper.typ": '#image("fig-1.svg")\n#bibliography("refs.bib")', "refs.bib": "@article{sample,title={Example}}", "fig-1.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>', "paper.pdf": "%PDF-1.7 sample", "paper.md": "# Paper" };
  for (const [name, value] of Object.entries(fixture)) writeFileSync(join(dir, name), value);
  writeFileSync(join(dir, "private-settings.json"), "must never be exported");
  saveRunEvidence(run.id, { library: [{ title: "Example" }], brief: "Full request" });
  const files = runArtifactFiles(run, { typ_path: join(dir, "paper.typ"), pdf_path: join(dir, "paper.pdf"), md_path: join(dir, "paper.md") });
  const archive = join(DATA_DIR, "test.tar.gz");
  writeFileSync(archive, artifactArchive(files));
  const dest = join(DATA_DIR, "extracted"); mkdirSync(dest);
  execFileSync("tar", ["-xzf", archive, "-C", dest]);
  for (const [name, value] of Object.entries(fixture)) assert.equal(readFileSync(join(dest, name), "utf8"), value);
  assert.ok(files.some(f => f.name === "evidence.json"));
  assert.ok(!files.some(f => f.name === "private-settings.json"));
  deleteRunEvidence(run.id);
  assert.ok(!runArtifactFiles(run).some(f => f.name === "evidence.json"));
});

test("historical HTML reports export as HTML; active code is removed and board suggestions are separate", () => {
  const output = '<!doctype html><html><body><h1>Market</h1><script>alert(1)</script><p onclick="bad()">Findings</p></body></html>\n```json cards\n[]\n```';
  const files = runArtifactFiles({ ...run, output, id: "r-old-report" });
  const html = files.find(f => f.name === "report.html")!.data.toString();
  assert.ok(!/script|onclick/.test(html));
  assert.ok(files.find(f => f.name === "suggestions.md"));
  assert.match(files.find(f => f.name === "manifest.json")!.data.toString(), /No separate evidence snapshot/);
});

test("artifact export rejects traversal and omits symlinks, absent PDFs and unrelated files", () => {
  assert.throws(() => runArtifactFiles({ ...run, id: "../secrets" }), /Invalid run id/);
  assert.throws(() => artifactArchive([{ name: "../secret", data: Buffer.from("x") }]), /Unsafe/);
  const dir = join(DATA_DIR, "unsafe-paper"); mkdirSync(dir);
  writeFileSync(join(DATA_DIR, "secret"), "sensitive");
  symlinkSync(join(DATA_DIR, "secret"), join(dir, "paper.typ"));
  const files = runArtifactFiles({ ...run, id: "r-unsafe" }, { typ_path: join(dir, "paper.typ"), pdf_path: join(dir, "missing.pdf"), md_path: null });
  assert.ok(!files.some(f => f.name === "paper.typ" || f.name === "paper.pdf"));
  const metadata = JSON.parse(files.find(f => f.name === "manifest.json")!.data.toString());
  assert.ok(metadata.missing.includes("paper.pdf"));
  assert.ok(gunzipSync(artifactArchive(files)).length % 512 === 0);
});
