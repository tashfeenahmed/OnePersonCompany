import { useState } from "react";
import { Archive, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { bytes, when } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Section } from "@/components/settings/Section";
import { PluginSettingsForm } from "@/components/settings/PluginSettingsForm";
import {
  backupsApi,
  type BackupRestore,
  type BackupResult,
  type BackupVerified,
} from "@/lib/api/studio";

/**
 * BACKUPS — the state of the archives, the settings, and the three buttons.
 *
 * THE QUESTION THIS SECTION EXISTS TO ANSWER is "if this laptop died tonight,
 * what comes back" — so the server's own one-sentence verdict is the first
 * thing drawn, above the settings, and an archive list with no verdict over it
 * would be a list of files rather than an answer.
 *
 * RESTORE DOES NOT RESTORE AND THIS PAGE SAYS SO IN THOSE WORDS. The route
 * extracts an archive and hands back the steps; the swap is a CLI command run
 * with the server stopped, because this process is holding the database file
 * it would be overwriting. `swapped` comes back `false` on every successful
 * call and the panel is written around that fact rather than around a success
 * state that does not exist. The five steps are printed verbatim — they are
 * the server's, they name real paths on this machine, and paraphrasing them
 * here would be a second source of truth for a destructive operation.
 *
 * THE WARNING IS NOT DECORATION. The archive contains vault.key in plaintext,
 * which means anywhere it is copied to is somewhere every credential on this
 * box effectively lives. It is drawn beside the remote field and again beside
 * a finished run, because those are the two moments a copy actually moves.
 *
 * VERIFY IS PER ARCHIVE AND IS NOT RUN ON LOAD. `tar -tzv` over fourteen
 * archives on a spinning disk is not something a settings page should do for
 * anybody who happened to open it; and "readable" is a claim worth having
 * asked for, one file at a time.
 */

/** A backup that has not happened HAS NOT HAPPENED — the em dash `when`
 *  defaults to would be the weaker claim, and this is one of the few surfaces
 *  where the strong one is true. */
const NEVER = { nullText: "never" } as const;

export function BackupsSettings() {
  const doc = useApi(() => backupsApi.get(), []);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BackupResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /** The archive whose verify/restore is open, and what came back for it. */
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [verified, setVerified] = useState<BackupVerified | null>(null);
  const [extracted, setExtracted] = useState<BackupRestore | null>(null);

  const d = doc.data;

  async function backUpNow() {
    setRunning(true);
    setProblem(null);
    setResult(null);
    try {
      setResult(await backupsApi.run());
      doc.reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function verify(file: string) {
    setOpenFile(file);
    setVerified(null);
    setExtracted(null);
    setProblem(null);
    setChecking(true);
    try {
      setVerified(await backupsApi.verify(file));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  async function extract(file: string) {
    setChecking(true);
    setProblem(null);
    try {
      setExtracted(await backupsApi.restore(file));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Section
      title="Backups"
      hint="One archive a night, or one when you press the button: a consistent snapshot of the database, the vault key, the stored keys, the screenshots and the studio's pictures."
    >
      {doc.error && (
        <p className="text-muted-foreground text-[13.5px]">
          The API did not answer, so nothing can be said about the backups.{" "}
          <span className="text-destructive">{doc.error}</span>
        </p>
      )}

      {d && (
        <>
          {/* The verdict, first. */}
          <div className="bg-card grid gap-1 rounded-[14px] border px-4.5 py-3.5">
            <div className="text-[14px]">{d.summary.state}</div>
            <p className="text-muted-foreground text-[12.5px]">
              {d.archives.length} in {d.settings.dir}
              {!d.settings.dirExists && " — which does not exist yet"}
              {d.archives.length > 0 && ` · ${bytes(d.totalBytes)} in all`}
              {" · "}
              {d.settings.nightly
                ? `nightly at ${String(d.settings.hour).padStart(2, "0")}:00, next ${when(d.nextRunAt, NEVER)}`
                : "the nightly run is off"}
              {" · "}
              keeping {d.settings.keep}
              {d.settings.remote
                ? ` · copied to ${d.settings.remote}${d.settings.remoteKey ? ` with ${d.settings.remoteKey}'s key` : ""}`
                : " · no remote copy"}
            </p>
          </div>

          {/* WHAT IS IN THE FILE, and the sentence that decides where it may
              be put. Both come off the wire — this page does not keep its own
              list of what the server packs. */}
          <div className="text-muted-foreground grid gap-1 text-[12.5px]">
            <p>
              Always: {d.contents.always.join("; ")}. When present:{" "}
              {d.contents.whenPresent.join(", ")}. Never:{" "}
              {d.contents.never.join(" ")}
            </p>
            <p className="text-warn flex items-start gap-1.5">
              <ShieldAlert className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
              <span>{d.contents.warning}</span>
            </p>
          </div>
        </>
      )}

      <div className="mt-1">
        <PluginSettingsForm
          plugin="backups"
          onSaved={() => doc.reload()}
          saveLabel="Save backup settings"
        />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => void backUpNow()} disabled={running}>
          {running ? (
            <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} />
          ) : (
            <Archive className="size-[15px]" strokeWidth={1.8} />
          )}
          {running ? "Backing up…" : "Back up now"}
        </Button>
        <span className="text-muted-foreground text-[13px]">
          {running
            ? "A snapshot, then the tar, then the copy — the page waits for all three."
            : "Writes one archive now, then prunes to the number kept."}
        </span>
      </div>

      {problem && (
        <p className="text-destructive text-[13.5px] leading-relaxed">{problem}</p>
      )}

      {result && (
        <div
          className={cn(
            "grid gap-1 rounded-[14px] border px-3.5 py-3 text-[13.5px]",
            result.ok ? "border-ok/40" : "border-destructive/40",
          )}
        >
          <div>
            {result.ok
              ? `Wrote ${result.name} — ${bytes(result.bytes)} in ${(result.ms / 1000).toFixed(1)}s.`
              : `The backup failed. ${result.error ?? ""}`}
          </div>
          {result.ok && (
            <p className="text-muted-foreground text-[12.5px]">
              In it: {result.members.join(", ") || "the database alone"}
              {result.skipped.length > 0 &&
                ` · not present, so skipped: ${result.skipped.join(", ")}`}
              {result.pruned.length > 0 &&
                ` · pruned ${result.pruned.length} older ${result.pruned.length === 1 ? "archive" : "archives"}`}
            </p>
          )}
          {/* THE COPY IS REPORTED SEPARATELY FROM THE BACKUP, because a failed
              copy does not fail the backup — the local archive is real either
              way, and saying "backup failed" here would be a lie that sends
              somebody looking for a file that exists. */}
          {result.remote.attempted && (
            <p
              className={cn(
                "text-[12.5px]",
                result.remote.ok ? "text-muted-foreground" : "text-warn",
              )}
            >
              {result.remote.ok
                ? `Copied to ${result.remote.target}.`
                : `The copy to ${result.remote.target} did not leave — ${result.remote.error ?? "no reason given"}. The local archive is still a real backup.`}
            </p>
          )}
          {result.ok && (
            <p className="text-warn text-[12.5px]">{result.warning}</p>
          )}
        </div>
      )}

      {/* ------------------------------------------------------- archives */}
      {d && d.archives.length > 0 && (
        <div className="overflow-hidden rounded-[14px] border">
          {d.archives.map((a, i) => (
            <div key={a.name} className={cn(i > 0 && "border-line-soft border-t")}>
              <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                  {a.name}
                </span>
                <span className="text-muted-foreground shrink-0 text-[12.5px] tabular-nums">
                  {bytes(a.bytes)}
                </span>
                <span className="text-muted-foreground shrink-0 text-[12.5px]">
                  {when(a.at, NEVER)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={checking && openFile === a.name}
                  onClick={() => void verify(a.name)}
                >
                  Verify
                </Button>
              </div>

              {openFile === a.name && (
                <div className="border-line-soft grid gap-2 border-t px-3.5 py-2.5">
                  {checking && !verified && (
                    <p className="text-muted-foreground text-[13px]">
                      Reading the table of contents with tar…
                    </p>
                  )}
                  {verified && (
                    <>
                      <p
                        className={cn(
                          "text-[13.5px]",
                          verified.ok && verified.hasDatabase && verified.hasVaultKey
                            ? "text-foreground"
                            : "text-warn",
                        )}
                      >
                        {verified.state}
                      </p>
                      <p className="text-muted-foreground text-[12.5px]">
                        {verified.members.length}{" "}
                        {verified.members.length === 1 ? "member" : "members"},{" "}
                        {bytes(verified.bytes)} on disk
                        {verified.error ? ` · ${verified.error}` : ""}
                      </p>
                      {verified.ok && !extracted && (
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={checking}
                            onClick={() => void extract(a.name)}
                          >
                            Unpack it and show me the steps
                          </Button>
                          <span className="text-muted-foreground text-[12.5px]">
                            Unpacking replaces nothing.
                          </span>
                        </div>
                      )}
                    </>
                  )}

                  {extracted && (
                    <div className="grid gap-1.5">
                      {/* SAID FIRST, because it is what a person who pressed
                          a button called "restore" will assume happened. */}
                      <p className="text-warn text-[13.5px] leading-relaxed">
                        Nothing has been replaced. {extracted.note}
                      </p>
                      <p className="text-muted-foreground text-[12.5px]">
                        Unpacked to{" "}
                        <span className="font-mono">{extracted.extractedTo}</span>
                        {" · "}
                        {extracted.hasDatabase
                          ? "the database is in it"
                          : "there is NO database in it"}
                        {", "}
                        {extracted.hasVaultKey
                          ? "and so is the vault key"
                          : "and NO vault key — every stored credential would restore as unreadable ciphertext"}
                      </p>
                      <ol className="text-muted-foreground grid list-decimal gap-1 pl-4 text-[13px] leading-relaxed">
                        {extracted.steps.map((s) => (
                          <li key={s} className="break-words">
                            {s}
                          </li>
                        ))}
                      </ol>
                      {/* THE BARE NAME, WHICH IS WHAT THE CLI TAKES. Verify
                          and restore echo `file` back as the RESOLVED PATH,
                          not as what was sent — so printing that here would
                          hand somebody a command with an absolute path in it
                          where the server's own step 2 says the file name.
                          The row already knows the name. */}
                      <p className="text-muted-foreground text-[12.5px]">
                        The one command, from the server directory:{" "}
                        <span className="text-foreground font-mono text-[12.5px]">
                          npm run restore -- {a.name}
                        </span>
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ----------------------------------------------------------- runs */}
      {d && d.runs.length > 0 && (
        <div className="grid gap-1">
          <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
            Runs
          </div>
          <div className="grid gap-0.5">
            {d.runs.map((r) => (
              <div
                key={`${r.ts}-${r.file ?? "none"}`}
                className="text-muted-foreground flex flex-wrap items-baseline gap-x-2 text-[12.5px]"
              >
                <span className="tabular-nums">{when(r.ts, NEVER)}</span>
                <span>{r.kind}</span>
                <span className={r.ok ? "text-ok" : "text-destructive"}>
                  {r.ok ? "wrote an archive" : "failed"}
                </span>
                {r.bytes !== null && <span>{bytes(r.bytes)}</span>}
                {r.ms !== null && <span>{(r.ms / 1000).toFixed(1)}s</span>}
                {/* null is "no remote configured" and is drawn as nothing at
                    all — never as a failed copy. */}
                {r.remoteOk === true && <span>copied</span>}
                {r.remoteOk === false && (
                  <span className="text-warn">the copy did not leave</span>
                )}
                {r.error && <span className="text-warn">{r.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}
