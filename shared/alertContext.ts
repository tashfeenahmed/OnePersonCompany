/** App identities and report availability captured with an alert, not inferred
 * from whichever app happens to lead today's ranking. */
export type AlertContext = {
  title: string;
  summary: string | null;
  apps: { app: string; store: string; name: string; reason: string | null }[];
};
