/**
 * A titled block with one line of context, repeated down every Settings tab.
 *
 * IT LIVES IN ITS OWN FILE BECAUSE FOUR FILES DRAW ONE NOW. It was local to
 * Settings.tsx while the page was the only thing with sections in it; the
 * backups, capture and studio blocks are components of their own and each
 * needs the same heading, and a second copy of eight lines of layout is the
 * copy that drifts by two pixels and never gets noticed.
 */
export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2.5 py-5">
      <div>
        <div className="text-[14px] font-medium tracking-tight">{title}</div>
        {hint && (
          <p className="text-muted-foreground mt-0.5 max-w-[560px] text-[13.5px]">
            {hint}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
