import { Hono } from "hono";
import { boardAutomationStatus, configureBoardAutomation, syncBoardCards } from "./automation.ts";
import { registerBuiltinBoardSources } from "./sources.ts";

registerBuiltinBoardSources();
export const boardAutomationRoutes = new Hono();
boardAutomationRoutes.get("/", c => c.json(boardAutomationStatus()));
boardAutomationRoutes.patch("/", async c => {
  try { return c.json(configureBoardAutomation(await c.req.json())); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid settings." }, 400); }
});
boardAutomationRoutes.post("/sync", async c => {
  const result = await syncBoardCards();
  return c.json({ ...boardAutomationStatus(), ...result });
});
