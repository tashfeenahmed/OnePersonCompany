import { useState } from "react";
import { AlertTriangle, Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { Section } from "@/components/settings/Section";
import { cn } from "@/lib/utils";
import { migrateApi, type Batch, type Endpoint } from "@/lib/api/migrate";

/**
 * MIGRATION — what came across from a predecessor, and what the adapters
 * publish.
 *
 * THERE IS NO IMPORT BUTTON ON THIS PAGE AND THE ABSENCE IS THE DESIGN. An
 * import reads a directory off the server's filesystem, takes a backup and
 * writes to eleven tables in one transaction; the server publishes no route
 * that starts one, for the same reason `cli/restore.ts` is a command. So the
 * command is PRINTED, verbatim, with the flag that makes it safe first — and
 * the page is the ledger of what happened, not the thing that makes it happen.
 *
 * ROLLBACK IS A BUTTON, and the asymmetry is deliberate: undoing takes only a
 * batch id this database already holds. It is destructive, it says so in those
 * words, and the confirm names the row counts rather than asking "are you
 * sure" — a count is a fact somebody can weigh and a rhetorical question is not.
 *
 * THE ADAPTER HALF ANSWERS ONE QUESTION: is each product endpoint actually
 * publishing what this box asks for. Three states, and they are not the same:
 * a COLLECTION that worked, a VALIDATION somebody ran on a sample (which can
 * exist before the endpoint is connected), and a MAPPED PATH that resolves. A
 * path that does not resolve is drawn as a mapping error and never as a zero —
 * "the product published 0" and "nobody could find the number" are different
 * facts about the business.
 */

function when(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const POPULATION_ORDER = ["customer", "participant", "admin", "trial", "internal", "unstated"];

function Counts({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (!entries.length) return <span className="text-muted-foreground">nothing</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {entries.map(([kind, n]) => (
        <span key={kind}>
          <span className="tabular-nums font-medium">{n}</span>{" "}
          <span className="text-muted-foreground">{kind.replace(/_/g, " ")}</span>
        </span>
      ))}
    </span>
  );
}

function BatchRow({ batch, onRolledBack }: { batch: Batch; onRolledBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function undo() {
    const total = Object.values(batch.created).reduce((a, b) => a + b, 0);
    /* THE CONFIRM NAMES THE NUMBER. "Are you sure" is a question nobody can
       answer; "this deletes 168 rows and 2 files, including any edits made to
       them since" is a sentence somebody can weigh. */
    if (
      !window.confirm(
        `Roll back ${batch.id}?\n\n` +
          `This deletes ${total} row(s) and ${batch.created.file ?? 0} copied file(s) that this import created — ` +
          `including any edits made to them since. Rows it only MATCHED, such as a venture that already existed, are left alone.\n\n` +
          `This cannot be undone from here.`,
      )
    )
      return;
    setBusy(true);
    setNote(null);
    try {
      const result = await migrateApi.rollback(batch.id);
      const deleted = Object.entries(result.deleted).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing";
      setNote(
        `Deleted ${deleted}. ${result.filesRemoved} file(s) removed` +
          (result.filesKept.length ? `, ${result.filesKept.length} kept because they changed since the import.` : "."),
      );
      onRolledBack();
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-line-soft grid gap-1.5 border-t py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[12.5px] font-medium">{batch.id}</span>
          {batch.dryRun && (
            <span className="bg-warn/15 text-warn rounded px-1.5 py-px text-[11px]">dry run — wrote nothing</span>
          )}
          {batch.rolledBackAt && (
            <span className="text-muted-foreground bg-muted rounded px-1.5 py-px text-[11px]">
              rolled back {when(batch.rolledBackAt)}
            </span>
          )}
          {batch.ok === false && <span className="text-destructive text-[11px]">failed</span>}
        </div>
        <span className="text-muted-foreground text-[11.5px]">{when(batch.startedAt)}</span>
      </div>

      <div className="text-muted-foreground font-mono text-[11.5px] break-all">{batch.source}</div>

      <div className="text-[12.5px]">
        {batch.dryRun ? (
          <>
            <span className="text-muted-foreground">would have imported </span>
            <Counts counts={Object.fromEntries(Object.entries(batch.counts).map(([k, v]) => [k, v.imported]))} />
          </>
        ) : (
          <>
            <span className="text-muted-foreground">in the database now: </span>
            <Counts counts={batch.created} />
          </>
        )}
      </div>

      {batch.error && <div className="text-destructive text-[12.5px]">{batch.error}</div>}

      <div className="flex flex-wrap items-center gap-3">
        {batch.problems.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="text-muted-foreground hover:text-foreground text-[11.5px] underline underline-offset-2"
          >
            {open ? "hide" : `${batch.problems.length} thing${batch.problems.length === 1 ? "" : "s"} worth reading`}
          </button>
        )}
        {batch.backup && (
          <span className="text-muted-foreground font-mono text-[11px]">backup {batch.backup}</span>
        )}
        {batch.reversible && (
          <Button size="sm" variant="destructive" className="h-7 text-[12px]" disabled={busy} onClick={undo}>
            {busy ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Undo2 className="mr-1 size-3" />}
            Roll back
          </Button>
        )}
      </div>

      {open && (
        <ul className="text-muted-foreground grid gap-1 text-[12px]">
          {batch.problems.map((p, i) => (
            <li key={i} className="border-line-soft border-l-2 pl-2">
              {p}
            </li>
          ))}
        </ul>
      )}

      {note && <div className="text-[12.5px]">{note}</div>}
    </div>
  );
}

function EndpointRow({ endpoint }: { endpoint: Endpoint }) {
  const v = endpoint.validated;
  return (
    <div className="border-line-soft grid gap-1 border-t py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium">{endpoint.label}</span>
          <span className="text-muted-foreground text-[11px]">
            {endpoint.plugin === "users"
              ? "users contract"
              : endpoint.plugin === "product-stats"
                ? "product-stats"
                : "validated, not connected yet"}
          </span>
          {!endpoint.connected && endpoint.plugin !== "unconnected" && (
            <span className="text-warn text-[11px]">not connected</span>
          )}
        </div>
        {endpoint.plugin !== "unconnected" && (
          <span className="text-muted-foreground text-[11.5px]">
            <span
              className={cn(
                "mr-1.5 inline-block size-1.5 rounded-full align-middle",
                endpoint.lastOk === null ? "bg-muted-foreground/40" : endpoint.lastOk ? "bg-ok" : "bg-destructive",
              )}
            />
            collected {when(endpoint.lastRead)}
          </span>
        )}
      </div>

      {endpoint.lastError && <div className="text-destructive text-[12px]">{endpoint.lastError}</div>}

      {/* THE VALIDATION, which is a different fact from the collection: a
          sample can be checked before the endpoint is connected, and an
          endpoint that has gone quiet still has its last good validation. */}
      {v ? (
        <div className="text-[12.5px]">
          <span className={v.ok ? "text-ok" : "text-destructive"}>
            {v.ok ? "sample accepted" : "sample REFUSED"}
          </span>
          <span className="text-muted-foreground"> {when(v.ts)}</span>
          {v.rows !== null && <span className="text-muted-foreground"> · {v.rows} row(s)</span>}
          {Object.values(v.populations).some((n) => n > 0) && (
            <span className="text-muted-foreground">
              {" · "}
              {POPULATION_ORDER.filter((k) => (v.populations[k] ?? 0) > 0)
                .map((k) => `${v.populations[k]} ${k}`)
                .join(", ")}
            </span>
          )}
          {v.contactable !== null && (
            <span className="text-muted-foreground"> · {v.contactable} contactable</span>
          )}
          {v.problems.length > 0 && (
            <ul className="text-muted-foreground mt-1 grid gap-0.5 text-[12px]">
              {v.problems.slice(0, 4).map((p, i) => (
                <li key={i} className="border-line-soft border-l-2 pl-2">
                  {p}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="text-muted-foreground text-[12px]">
          No sample has ever been validated against the contract here.
        </div>
      )}

      {/* MAPPED PATHS. A `why` is a mapping error and is drawn as one; it is
          never rendered as a zero, which is the single rule the product-stats
          contract has. */}
      {endpoint.metrics && endpoint.metrics.length > 0 && (
        <div className="mt-0.5 grid gap-0.5">
          {endpoint.metrics.map((m) => (
            <div key={m.label} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
              <span className="text-muted-foreground">{m.label}</span>
              <span className="text-muted-foreground/60 font-mono text-[11px]">{m.path}</span>
              {m.why === null ? (
                <span className="tabular-nums font-medium">{m.value?.toLocaleString()}</span>
              ) : (
                <span className="text-destructive">mapping error — {m.why}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MigrationSettings() {
  const batches = useApi(() => migrateApi.batches(), []);
  const adapters = useApi(() => migrateApi.adapters(), []);

  return (
    <>
      <Section
        title="Imports"
        hint={
          <>
            Every run of the importer, newest first. There is no button here on purpose: an import reads a
            directory off this machine's disk and writes to every table in one transaction, so it is a command
            run in a shell with the server's own data directory in front of you. Run the dry run first — it
            writes nothing and prints exactly what a real run would do.
          </>
        }
      >
        <pre className="bg-muted text-muted-foreground overflow-x-auto rounded p-2.5 text-[11.5px] leading-relaxed">
          {`npm run import-workdash -- /opt/workdash --dry-run
npm run import-workdash -- /opt/workdash
npm run import-workdash -- --rollback <batch>`}
        </pre>
        <p className="text-muted-foreground max-w-[560px] text-[12px]">
          No credential is ever read. Files holding secrets are refused by name and the plugins they belong to
          are printed as a list to reconnect by hand, in Integrations. A real run takes a full backup first and
          refuses to proceed if that fails.
        </p>

        {batches.error && <div className="text-destructive text-[12.5px]">{batches.error}</div>}
        {batches.loading && !batches.data && (
          <div className="text-muted-foreground text-[12.5px]">Loading…</div>
        )}
        {batches.data && batches.data.batches.length === 0 && (
          <div className="text-muted-foreground text-[12.5px]">
            Nothing has been imported. This dashboard's own data is untouched by anything on this tab.
          </div>
        )}
        {batches.data && batches.data.batches.length > 0 && (
          <div className="grid">
            {batches.data.batches.map((b) => (
              <BatchRow key={b.id} batch={b} onRolledBack={batches.reload} />
            ))}
          </div>
        )}
        {batches.data && batches.data.batches.some((b) => b.reversible) && (
          <p className="text-warn flex max-w-[560px] items-start gap-1.5 text-[12px]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            Rolling back deletes exactly the rows an import created, including any edits made to them since.
            Rows it only matched — a venture that was already here — are left alone.
          </p>
        )}
      </Section>

      <Section
        title="Product endpoints"
        hint={
          <>
            The adapters that publish the users and product-stats contracts, with the last collection and the
            last sample validated against the contract. Those are different facts: a sample can be checked
            before an endpoint is connected, and an endpoint that has gone quiet still shows what it last
            published. The templates live in <code className="text-[11.5px]">deploy/adapters/</code>.
          </>
        }
      >
        {adapters.error && <div className="text-destructive text-[12.5px]">{adapters.error}</div>}
        {adapters.loading && !adapters.data && (
          <div className="text-muted-foreground text-[12.5px]">Loading…</div>
        )}
        {adapters.data && adapters.data.endpoints.length === 0 && (
          <div className="text-muted-foreground text-[12.5px]">
            No product endpoint is connected. Add one under Integrations — Product users for the signup
            contract, Product endpoints for anything the product counts about itself.
          </div>
        )}
        {adapters.data && adapters.data.endpoints.length > 0 && (
          <div className="grid">
            {adapters.data.endpoints.map((e) => (
              <EndpointRow key={`${e.plugin}-${e.accountId}-${e.label}`} endpoint={e} />
            ))}
          </div>
        )}

        {/* WHAT THE USERS TABLE ACTUALLY HOLDS, which is the proof the
            population field is live rather than merely accepted. A product
            that never sends it counts entirely as `customer` — the documented
            default — and that is said here rather than looking like a finding. */}
        {adapters.data && adapters.data.populations.length > 0 && (
          <div className="mt-1 grid gap-1">
            <div className="text-[12.5px] font-medium">Populations held</div>
            {adapters.data.populations.map((p) => (
              <div key={p.accountId} className="flex flex-wrap items-baseline gap-x-3 text-[12px]">
                <span className="text-muted-foreground">{p.product}</span>
                {POPULATION_ORDER.filter((k) => (p.populations[k] ?? 0) > 0).map((k) => (
                  <span key={k}>
                    <span className="tabular-nums font-medium">{p.populations[k]}</span>{" "}
                    <span className="text-muted-foreground">{k}</span>
                  </span>
                ))}
                <span className="text-muted-foreground">{p.contactable} contactable</span>
              </div>
            ))}
            <p className="text-muted-foreground max-w-[560px] text-[12px]">
              A product whose endpoint never sends a population counts entirely as “customer”, which is the
              documented default for the older contract — so all-customers may mean classified, or may mean not
              classified at all. Contactable is false unless an adapter was configured with an explicit consent
              mapping; nothing here can turn a contactable row back into an address.
            </p>
          </div>
        )}
      </Section>
    </>
  );
}
