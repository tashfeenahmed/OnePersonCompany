import { FALLBACK_ROLE_ICON, ROLE_ICONS } from "@/components/org/roleLook";

/**
 * A ROLE'S MARK, in the one place that draws one.
 *
 * It is a component rather than three lookups because three files want it and
 * two of them want it at the top of a render — where a component pulled out of
 * a map by hand is a component the linter has to take on trust. Here the
 * lookup happens once, inside a component that is declared at module scope,
 * and every caller writes `<RoleIcon role={…} />`.
 *
 * THE ICONS ARE THE APPS' ICONS. A sub-agent is the app with a name on it, so
 * a second visual language for the same six things would be six more symbols
 * to learn for no new fact.
 */
export function RoleIcon({
  role,
  className,
}: {
  role: string;
  className?: string;
}) {
  const Icon = ROLE_ICONS[role] ?? FALLBACK_ROLE_ICON;
  return <Icon className={className} strokeWidth={1.6} />;
}
