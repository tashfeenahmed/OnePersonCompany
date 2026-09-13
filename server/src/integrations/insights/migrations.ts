export const MIGRATIONS = [
  { name: "470_insight_sources", sql: `
    CREATE TABLE insight_sources (id TEXT PRIMARY KEY, label TEXT NOT NULL, source TEXT NOT NULL, venture_id TEXT, metric TEXT NOT NULL, unit TEXT NOT NULL, observed_at TEXT, complete_through TEXT NOT NULL);
    CREATE TABLE insight_points (source_id TEXT NOT NULL REFERENCES insight_sources(id) ON DELETE CASCADE, day TEXT NOT NULL, value REAL, PRIMARY KEY(source_id, day)) WITHOUT ROWID;
    ALTER TABLE alert_rules ADD COLUMN managed_source TEXT;
    CREATE UNIQUE INDEX alert_rules_managed ON alert_rules(managed_source) WHERE managed_source IS NOT NULL;
    CREATE TABLE insight_anomalies (source_id TEXT PRIMARY KEY, checked_day TEXT, baseline TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE insight_preferences (id INTEGER PRIMARY KEY CHECK(id = 1), settings TEXT NOT NULL);
  ` },
];
