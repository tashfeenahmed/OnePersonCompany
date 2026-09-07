import { useState } from "react";
import { cn } from "@/lib/utils";
import type { WatchPerson } from "@/lib/api/people";

/**
 * A WATCHED PERSON'S FACE, OR THE LETTER THAT STANDS IN FOR ONE.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONE TILE. The rail rows, the cards, the file header and the
 * composer chip all used to draw their own initial-letter square; a picture
 * that only some of them knew about would have been four places to remember,
 * and the one that forgot would be the page where somebody's face is missing.
 * So the letter lives here too, as the fallback, and there is nothing else to
 * call.
 *
 * A PICTURE IS THE SERVER'S ANSWER AND NOT A GUESS. `avatar` is a relative URL
 * on this box serving bytes it fetched from GitHub or Bluesky, and `null` is
 * "we looked and there was nothing" — never a gravatar of an email hash and
 * never a generated face, because a face nobody has is worse than a letter.
 *
 * IT IS DECORATIVE, DELIBERATELY. `alt=""` everywhere: the name is drawn right
 * beside it on every single caller, and a screen reader saying "Jane Doe, Jane
 * Doe" is the same fact twice.
 *
 * THE URL IS STABLE AND THE BYTES ARE NOT. `/api/people/watch/<id>/avatar` is
 * the same address before and after a pull, and the server sets cache headers
 * on it — so a refreshed photo would keep drawing as the old one until the
 * browser felt like asking again. `?v=` carries the row's own stamp, which
 * moves when the row does, so a new picture is a new URL and an unchanged one
 * is still a cache hit.
 *
 * A BROKEN IMAGE FALLS BACK RATHER THAN BREAKING. The failed src is what is
 * remembered, not a boolean: a person whose picture 404s draws the letter, and
 * the moment their stamp changes the new URL is tried once more.
 */

/** Everything this needs of a person, so a caller holding a narrower row than
 *  the whole `WatchPerson` can still draw them. */
export type AvatarPerson = Pick<
  WatchPerson,
  "name" | "avatar" | "updatedAt" | "activityAt"
>;

/** How big the letter is inside a tile of `size` px. A line rather than a
 *  table, so a size nobody has drawn yet still reads: it passes through the
 *  two this app has always drawn — 22px rail rows at 11.5px, 40px file headers
 *  at 16px. */
const letterPx = (size: number) => Math.round((6 + size * 0.25) * 2) / 2;

/** The picture's address with the row's own stamp on it, or null for somebody
 *  with no picture. `activityAt` FIRST: the picture is fetched by a pull, and
 *  a pull moves `activityAt` and deliberately leaves `updatedAt` alone — that
 *  is the owner's edit time. `updatedAt` is the fallback for a row that has
 *  never been pulled, which has no picture to keep fresh anyway. */
function src(person: AvatarPerson): string | null {
  if (!person.avatar) return null;
  const v = person.activityAt || person.updatedAt || "";
  return v ? `${person.avatar}?v=${encodeURIComponent(v)}` : person.avatar;
}

export function PersonAvatar({
  person,
  size = 22,
  className,
}: {
  person: AvatarPerson;
  /** The square's side, in px. Defaults to the rail's 22. */
  size?: number;
  className?: string;
}) {
  /* The src that failed, rather than "it failed": see the header. */
  const [broken, setBroken] = useState<string | null>(null);
  const url = src(person);
  const style = { width: size, height: size };

  if (url !== null && url !== broken) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setBroken(url)}
        style={style}
        className={cn("bg-muted shrink-0 rounded-full object-cover", className)}
      />
    );
  }

  return (
    <div
      style={{ ...style, fontSize: letterPx(size) }}
      className={cn(
        "bg-muted text-foreground grid shrink-0 place-items-center rounded-full font-semibold",
        className,
      )}
    >
      {person.name.trim()[0]?.toUpperCase() ?? "?"}
    </div>
  );
}
