import { useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  calendarEvents,
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarReport,
} from "@/lib/api/reports";
import { addDays, eventEnd, eventStart, isoDay, parseISODay } from "./dates";

/**
 * Create or edit one event — the page's half of the calendar write routes.
 *
 * Times are typed in the browser's clock and sent with its offset, so
 * "15:00" means 15:00 where the owner is sitting. An all-day event is typed
 * with an INCLUSIVE last day, the way people say it, and sent with Google's
 * exclusive end. Notes go to Google only; this box never reads them back, so
 * editing an event leaves its notes alone unless new ones are typed.
 */
export type FormTarget =
  | { mode: "create"; at: Date; allDay?: boolean }
  | { mode: "edit"; event: CalendarEvent };

type Calendar = CalendarReport["calendars"][number];

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 'YYYY-MM-DD' + 'HH:MM' in this browser's clock, as RFC3339 with its offset. */
function rfc3339(day: string, time: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const at = new Date(y, m - 1, d, h, mi);
  const off = -at.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${day}T${pad(h)}:${pad(mi)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function initial(target: FormTarget) {
  if (target.mode === "create") {
    const start = new Date(target.at);
    const end = new Date(start.getTime() + 60 * 60_000);
    return {
      summary: "",
      allDay: !!target.allDay,
      startDay: isoDay(start),
      startTime: hhmm(start),
      endDay: isoDay(end),
      endTime: hhmm(end),
      location: "",
    };
  }
  const e = target.event;
  const s = eventStart(e) ?? new Date();
  const en = eventEnd(e) ?? new Date(s.getTime() + 60 * 60_000);
  /* An all-day end is exclusive on the wire and inclusive in the form. */
  const lastDay = e.allDay && e.end ? addDays(parseISODay(e.end.slice(0, 10)) ?? s, -1) : en;
  return {
    summary: e.summary ?? "",
    allDay: e.allDay,
    startDay: e.allDay && e.start ? e.start.slice(0, 10) : isoDay(s),
    startTime: e.allDay ? "09:00" : hhmm(s),
    endDay: isoDay(lastDay),
    endTime: e.allDay ? "10:00" : hhmm(en),
    location: e.location ?? "",
  };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function EventForm({
  target,
  calendars,
  onClose,
  onSaved,
}: {
  target: FormTarget;
  /** The calendars that can be written to, primary first. */
  calendars: Calendar[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = target.mode === "edit" ? target.event : null;
  const [form, setForm] = useState(() => initial(target));
  const [notes, setNotes] = useState("");
  const [calendarId, setCalendarId] = useState(
    () => editing?.calendarId ?? calendars.find((k) => k.primary)?.calendarId ?? calendars[0]?.calendarId ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /* Moving the start keeps the length, as Google's own form does. */
  const moveStart = (day: string, time: string) => {
    setForm((f) => {
      if (f.allDay) {
        const len = Math.max(0, Math.round(((parseISODay(f.endDay)?.getTime() ?? 0) - (parseISODay(f.startDay)?.getTime() ?? 0)) / 86_400_000));
        return { ...f, startDay: day, endDay: isoDay(addDays(parseISODay(day) ?? new Date(), len)) };
      }
      const before = Date.parse(rfc3339(f.startDay, f.startTime));
      const after = Date.parse(rfc3339(day, time));
      const end = new Date(Date.parse(rfc3339(f.endDay, f.endTime)) + (after - before));
      return { ...f, startDay: day, startTime: time, endDay: isoDay(end), endTime: hhmm(end) };
    });
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!form.summary.trim()) return setError("Give it a title.");
    const start = form.allDay ? form.startDay : rfc3339(form.startDay, form.startTime);
    const end = form.allDay
      ? isoDay(addDays(parseISODay(form.endDay) ?? new Date(), 1))
      : rfc3339(form.endDay, form.endTime);
    const body: CalendarEventInput = { summary: form.summary.trim(), start, end };
    if (editing) {
      if ((editing.location ?? "") !== form.location) body.location = form.location || null;
      if (notes.trim()) body.description = notes;
      body.calendarId = editing.calendarId;
      body.account = editing.accountId;
    } else {
      const cal = calendars.find((k) => k.calendarId === calendarId);
      if (form.location.trim()) body.location = form.location.trim();
      if (notes.trim()) body.description = notes;
      body.calendarId = calendarId;
      if (cal) body.account = cal.accountId;
    }
    setBusy(true);
    setError(null);
    try {
      if (editing) await calendarEvents.update(editing.eventId, body);
      else await calendarEvents.create(body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit event" : "New event"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes go straight to Google Calendar. Guests are not emailed."
              : "Added straight to Google Calendar. No guests are invited."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3.5">
          {error && (
            <p role="alert" className="text-destructive text-[13px]">
              {error}
            </p>
          )}
          <Field label="Title">
            <Input
              autoFocus
              value={form.summary}
              maxLength={500}
              onChange={(e) => set("summary", e.target.value)}
              placeholder="Call with accountant"
            />
          </Field>

          <label className="flex items-center gap-2.5 text-[13px]">
            <Switch checked={form.allDay} onCheckedChange={(v) => set("allDay", v)} />
            All day
          </label>

          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <Field label={form.allDay ? "From" : "Starts"}>
              <Input
                type="date"
                required
                value={form.startDay}
                onChange={(e) => e.target.value && moveStart(e.target.value, form.startTime)}
              />
            </Field>
            {!form.allDay && (
              <Field label="&nbsp;">
                <Input
                  type="time"
                  required
                  value={form.startTime}
                  onChange={(e) => e.target.value && moveStart(form.startDay, e.target.value)}
                />
              </Field>
            )}
            <Field label={form.allDay ? "To (last day)" : "Ends"}>
              <Input
                type="date"
                required
                min={form.startDay}
                value={form.endDay}
                onChange={(e) => set("endDay", e.target.value)}
              />
            </Field>
            {!form.allDay && (
              <Field label="&nbsp;">
                <Input
                  type="time"
                  required
                  value={form.endTime}
                  onChange={(e) => set("endTime", e.target.value)}
                />
              </Field>
            )}
          </div>

          {!editing && calendars.length > 1 && (
            <Field label="Calendar">
              <SelectField aria-label="Calendar" value={calendarId} onValueChange={setCalendarId}>
                {calendars.map((k) => (
                  <SelectOption key={`${k.accountId}:${k.calendarId}`} value={k.calendarId}>
                    {k.summary ?? k.calendarId}
                  </SelectOption>
                ))}
              </SelectField>
            </Field>
          )}

          <Field label="Location">
            <Input
              value={form.location}
              maxLength={500}
              onChange={(e) => set("location", e.target.value)}
              placeholder="A place or a link"
            />
          </Field>

          <Field label={editing ? "Notes (replaces any existing notes)" : "Notes"}>
            <Textarea
              rows={3}
              value={notes}
              maxLength={8000}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={editing ? "Leave empty to keep the notes in Google as they are" : "Optional"}
            />
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : editing ? "Save" : "Add event"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
