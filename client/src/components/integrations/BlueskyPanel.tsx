import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { integrations } from "@/lib/api/integrations";
import { ago, num } from "./format";
import { EntityLinks } from "./EntityLinks";
import { Note, PanelEmpty, PanelSection, Row, Rows, Tiles } from "./Panel";

/**
 * ONE ROW PER HANDLE, AND NOTHING ADDED ACROSS THEM.
 *
 * The public AppView has no notion of "mine" — it answers for any handle on
 * the network — so the list is exactly what the owner typed and every figure
 * is captioned with the handle it belongs to rather than implied to be his.
 *
 * FOLLOWERS DO NOT ADD, for Umami's reason wearing different clothes: one
 * person following two of these accounts is one person, and Bluesky publishes
 * nothing that would let anybody de-duplicate them. `combined: null` ships with
 * that sentence and this panel prints it.
 *
 * A TRUNCATED WINDOW IS A FLOOR. Windows are computed from one page of the
 * author feed — fifty posts — so a handle that posted more than fifty in the
 * window has "at least this many" rather than a total, and the row says so
 * rather than quietly under-reporting.
 *
 * ENGAGEMENT IS WHAT THOSE POSTS CARRY NOW, not what they earned inside the
 * window. An old post gathering new likes moves this figure, which is why it
 * is never drawn as a rate of anything per day.
 */
export function BlueskyPanel({ onCollected }: { onCollected?: () => void }) {
  const report = useApi(() => integrations.bluesky(30), []);
  const map = useApi(() => integrations.ventureMap(), []);
  const [collecting, setCollecting] = useState(false);

  async function collect() {
    setCollecting(true);
    try {
      await api.collect("bluesky");
      report.reload();
      onCollected?.();
    } finally {
      setCollecting(false);
    }
  }

  if (report.error || !report.data) return null;
  const d = report.data;

  if (!d.handles.length)
    return (
      <PanelEmpty>
        No handles are set, so there is nobody to read. Add them in Settings
        above — the public API needs no key, only a list.
      </PanelEmpty>
    );

  const last30 = d.portfolio.last30;

  return (
    <PanelSection
      title="What it reads"
      meta={`${d.portfolio.answering} of ${d.portfolio.handles} answering`}
      onCollect={() => void collect()}
      collecting={collecting}
    >
      <Tiles
        items={[
          {
            v: num(last30.posts),
            k: last30.anyTruncated ? "posts in 30 days — at least" : "posts in 30 days",
          },
          { v: num(last30.likes), k: "likes on those posts, now" },
          { v: num(last30.reposts), k: "reposts by others" },
          { v: num(last30.replies), k: "replies" },
        ]}
      />

      <Rows>
        {d.handles.map((h, i) => {
          const w30 = h.windows.find((x) => x.days === 30);
          return (
            <Row key={h.handle} first={i === 0}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-[13px] font-medium">
                  {h.displayName ?? `@${h.handle}`}
                </span>
                <span className="text-muted-foreground font-mono text-[11.5px]">
                  @{h.handle}
                </span>
                {w30?.held && w30.truncated && (
                  <Badge variant="secondary" className="font-normal">
                    truncated — a floor
                  </Badge>
                )}
                <span className="text-muted-foreground ml-auto text-[11.5px]">
                  read {ago(h.profile.seenAt)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] tabular-nums">
                <span>{num(h.profile.followers)} followers</span>
                <span className="text-muted-foreground">
                  {h.growth.change === null
                    ? "no growth figure yet"
                    : `${h.growth.change >= 0 ? "+" : ""}${num(h.growth.change)} over ${h.growth.readings} readings`}
                </span>
                <span className="text-muted-foreground">
                  {num(h.profile.posts)} posts all told
                </span>
                {w30?.held && (
                  <span className="text-muted-foreground">
                    {num(w30.posts)} in 30 days · {num(w30.likes)} likes ·{" "}
                    {w30.perPost === null
                      ? "no per-post rate"
                      : `${w30.perPost} engagements a post`}
                  </span>
                )}
              </div>
              {h.growth.note && (
                <p className="text-muted-foreground mt-1 text-[11.5px]">
                  {h.growth.note}
                </p>
              )}
              {h.lastError && (
                <p className="text-destructive mt-1 text-[11.5px]">{h.lastError}</p>
              )}
              <EntityLinks
                map={map.data}
                plugin="bluesky"
                entity={h.entity}
                label={h.displayName ? `${h.displayName} (@${h.handle})` : `@${h.handle}`}
                onLinked={() => map.reload()}
              />
            </Row>
          );
        })}
      </Rows>

      <Note>
        <b className="text-foreground font-medium">
          Followers are never added across handles.
        </b>{" "}
        {d.portfolio.followers.note}
      </Note>
      <Note>
        {d.notes.engagement} {d.notes.reposts}
      </Note>
    </PanelSection>
  );
}
