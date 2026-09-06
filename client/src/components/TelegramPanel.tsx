import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useApi } from "@/hooks/useApi";
import { api, type TelegramBot } from "@/lib/api";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * What the bridge is doing right now, under the credentials on the Telegram
 * page.
 *
 * FOUR STATES, EACH WITH A SENTENCE, because the two that look identical are
 * the ones that matter: a bot that is polling and waiting to be messaged, and
 * a bot that is polling with no agent behind it, both read as "quiet" from the
 * phone. The first needs a human to send one message; the second needs an
 * integration connected. The card says which.
 *
 * THE PAIRED CHAT IS AN ID, NEVER A NAME. The route sends nothing else and
 * this draws nothing else — the same rule as review authors and correspondents
 * everywhere in this app.
 *
 * `conflict` is drawn amber rather than red, and only after it has survived a
 * few attempts, because the ordinary cause is the API having just restarted:
 * the killed process's long poll stays open on Telegram's side for up to a
 * minute and the new one is refused until it lapses. That recovers on its own
 * and is not a second poller.
 */
export function TelegramPanel() {
  const report = useApi(() => api.telegram(), []);
  const [busy, setBusy] = useState<number | null>(null);

  if (report.error || !report.data) return null;
  const { bots, agent, next } = report.data;
  if (!bots.length) return null;

  async function unpair(accountId: number) {
    setBusy(accountId);
    try {
      await api.telegramUnlock(accountId);
      report.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Separator className="mt-7 mb-5" />
      <div className="text-muted-foreground mb-3 text-[11px] tracking-[0.06em] uppercase">
        Bridge
      </div>

      <div className="flex flex-col gap-3">
        {bots.map((b) => (
          <BotRow
            key={b.accountId}
            bot={b}
            busy={busy === b.accountId}
            onUnpair={() => unpair(b.accountId)}
          />
        ))}
      </div>

      {/* The agent line is the same for every bot, because there is one live
          backend for the whole app — see chat/backend.ts. */}
      <p className="text-muted-foreground mt-4 text-[12px]">
        {agent.connected && agent.label
          ? `Replies come from ${agent.label}.`
          : "No agent is live, so a message gets a sentence saying so rather than silence. Connect Hermes or OpenClaw and make one live."}
      </p>

      {next && (
        <p className="mt-2 text-[12.5px]">
          <span className="font-medium">Next:</span> {next}
        </p>
      )}
    </>
  );
}

const STATE_WORD: Record<TelegramBot["poller"]["state"], string> = {
  starting: "starting",
  polling: "polling",
  conflict: "another poll is open",
  backoff: "backing off",
  stopped: "stopped",
};

function BotRow({
  bot,
  busy,
  onUnpair,
}: {
  bot: TelegramBot;
  busy: boolean;
  onUnpair: () => void;
}) {
  const p = bot.poller;
  // Only a conflict that has outlived a restart's grace is worth amber; the
  // first attempt or two after a restart is the expected shape of a restart.
  const worrying = p.state === "stopped" || (p.state === "conflict" && p.failures >= 3);
  const quiet = p.state === "backoff" || (p.state === "conflict" && !worrying);

  return (
    <div className="bg-card rounded-[10px] border p-3.5">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="font-medium">{bot.label}</span>
        <span
          className={cn(
            "ml-auto flex items-center gap-1.5 text-[11.5px]",
            worrying
              ? "text-destructive"
              : quiet
                ? "text-warn"
                : "text-muted-foreground",
          )}
        >
          <i
            className={cn(
              "size-1.5 rounded-full",
              worrying ? "bg-destructive" : quiet ? "bg-warn" : "bg-ok",
            )}
          />
          {STATE_WORD[p.state]}
          {p.state === "backoff" && p.nextAttemptAt
            ? ` · retry ${ago(p.nextAttemptAt).replace(" ago", "")}`
            : ""}
        </span>
      </div>

      {bot.chat.locked && bot.chat.chatId ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          <span>
            Paired with chat{" "}
            <span className="tabular-nums">{bot.chat.chatId}</span>
          </span>
          <span className="text-muted-foreground">
            {bot.messages.handled} handled
            {bot.messages.ignored
              ? ` · ${bot.messages.ignored} from other chats ignored`
              : ""}
            {bot.messages.lastReplyAt
              ? ` · last reply ${ago(bot.messages.lastReplyAt)}`
              : ""}
          </span>
          <Button
            variant="ghost"
            className="ml-auto h-7 px-2 text-[12px]"
            disabled={busy}
            onClick={onUnpair}
          >
            {busy ? "Unpairing…" : "Unpair"}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground mt-2 text-[12px]">
          Not paired yet. The first message the bot receives — from any chat —
          locks it to that chat; everyone else is ignored and counted.
          {bot.messages.ignored
            ? ` ${bot.messages.ignored} so far.`
            : ""}
        </p>
      )}

      {worrying && p.lastError && (
        <p className="text-destructive mt-2 text-[11.5px] leading-snug">
          {p.lastError}
        </p>
      )}
    </div>
  );
}
