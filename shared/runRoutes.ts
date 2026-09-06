/**
 * WHERE A RUN OF KIND X IS READ.
 *
 * There were three tables of this — here, the server's role roster, and the
 * client's rail — and they already disagreed. `shotsqa` resolved to `ops` in
 * one and to a page called "shotsqa" that does not exist in another;
 * `campaign` produced a link the rail had no entry for and so refused to draw
 * at all. A fourth kind had to be added in three files or it silently linked
 * nowhere, and nothing said which of the three was right.
 *
 * The kind, the APP SLUG and the URL are three different things and the middle
 * one is why this file is not just `runPage`. A page needs the slug on its own
 * (to name a tab, to group a roster) as well as the address, and a caller that
 * derives one from the other by string surgery is the fourth copy waiting to
 * happen. Both come out of here.
 */
import { appPage } from "./navigation.ts";

/**
 * THE KINDS WHOSE PAGE IS NOT NAMED AFTER THEM. Everything absent is its own
 * slug, which is the right guess and the only one available: a kind added by
 * the runs area appears at its own page rather than at nothing.
 *
 *   geo      the measurement is called GEO in the trade; the app is Visibility.
 *   shotsqa  a screenshot check is read on the Ops page, not on one of its own.
 */
const APP_FOR_KIND: Readonly<Record<string, string>> = {
  geo: "visibility",
  shotsqa: "ops",
};

/** The app slug a run of this kind is read under. */
export function appForKind(kind: string): string {
  return Object.hasOwn(APP_FOR_KIND, kind) ? APP_FOR_KIND[kind]! : kind;
}

/** The address of one run. `appPage` maps a slug to its area — a campaign run
 *  is read on the Publishing page — so this is the slug lookup and that one,
 *  in that order, and never a path built by hand. */
export function runPage(kind: string, id: string): string {
  return appPage(appForKind(kind), id);
}
