// Keep backup creation and offline restoration in agreement.
export const BACKUP_MEMBERS = ["vault.key", "service-key", "keys", "shots", "studio", "video", "papers",
  "hermes/home/.hermes/config.yaml", "hermes/home/.hermes/skills"];
export const RESTORE_MEMBERS = ["opc.db", ...BACKUP_MEMBERS];
