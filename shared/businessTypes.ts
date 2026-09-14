import { isBusinessType, type BusinessType } from "./ventureJourney.ts";

/** Older clients may still supply one type; plural selections are canonical. */
export function parseBusinessTypes(
  value: unknown,
  legacy?: unknown,
): BusinessType[] {
  if (value === undefined) {
    if (legacy == null) return [];
    if (isBusinessType(legacy)) return [legacy];
    throw new Error("Choose supported business types.");
  }
  if (!Array.isArray(value) || value.length > 7 || !value.every(isBusinessType))
    throw new Error("Choose supported business types.");
  return [...new Set(value)] as BusinessType[];
}

export function businessTypesOf(value: {
  businessTypes?: BusinessType[];
  businessType?: BusinessType | null;
}): BusinessType[] {
  return (
    value.businessTypes ?? (value.businessType ? [value.businessType] : [])
  );
}

export function storedBusinessTypes(row: {
  business_types?: string;
  business_type?: BusinessType | null;
}): BusinessType[] {
  try {
    const types = parseBusinessTypes(
      row.business_types ? JSON.parse(row.business_types) : undefined,
      row.business_type,
    );
    return types.length || !row.business_type ? types : [row.business_type];
  } catch {
    return row.business_type ? [row.business_type] : [];
  }
}

export function toggleBusinessType(
  types: BusinessType[],
  type: BusinessType,
): BusinessType[] {
  return types.includes(type)
    ? types.filter((t) => t !== type)
    : [...types, type];
}
