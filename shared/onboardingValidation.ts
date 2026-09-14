export type SetupFieldErrors = Record<string, string>;

/** The same concise field messages are used before submit and by the API. */
export function workspaceFieldErrors(
  raw: unknown,
  password?: string,
): SetupFieldErrors {
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const errors: SetupFieldErrors = {};
  if (typeof value.owner !== "string" || !value.owner.trim())
    errors.owner = "Enter your name.";
  else if (value.owner.trim().length > 80)
    errors.owner = "Use no more than 80 characters.";
  if (typeof value.workspace !== "string" || !value.workspace.trim())
    errors.workspace = "Name your workspace.";
  else if (value.workspace.trim().length > 100)
    errors.workspace = "Use no more than 100 characters.";
  try {
    if (typeof value.timezone !== "string" || !value.timezone.trim())
      throw Error();
    new Intl.DateTimeFormat("en", { timeZone: value.timezone.trim() }).format();
  } catch {
    errors.timezone = "Choose a valid timezone.";
  }
  if (password !== undefined) {
    if (!password) errors.password = "Create an owner password.";
    else if (password.length < 10)
      errors.password = "Use at least 10 characters.";
    else if (password.length > 512)
      errors.password = "Use no more than 512 characters.";
  }
  return errors;
}

export function ventureFieldErrors(venture: {
  name: string;
  website: string;
}): SetupFieldErrors {
  const errors: SetupFieldErrors = {};
  if (!venture.name.trim())
    errors["venture-name"] = "Name your venture, or add it later.";
  if (venture.website.trim()) {
    try {
      const url = new URL(venture.website.trim());
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw Error();
    } catch {
      errors["venture-website"] =
        "Use a website starting with https:// or http://.";
    }
  }
  return errors;
}

export function accountFieldErrors(
  accounts: { key: string; plugin: string; label: string }[],
): SetupFieldErrors {
  const errors: SetupFieldErrors = {};
  const names = new Map<string, string>();
  for (const account of accounts) {
    const field = `account-label:${account.key}`;
    const label = account.label.trim();
    if (!label) errors[field] = "Name this account.";
    else if (label.length > 80)
      errors[field] = "Use no more than 80 characters.";
    else {
      const name = `${account.plugin}:${label}`;
      const previous = names.get(name);
      if (previous) {
        errors[previous] = "Use a different account name.";
        errors[field] = "Use a different account name.";
      }
      names.set(name, field);
    }
  }
  return errors;
}

export class SetupValidationError extends Error {
  fieldErrors: SetupFieldErrors;
  constructor(fieldErrors: SetupFieldErrors) {
    super("Check the highlighted fields.");
    this.name = "SetupValidationError";
    this.fieldErrors = fieldErrors;
  }
}

export function requireValidFields(errors: SetupFieldErrors): void {
  if (Object.keys(errors).length) throw new SetupValidationError(errors);
}
