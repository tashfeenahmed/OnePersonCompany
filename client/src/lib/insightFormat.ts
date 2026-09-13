export const insightNumber = (n: number, unit: string) => /^[A-Z]{3}$/.test(unit)
  ? new Intl.NumberFormat(undefined, { style: "currency", currency: unit, maximumFractionDigits: 0 }).format(n)
  : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n)} ${unit}`;
