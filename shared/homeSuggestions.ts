export type HomeSuggestionKind = "alert" | "board" | "report" | "activity" | "venture" | "journal" | "workspace";

export type HomeSuggestion = {
  id: string;
  kind: HomeSuggestionKind;
  title: string;
  reason: string;
  prompt: string;
  ventureId: string | null;
  ventureName: string | null;
  source: { label: string; href: string };
};

export type HomeSuggestions = {
  day: string;
  timezone: string;
  generatedAt: string;
  suggestions: HomeSuggestion[];
};
