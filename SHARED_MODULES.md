# The shared modules Wave 1 built

Wave 2 rewires callers onto these and DELETES the copies they replace. Every
module below exists and is tested; `npm run check` is green with them in place.

Import paths: server files use the `.ts` extension (`../../shared/host.ts`);
client files omit it. Repo-root `shared/` is reachable from both.

---

## server/src/shared/host.ts — pure
```ts
type HostRelation = "same" | "sub";
type HostBearing = { host?: string | null; website?: string | null };
hostOf(raw): string | null            // bare hosts, URLs, sc-domain: properties; strips www., port, trailing dot
registrable(raw): string              // "" when nothing host-shaped
hostMatch(ventureHost, entityHost): HostRelation | null
sameSite(ventureHost, entityHost): boolean
ventureForHost<V extends HostBearing>(host, ventures): V | null
```
**`registrable` is NOT a matcher.** It folds bidirectionally by construction, so
using it to decide venture ownership reintroduces the seoops bug this replaces.
Ownership questions go through `hostMatch` / `ventureForHost`, always.
`activity/link.ts` currently keys its venture lookup by `registrable` — that is a
latent instance of the bug. Port it to `ventureForHost`, not to `registrable`.

## server/src/shared/time.ts — imports configValue from ../db.ts
```ts
type Wall = { day; hour; minute; minutes; weekday };
type DailySchedule = { enabled; hour; timezone; zoneWasSet };
type ScheduleKeys = { enabledKey?; hourKey?; zoneKey?; defaultHour?; defaultEnabled? };
systemZone(); validZone(zone); resolveZone(zone);
wall(zone, at?): Wall;  zoned(zone, at?): { day; hour };
readHour(raw, fallback);
dailySchedule(pluginId, keys?): DailySchedule;
nextRunAt({ enabled?, hour, timezone }, at?): string | null;
dueDay(day, currentHour, scheduledHour, lastDueDay): string | null;
```
Defaults: enabledKey `"enabled"`, hourKey `"hour"`, zoneKey `"timezone"`, hour 9, enabled false.
- An unset OR invalid zone resolves to `systemZone()` eagerly; `zoneWasSet`
  carries "the owner never typed one" separately, so no page loses information.
  `PipelineSettings.timezone: string | null` + `resolvedTimezone` collapse into
  one always-real `timezone`.
- An out-of-range hour REJECTS to the default; pipeline and chief used to clamp
  (25 -> 23:00), which presents an hour the owner never chose as one they did.
  Behaviour change on invalid input only.
- `dueDay` already lived alone at `server/src/runtime/schedule.ts`. Deleting that
  file must also delete or repoint `server/src/regression/schedule.test.ts`; its
  three cases are reproduced in `shared/time.test.ts`.

## server/src/shared/money.ts — pure
```ts
MONEY_DP = 4;  MODEL_SPEND_DP = 6;
money(n, dp = MONEY_DP): number;   fromMinorUnits(minor, dp?): number;
currencyCode(raw): string;         // trimmed, UPPER
isMonth(s); isCompactMonth(s); daysInMonth(month);
compactMonth(m): string;  // YYYY-MM -> YYYYMM
isoMonth(c): string;      // YYYYMM -> YYYY-MM
monthOf(iso): string;     // ISO day/instant -> YYYY-MM
```
**Wire-visible:** routes that used `toFixed(2)` move to 4dp. That is the intended
fix — it is why the reports did not tie out — but call it out in your diff rather
than treating it as a no-op. 2dp is now a *rendering* concern and lives client-side.

## server/src/shared/textkey.ts — pure
```ts
textKey(text): string;  FINGERPRINT_MAX = 200;  fingerprint(text, max?): string;
```

## shared/runStatus.ts — pure, client imports it too
```ts
RUN_STATUSES = ["queued","running","done","failed","cancelled"] as const;
type RunStatus; CANCELLING = "cancelling"; type RunStatusOrCancelling;
isRunStatus(v); isLive(s); isFinal(s);
```
**Wire-visible:** the cancel reply becomes `"cancelling"` everywhere.
`chat/runs.ts:620,656` and `client/src/lib/api.ts:2751` (`ChatCancelled`) both
need the string swapped, and any client branching on `"stopping"` moves with them.

---

## server/src/tools/find-binary.ts
```ts
KNOWN_PREFIXES; type ConfigKey = { plugin; key; label };
type BinarySpec = { name; aliases?; candidates?; configKeys?; install? };
type Binary = { found: true; name; path; source: "configured"|"known"|"path"; via; error: null }
            | { found: false; name; path: null; source: "none"; via: null; error: string };
onPath(name): string | null;  findBinary(spec): Binary;
```
`configKeys` is a LIST because typst is discovered under two plugin settings keys
today; one binary must resolve from either.

## server/src/tools/chrome.ts
```ts
SHOT_VIEWPORT { width: 1280; height: 800 };  SHOT_FLOOR (derived = viewport/2);
CAPTURE_PLUGIN; VIRTUAL_TIME_MS; RUN_MS;  type Browser = Binary;
findBrowser(): Browser;
withProfile<T>(fn: (dir) => Promise<T>, prefix?): Promise<T>;   // mkdtemp + guaranteed cleanup
baseArgs({ profile, width?, height?, virtualTimeMs?, timeoutMs?, scale?, printing? }): string[];
shoot(opts & { out }): Promise<ShotResult>;   dump(opts): Promise<DumpResult>;
reason(stderr): string | null;
imageDimensions(bytes): { width; height } | null;   // PNG + JPEG
```
- `Browser` is now `Binary`, so `source` is `"known"` where capture.ts said
  `"application"`. Adjust any UI copy printing that word.
- `SHOT_FLOOR` replaces `security/shotsqa.ts`'s hardcoded MIN_WIDTH/MIN_HEIGHT.
- `seoops/brand.ts` drives Chrome over CDP, not the command line. Only its
  `baseArgs`, profile dir and the 1280x800 constants are replaceable; the
  DevTools client is genuinely its own thing. Leave it.

## server/src/tools/replicate-run.ts
```ts
predict({ token, model, input, poll?, waitMs?, signal? }): Promise<PredictResult>;
firstUrl(output): string | null;
download({ url, cap, what, timeoutMs?, signal? }): Promise<DownloadResult>;
```
The token is a PARAMETER: the two callers write legitimately different
"Replicate is not connected" sentences and those stay theirs. `predict` returns
raw `output`; `download` is the other duplicated half.

## server/src/shared/settle.ts
```ts
NOW (symbol); INTERRUPTED;
settleOpenRows({ table, openWhen, set, note? }): number;
settleAll(specs): { table; closed }[];
```
`note` COALESCEs — it must not overwrite the note a dying process wrote about the
actual failure with "something restarted".
**`chief/manifest.ts:onStart` has no settle call at all** — the forgotten fourth
table. It needs one for `chief_rounds` with `openWhen: "finished_at IS NULL"`.

## server/src/shared/retention.ts
```ts
registerRetention({ table, column, days, source, setting?, grain?, where?, note? }): void;
retentions(): RetentionEntry[];  retentionFor(table);  pruneAll();  pruneOne(entry);
```
`days` accepts a thunk so `/api/health` cannot report a number the prune stopped
using. `grain: "day"` for day-keyed columns; `where` for `job_leases` (released
rows only). **Nothing registers yet** — each area calls this beside its existing
`RETAIN_DAYS`. `security_snapshots`, `security_shotsqa` and `backup_runs` have no
prune at all today and need windows chosen.

## server/src/shared/metrics-address.ts
```ts
parsePath(raw); checkPath(raw); resolvePath(doc, raw): Resolved;
paramsOf(raw); apiBase(); urlFor(addr, base?);
takeReading(addr, opts?): Promise<Reading>;  fromDoc(addr, doc, url?): Reading;
```
Supports the superset, including `@count(...)` which only proactive had.
`urlFor` OMITS `view` when it is `"default"` — a literal `?view=default` 404s on
any skill whose first view is keyed something else. That was a live bug.

---

## client/src/lib/format.ts — leaf, zero imports
```ts
DASH = "—";  type Absent = { nullText?: string };
pct(fraction, { digits?, nullText? })      // 0-1 FRACTION always; a server percent divides at the call site
duration(ms, …)      durationS(seconds, …) // distinct names; they differed by 1000x
ago(isoOrEpochMsOrDate, …)                 // 24h day cut-off; null -> "never"; unparseable -> dash
when(isoOrEpochMsOrDate, { year?, nullText? })
money(n, currency, { digits?, locale?, nullText? })   // always 2dp, en-GB, try/catch fallback kept
bytes(n, { base? })  // 1024 default, KB; { base: 1000 } renders kB — casing is the tell
count(n)  compact(n) // k / M / B, nothing shortened below 10,000
inDays(days)         // "in 41d", with month/year tail
```
**Trap:** `when(null)` is the em dash, reversing five copies that said "never".
The five surfaces where absence genuinely means never-happened —
`SecuritySettings`, `DeploymentSettings`, `MigrationSettings`, `BackupsSettings`,
`CaptureSettings` — must migrate as `when(x, { nullText: "never" })` or their
meaning silently changes.
`nullText` is a WORD a caller chooses, never a zero.

## client/src/lib/qs.ts
```ts
qs(params: Record<string, QueryValue>): string   // "" or "?a=1&b=2"
```
URLSearchParams, so a space is `+`. Filters `null`, `undefined` and `""`; KEEPS
`false` and `0`, which are real answers.

## client/src/components/ui/state.tsx
```tsx
<Loading what /> <Failed error /> <Num value suffix? digits? />
<SectionCard title meta? >…</SectionCard>
```
`Num` keeps `tabular-nums` and treats NaN as absent. `SectionCard` closes the
titled-section-card duplication between WebAnalytics and MobileHealth.

## client/src/components/WindowPicker.tsx
```tsx
<WindowPicker value onChange options?={[7,30,90]} label? right? />
```

## client/src/components/RankedBars.tsx
```tsx
<RankedBars rows total? remainder? showChange? format? footnote? />
```
`remainder` draws the muted leftover row (needs `total`); `footnote` carries the
"N more not drawn" prose. The share column is dropped entirely when neither a
per-row share nor a total is available, rather than showing a share-of-the-top-ten
dressed as a share of everything.

## Already shared — do not build a second one
`Tiles` in `client/src/components/integrations/Panel.tsx` is the KPI stat-tile
row; its eight copies migrate there. `PanelEmpty` in the same file is the empty
state. `TabStrip` in `client/src/components/TabStrip.tsx` is the sub-tab strip.
