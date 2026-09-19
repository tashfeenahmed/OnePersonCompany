import type { ChatTurn } from "../../chat/backend.ts";
import type { Block } from "./context.ts";
import { renderBlocks } from "./context.ts";
import { kindDef, systemBrief } from "./kinds.ts";

/**
 * THE DEMAND RUN. Split out of the executor's generic one-turn `reportRun`
 * so it can grow the same two-turn shape the research run has — an
 * investigation, then a tools-off writer producing a designed HTML document.
 * This baseline reproduces the one-turn markdown behaviour exactly.
 */
export async function demandRun(opts: {
  runId: string;
  ventureName: string;
  focus: string;
  blocks: Block[];
  hasTools: boolean;
  writerUsesProvider: boolean;
  runSeconds: number;
  cli?: string | null;
  turn(turns: ChatTurn[], opts: { toOutput: boolean; forceProvider?: boolean; document?: boolean }): Promise<{ text: string }>;
  say(text: string): void;
  step<T>(label: string, work: () => Promise<T>): Promise<T>;
}) {
  const { ventureName, blocks, focus, hasTools } = opts;
  const def = kindDef("demand")!;
  const system = systemBrief({ def, ventureName, hasTools, cli: opts.cli, data: renderBlocks(blocks) });
  const user =
    focus || `Do the ${def.name.toLowerCase()} for ${ventureName}. Nothing in particular has been singled out, so cover what matters most.`;
  await opts.step(`${def.name} — ${ventureName}`, async () => {
    await opts.turn([{ role: "system", content: system }, { role: "user", content: user }], { toOutput: true });
  });
}
