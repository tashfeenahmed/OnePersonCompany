/** User-facing pages do not always share the engine's kind name. */
import { appPage } from "./navigation.ts";

export function runPage(kind: string, id: string): string {
  const app = kind === "geo" ? "visibility" : kind === "shotsqa" ? "ops" : kind;
  return appPage(app, id);
}
