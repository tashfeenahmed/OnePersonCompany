import { useId, useState } from "react";
import { AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "./ui/button";

type Props = {
  status: string;
  storageError: string;
  hasConflict: boolean;
  retry: () => Promise<void> | undefined;
  resolve: (local: boolean) => Promise<void> | undefined;
};

/** Outside the page's layout: appearing, expanding and recovering never
 * move the header or the content someone is reading. */
export function WorkspaceSyncNotice(props: Props) {
  if (!props.status && !props.storageError && !props.hasConflict) return null;
  return <Notice key={props.storageError ? "storage" : props.hasConflict ? "conflict" : "sync"} {...props} />;
}

function Notice({ status, storageError, hasConflict, retry, resolve }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [working, setWorking] = useState(false);
  const detailsId = useId();
  const title = storageError ? "Browser storage needs attention"
    : hasConflict ? "Workspace versions need reviewing" : "Workspace sync is paused";
  async function run(action: () => Promise<void> | undefined) {
    setWorking(true);
    try { await action(); } finally { setWorking(false); }
  }
  return (
    <aside aria-label="Workspace sync" className="fixed right-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-popover text-popover-foreground shadow-lg sm:right-5 sm:bottom-5">
      <div className="flex items-center gap-2 px-3 py-2">
        <AlertCircle aria-hidden="true" className="size-4 shrink-0 text-warn" />
        <p role="status" className="text-sm">{title}</p>
        <Button variant="ghost" size="icon-sm" aria-label={expanded ? "Collapse sync details" : "Review sync details"}
          aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>
          {expanded ? <ChevronDown /> : <ChevronUp />}
        </Button>
      </div>
      {expanded && <div id={detailsId} className="max-h-[60dvh] w-96 max-w-full overflow-y-auto border-t border-border px-4 pt-3 pb-4 text-sm">
        <p className="text-muted-foreground break-words">{storageError || (hasConflict
          ? "This browser and the server have different edits. Choose which version to keep. Your browser copy is backed up before either choice."
          : "The server could not sync your workspace. We'll keep trying automatically.")}</p>
        {storageError && status && <p className="mt-2 text-muted-foreground break-words">{status}</p>}
        {!storageError && status && <p className="mt-2 text-xs text-muted-foreground break-words">{status}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {hasConflict ? <>
            <Button size="sm" variant="secondary" disabled={working} onClick={() => void run(() => resolve(false))}>Use server version</Button>
            <Button size="sm" variant="secondary" disabled={working} onClick={() => void run(() => resolve(true))}>Keep browser version</Button>
          </> : <Button size="sm" variant="secondary" disabled={working} onClick={() => void run(retry)}>{working ? "Retrying…" : "Retry sync"}</Button>}
          <Button asChild size="sm" variant="ghost"><a href="/settings?tab=data">Export or recover</a></Button>
        </div>
      </div>}
    </aside>
  );
}
