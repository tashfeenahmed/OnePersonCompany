import assert from "node:assert/strict";
import { test } from "node:test";
import { filedPath, readFiled, underRoots } from "./filed.ts";

const HOME = "/srv/opc/server/data/hermes/home";
const NOTE =
  "Dossier for Jane Doe written to `/srv/opc/server/data/hermes/home/dossier_jane_doe.md`.\n\n" +
  "The document contains all required sections:\n- **Snapshot**: …\n- **Sources**: 6 links";
const REPORT =
  "## Snapshot\nJane Doe is the founder of Acme, based in Dublin, per her LinkedIn profile.\n\n" +
  "## What they're building\n- Acme (launched, per the company site)\n- A second thing (stage unknown)\n\n" +
  "## Recent public activity\n- 2026-08-20: shipped v2 (GitHub release)\n\n" +
  "## Sources\n- https://example.com — the profile\n- https://example.com/acme — the company site\n";

test("filedPath finds the one .md path in a note about a saved file", () => {
  assert.equal(filedPath(NOTE), `${HOME}/dossier_jane_doe.md`);
  assert.equal(filedPath("Saved the report at /tmp/out/report.md and that's all."), "/tmp/out/report.md");
  assert.equal(filedPath('I wrote it to "/a/b/c.md".'), "/a/b/c.md");
});

test("filedPath says null for a real report, a note with no path, and a note naming two files", () => {
  const long = `${NOTE}\n${"x".repeat(2_100)}`;
  assert.equal(filedPath(long), null, "a long answer is a report, not a note");
  assert.equal(filedPath("## Snapshot\nJane Doe is a founder. See /docs/readme.md for context."), null, "no saving verb");
  assert.equal(filedPath("Written to /a/one.md and /a/two.md."), null, "two files is a guess");
  assert.equal(filedPath("Written to /a/one.md and again /a/one.md."), "/a/one.md", "the same file twice is one file");
  assert.equal(filedPath("Saved to ./relative/report.md"), null, "relative paths are not read");
  assert.equal(filedPath(""), null);
});

test("underRoots compares whole path segments after resolving", () => {
  assert.equal(underRoots(`${HOME}/x.md`, [HOME]), true);
  assert.equal(underRoots(`${HOME}/deep/er/x.md`, [HOME]), true);
  assert.equal(underRoots(`${HOME}2/x.md`, [HOME]), false, "a sibling with the same prefix is outside");
  assert.equal(underRoots(`${HOME}/../secrets.md`, [HOME]), false, "dot-dot is resolved before comparing");
  assert.equal(underRoots("/etc/passwd.md", [HOME]), false);
  assert.equal(underRoots(`${HOME}/x.md`, []), false);
});

test("readFiled returns the file's text only when every condition holds", () => {
  const disk = new Map<string, string>([[`${HOME}/dossier_jane_doe.md`, REPORT]]);
  const read = (p: string) => disk.get(p) ?? null;

  assert.deepEqual(readFiled(NOTE, { roots: [HOME], read }), { path: `${HOME}/dossier_jane_doe.md`, text: REPORT.trim() });
  assert.equal(readFiled(NOTE, { roots: ["/srv/opc/server/data/openclaw/home"], read }), null, "outside every root");
  assert.equal(readFiled(NOTE, { roots: [], read }), null, "no roots, no read");
  assert.equal(readFiled(NOTE, { roots: [HOME], read: () => null }), null, "the file is not there");
  assert.equal(readFiled(NOTE, { roots: [HOME], read: () => "   " }), null, "an empty file is not a report");
  assert.equal(readFiled(NOTE, { roots: [HOME], read: () => "short" }), null, "a file shorter than the note is not the report");
  assert.equal(readFiled(REPORT, { roots: [HOME], read }), null, "a real answer is left alone");
});
