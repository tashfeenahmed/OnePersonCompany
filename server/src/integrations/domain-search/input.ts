import { domainToASCII } from "node:url";
import { DOMAIN_BULK_LIMIT } from "../../../../shared/domainSearch.ts";

/** Accept names, not URLs. Outbound requests always target the registrar. */
export function normalizeName(input: string): string {
  const text = input.trim().toLowerCase().replace(/[。．｡]/g, ".").replace(/\.$/, "");
  if (!text || /[\s/:@?#\\%]/u.test(text)) throw new Error("Enter a domain name without a URL, path or spaces.");
  const ascii = domainToASCII(text);
  if (!ascii || ascii.length > 253 || !ascii.split(".").every(label =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))
    throw new Error("Use valid domain labels of up to 63 characters, with letters, numbers or hyphens.");
  return ascii;
}

export function bulkNames(text: string, limit = DOMAIN_BULK_LIMIT): string[] {
  const inputs = text.split(/[\s,;]+/u).filter(Boolean);
  if (!inputs.length) throw new Error("Enter at least one full domain name.");
  if (inputs.length > limit) throw new Error(`Check up to ${limit} domains at a time.`);
  return [...new Set(inputs.map(input => {
    const name = normalizeName(input);
    if (!name.includes(".") || /^\d+(?:\.\d+)+$/.test(name)) throw new Error(`Include the extension for “${input}”, such as .com.`);
    return name;
  }))];
}

export function searchLabel(text: string): string {
  const name = normalizeName(text);
  if (name.includes(".")) throw new Error("Enter just the name to search across TLDs. Use Bulk for full domains.");
  return name;
}

// Only presentation order is curated. Coverage comes from IANA, not this list.
const FIRST = ["com", "net", "org", "io", "ai", "app", "dev", "co", "me", "xyz"];
export function parseTlds(text: string): string[] {
  const tlds = [...new Set(text.split(/\r?\n/).map(x => x.trim().toLowerCase())
    .filter(x => /^[a-z][a-z0-9-]{1,62}$/.test(x)))];
  if (tlds.length < 100) throw new Error("The TLD directory could not be read. Try again shortly.");
  return tlds.sort((a, b) => {
    const ai = FIRST.indexOf(a), bi = FIRST.indexOf(b);
    return (ai < 0 ? FIRST.length : ai) - (bi < 0 ? FIRST.length : bi) || a.localeCompare(b);
  });
}
