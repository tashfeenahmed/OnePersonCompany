export type GameplayBackground = { id: string; label: string; thumbnailUrl: string | null };

export function isGameplayName(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,119}$/.test(value);
}

export function gameplayLabel(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}
