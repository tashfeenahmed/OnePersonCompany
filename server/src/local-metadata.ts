import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

/** Owner-specific inventory stays beside the database, outside source control.
 * Invalid configuration fails visibly; silently dropping it would hide data. */
export function readLocalList<T>(name: string, valid: (value: unknown) => value is T): T[] | null {
  let raw: string;
  try { raw = readFileSync(join(DATA_DIR, name), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Could not read local configuration ${name}.`);
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`Invalid JSON in local configuration ${name}.`); }
  if (!Array.isArray(value) || !value.every(valid)) throw new Error(`Invalid entries in local configuration ${name}.`);
  return value;
}
