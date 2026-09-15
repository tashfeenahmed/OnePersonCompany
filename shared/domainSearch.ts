export type DomainAvailability = "available" | "unavailable" | "unsupported" | "unknown";
export type DomainSearchResult = {
  domain: string;
  status: DomainAvailability;
  premium: boolean | null;
  checkedAt: string;
  note?: string;
};
export type DomainSearchAccount = {
  id: number;
  label: string;
  provider: "spaceship" | "dynadot";
  name: string;
  batchSize: number;
};
export type DomainSearchPlan = {
  domains: string[];
  catalogUpdatedAt?: string;
  catalogStale?: boolean;
};
export const DOMAIN_BULK_LIMIT = 200;
