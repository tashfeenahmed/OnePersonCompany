/** Portable run outputs. Only explicitly named files inside OPC's data tree
 * are exported; no request can supply a filesystem path. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { DATA_DIR } from "../../config.ts";
import { looksLikeHtmlReport, sanitizeReportHtml, splitTrailingFence } from "./html.ts";

function evidencePath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid run id");
  return join(DATA_DIR, "run-artifacts", id, "evidence.json");
}

export function saveRunEvidence(id: string, evidence: unknown) {
  const path = evidencePath(id);
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(evidence, null, 2), { mode: 0o600 });
}

export function deleteRunEvidence(id: string) {
  rmSync(resolve(evidencePath(id), ".."), { recursive: true, force: true });
}

export type ArtifactFile = { name: string; data: Buffer };
type Run = { id: string; kind: string; title: string; status: string; output: string; queued_at: string; finished_at: string | null };
type Paper = { typ_path: string | null; pdf_path: string | null; md_path: string | null };

function safeRead(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  if (!realpathSync(path).startsWith(realpathSync(DATA_DIR) + sep)) return null;
  if (stat.size > 32 * 1024 * 1024) throw new Error("An artifact exceeds the 32 MB download limit");
  return readFileSync(path);
}

export function runArtifactFiles(run: Run, paper?: Paper): ArtifactFile[] {
  const files: ArtifactFile[] = [];
  const put = (name: string, data: string | Buffer) => files.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data) });
  const read = (name: string, path: string | null) => { const data = path ? safeRead(path) : null; if (data) put(name, data); };
  const { doc, tail } = splitTrailingFence(run.output);
  if (looksLikeHtmlReport(doc)) {
    put("report.html", sanitizeReportHtml(doc));
    if (tail.trim()) put("suggestions.md", tail.trim());
  } else put("report.md", run.output);
  read("evidence.json", evidencePath(run.id));
  if (paper) {
    read("paper.pdf", paper.pdf_path);
    read("paper.typ", paper.typ_path);
    read("paper.md", paper.md_path);
    if (paper.typ_path && safeRead(paper.typ_path)) {
      const dir = resolve(paper.typ_path, "..");
      read("refs.bib", join(dir, "refs.bib"));
      for (const name of readdirSync(dir).filter(n => /^fig-\d+\.svg$/.test(n)).sort()) read(name, join(dir, name));
    }
  }
  const evidence = files.some(f => f.name === "evidence.json");
  const referencedFigures = [...(files.find(f => f.name === "paper.typ")?.data.toString() ?? "").matchAll(/"(fig-\d+\.svg)"/g)].map(m => m[1]!);
  put("manifest.json", JSON.stringify({
    runId: run.id, kind: run.kind, title: run.title, status: run.status,
    started: run.queued_at, finished: run.finished_at,
    evidence: evidence ? "Saved context and agent notes; agent notes are not independently verified tool output." : "No separate evidence snapshot was saved for this run.",
    files: files.map(f => ({ name: f.name, bytes: f.data.length })),
    missing: paper ? [
      ...(!files.some(f => f.name === "paper.pdf") ? ["paper.pdf"] : []),
      ...(paper.typ_path ? ["paper.typ", "refs.bib"].filter(n => !files.some(f => f.name === n)) : []),
      ...[...new Set(referencedFigures)].filter(n => !files.some(f => f.name === n)),
    ] : [],
  }, null, 2));
  return files;
}

/** Small USTAR archive, regular files only. No subprocesses or dependencies. */
export function artifactArchive(files: ArtifactFile[]): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (const { name, data } of files) {
    if (!/^[a-zA-Z0-9_.-]{1,99}$/.test(name) || name === "." || name === "..") throw new Error("Unsafe artifact name");
    total += data.length;
    if (total > 64 * 1024 * 1024) throw new Error("Artifacts exceed the 64 MB download limit");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    const octal = (value: number, at: number, length: number) => header.write(value.toString(8).padStart(length - 1, "0") + "\0", at, length);
    octal(0o600, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(data.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header.write("0", 156);
    header.write("ustar\0", 257); header.write("00", 263);
    const checksum = header.reduce((a, b) => a + b, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}
