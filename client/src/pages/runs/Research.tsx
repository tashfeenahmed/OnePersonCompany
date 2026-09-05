import { RunApp } from "@/components/runs/RunApp";

/**
 * DEEP RESEARCH ON ONE VENTURE, against the commercial web.
 *
 * The plainest of the six and the one the others are variations of: the agent
 * investigates with the tools it has — web search, this box's own skills — and
 * then writes what it found. Everything specific to it (the brief, the report
 * shape, which of this box's readings get pasted into the system turn) is on
 * the server; this page is the shared run app pointed at a kind string.
 */
export function Research() {
  return <RunApp kind="research" slug="research" name="Research" />;
}
