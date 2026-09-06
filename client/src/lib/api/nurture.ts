/**
 * NURTURE — sequences, enrolments, sending identities and the voice.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND, and the nulls are the
 * interesting half. `verified: null` on an identity means Resend has NOT BEEN
 * ASKED — it is not "unverified", and the page draws it as its own state.
 * `blocked` on an enrolment is not `stopped`: it means a stop condition could
 * not be checked today, so nothing was written for that person, and they
 * resume on their own. `validation.by: "template"` means the model's wording
 * was refused by the fact check and `validation.why` names the token it
 * invented.
 *
 * THERE IS NO approve AND NO send HELPER HERE, and not by omission. This area's
 * whole point is that a schedule may WRITE. Approving and sending live in
 * `api/mailflow.ts`, behind two presses by the owner, and the server refuses
 * both for anything arriving through the skills proxy.
 */
import { call } from "@/lib/api";

/* ------------------------------------------------------------------- facts */

/** One fact a draft's wording was allowed to use. `source` is where it was
 *  read; `observed_at` is when the SOURCE observed it, which is not when the
 *  draft was written. */
export type Fact = {
  key: string;
  value: string | number;
  unit?: string | null;
  source: string;
  observed_at: string | null;
};

export type DraftPlan = {
  address: string;
  name: string | null;
  venture: string | null;
  ventureName: string | null;
  identityId: number;
  from: string;
  via: "gmail" | "resend";
  purpose: string;
  whyNow: string;
  origin: { kind: string; detail: string };
  sequenceId: number | null;
  step: number | null;
  steps: number | null;
  threadId: string | null;
};

export type Validation = {
  /** `model` when the model's wording passed the fact check; `template` when it
   *  was refused twice and the deterministic wording was used instead. */
  by: "model" | "template";
  why: string | null;
  /** Every refusal, with the token each one named. */
  refusals: string[];
  model: string | null;
  styleRules: number;
  cannotSay: string[];
  at: string;
};

export type DraftReasons = {
  id: number;
  plan: DraftPlan | null;
  facts: Fact[] | null;
  validation: Validation | null;
  identity: NurtureIdentityRaw | null;
  sequenceId: number | null;
  sequenceStep: number | null;
  sentVia: string | null;
  /** Resend's own last event for a sent copy. NULL means NOT READ — never
   *  "not delivered". */
  deliveryEvent: string | null;
  deliveryReadAt: string | null;
  note: string;
};

type NurtureIdentityRaw = { id: number; from_address: string; from_name: string; kind: string };

/* -------------------------------------------------------------- the document */

export type SequenceStep = { dayOffset: number; purpose: string; hint?: string | null };

export type Sequence = {
  id: number;
  name: string;
  venture: string | null;
  ventureName: string | null;
  enabled: boolean;
  steps: SequenceStep[];
  enrolKind: string;
  enrolFilter: Record<string, unknown>;
  stopOn: string[];
  dailyCap: number;
  identityId: number | null;
  counts: { active: number; stopped: number; done: number; held: number };
  /** Why this sequence cannot draft, in words. Empty means it can. */
  problems: string[];
  createdAt: string;
  updatedAt: string;
};

export type Identity = {
  id: number;
  venture: string | null;
  ventureName: string | null;
  kind: "gmail" | "resend" | string;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  accountId: number;
  isDefault: boolean;
  /** Resend's own word — "verified", "pending", "failed" — or "mailbox" for a
   *  Gmail identity. NULL means nobody has asked, NOT "unverified". */
  verified: string | null;
  verifiedAt: string | null;
  verifyNote: string | null;
};

export type Pass = {
  day: string;
  ranAt: string;
  ok: boolean;
  enrolled: number;
  drafted: number;
  stopped: number;
  skipped: { address: string; why: string }[];
  trigger: string;
  error: string | null;
  alreadyRan?: boolean;
};

export type NurtureDoc = {
  settings: {
    hour: number;
    maxActive: number;
    draftsPerPass: number;
    styleLearning: boolean;
    outboxDailyCap: number;
    outboxGapDays: number;
    requireApproval: boolean;
  };
  sequences: Sequence[];
  identities: Identity[];
  passes: Pass[];
  enrolKinds: string[];
  stopConditions: string[];
  optouts: { address: string; reason: string | null; at: string }[];
  note: string;
};

export type Enrollment = {
  id: number;
  sequenceId: number;
  sequenceName: string | null;
  address: string;
  name: string | null;
  venture: string | null;
  step: number;
  nextDue: string | null;
  status: "active" | "stopped" | "done" | string;
  stopReason: string | null;
  /** A held enrolment DRAFTS NOTHING and is not stopped. */
  blocked: string | null;
  enrolledAt: string;
  stoppedAt: string | null;
  lastDraftAt: string | null;
  history: { at: string; what: string; outboxId: number | null }[];
};

export type StyleDoc = {
  on: boolean;
  rules: {
    id: number;
    rule: string;
    byOwner: boolean;
    evidence: number[];
    model: string | null;
    derivedAt: string;
    version: number;
  }[];
  /** How many before/after pairs are on file, and when. NEVER the pairs
   *  themselves: they quote whole email bodies and no route publishes one. */
  edits: { count: number; newest: string | null; oldest: string | null };
  refusals: { id: number; rule: string; why: string; at: string }[];
  note: string;
};

export const nurtureApi = {
  doc: () => call<NurtureDoc>("/nurture"),
  enrollments: (opts: { sequence?: number; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.sequence) q.set("sequence", String(opts.sequence));
    if (opts.status) q.set("status", opts.status);
    return call<{ items: Enrollment[]; note: string }>(`/nurture/enrollments${q.toString() ? `?${q}` : ""}`);
  },
  candidates: (id: number) =>
    call<{ items: { address: string; name: string; why: string }[]; problems: string[]; note: string }>(
      `/nurture/sequences/${id}/candidates`,
    ),

  createSequence: (body: unknown) =>
    call<{ item: Sequence; note: string }>("/nurture/sequences", { method: "POST", body: JSON.stringify(body) }),
  patchSequence: (id: number, body: unknown) =>
    call<{ item: Sequence; note: string }>(`/nurture/sequences/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteSequence: (id: number) => call<{ deleted: number }>(`/nurture/sequences/${id}`, { method: "DELETE" }),

  enrol: (id: number, address: string, why?: string) =>
    call<{ item: Enrollment; note: string }>(`/nurture/sequences/${id}/enrol`, {
      method: "POST",
      body: JSON.stringify({ address, why }),
    }),
  stop: (id: number, reason: string) =>
    call<{ item: Enrollment; note: string }>(`/nurture/enrollments/${id}/stop`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  optOut: (address: string, reason?: string) =>
    call<{ address: string; at: string; note: string }>("/nurture/optout", {
      method: "POST",
      body: JSON.stringify({ address, reason }),
    }),
  run: (force = false) => call<Pass & { note: string }>("/nurture/run", { method: "POST", body: JSON.stringify({ force }) }),

  identityOptions: () =>
    call<{
      gmail: { id: number; label: string; address: string | null }[];
      resend: { id: number; label: string; domain: string }[];
      note: string;
    }>("/nurture/identities/options"),
  createIdentity: (body: unknown) =>
    call<{ item: Identity; note: string }>("/nurture/identities", { method: "POST", body: JSON.stringify(body) }),
  verifyIdentity: (id: number) =>
    call<{ item: Identity; note: string }>(`/nurture/identities/${id}/verify`, { method: "POST", body: "{}" }),
  makeDefault: (id: number) =>
    call<{ item: Identity }>(`/nurture/identities/${id}/default`, { method: "POST", body: "{}" }),
  deleteIdentity: (id: number) => call<{ deleted: number }>(`/nurture/identities/${id}`, { method: "DELETE" }),

  /** Plan, gather facts, word and validate ONE message. It files a DRAFT in the
   *  outbox; it cannot send. */
  prepare: (body: {
    address: string;
    purpose: string;
    venture?: string | null;
    identityId?: number | null;
    whyNow?: string;
    dryRun?: boolean;
  }) =>
    call<{
      outboxId?: number;
      dryRun?: boolean;
      plan: DraftPlan;
      facts: Fact[];
      validation: Validation;
      subject: string;
      body: string;
      note: string;
    }>("/nurture/prepare", { method: "POST", body: JSON.stringify(body) }),

  /** One outbox draft's own reasons — the plan, the facts and the validation. */
  reasons: (outboxId: number) => call<DraftReasons>(`/nurture/drafts/${outboxId}`),

  style: () => call<StyleDoc>("/nurture/style"),
  derive: () => call<{ derived: boolean; error: string | null; model: string | null; refused: { rule: string; why: string }[] }>(
    "/nurture/style/derive",
    { method: "POST", body: "{}" },
  ),
  addRule: (rule: string) => call<{ item: unknown }>("/nurture/style/rules", { method: "POST", body: JSON.stringify({ rule }) }),
  removeRule: (id: number) => call<{ deleted: number }>(`/nurture/style/rules/${id}`, { method: "DELETE" }),
  forget: () => call<{ rules: number; pairs: number; refusals: number; note: string }>("/nurture/style/forget", {
    method: "POST",
    body: "{}",
  }),
};
