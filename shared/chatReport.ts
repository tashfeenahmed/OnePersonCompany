import type { RunStatus } from "./runStatus.ts";

/** A report attached by the run engine, with its current author and destination. */
export type ChatReport = {
  runId: string;
  title: string;
  agentName: string;
  role: string;
  status: RunStatus;
  to: string;
  error: string | null;
};
