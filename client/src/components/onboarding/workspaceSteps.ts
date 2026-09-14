import { workspaceFieldErrors } from "../../../../shared/onboardingValidation.ts";

export const WORKSPACE_FIELDS = ["owner", "workspace", "password"] as const;
export function workspaceStepErrors(
  step: number,
  draft: unknown,
  password: string,
) {
  const errors = workspaceFieldErrors(draft, password);
  const field = WORKSPACE_FIELDS[step];
  return field && errors[field] ? { [field]: errors[field] } : {};
}

export function detectTimezone(
  read = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  try {
    const zone = read();
    if (!zone) return "UTC";
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}
