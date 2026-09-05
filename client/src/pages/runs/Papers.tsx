import { RunApp } from "@/components/runs/RunApp";
import { PaperShelf } from "@/components/runs/PaperShelf";

/**
 * THE ONE THAT DOES NOT NEED A VENTURE.
 *
 * A paper is about a topic, and a topic is sometimes a business and sometimes
 * just a subject somebody wants a literature-backed argument about. So the
 * venture picker offers "no venture" here, and the topic box carries the run
 * on its own.
 *
 * THE SHELF AND THE LIBRARY ARE BOTH DRAWN because a machine-written paper is
 * worth exactly what its citations are: the scout builds the library first,
 * the writer may cite nothing outside it, and the library on screen is how
 * that rule is checked rather than trusted.
 *
 * AND THE PAPER ITSELF IS SHOWN, not offered. A finished run draws its PDF
 * above its report, and every row on the shelf opens the same viewer in place.
 * The typesetting is the point of this app — columns, figures, a numbered
 * bibliography — and a page that could only hand over a download would hide
 * exactly the thing worth looking at.
 *
 * `input.topic` is passed through to the library so what is listed follows
 * what is being typed. The key is the server's — if a future version of this
 * kind renames its field, the library widens to everything rather than
 * silently filtering on a field that no longer exists.
 */
export function Papers() {
  return (
    <RunApp
      kind="papers"
      slug="papers"
      name="Papers"
      extras={({ venture, input, settled }) => (
        <PaperShelf
          venture={venture}
          topic={input.topic ?? ""}
          refreshKey={settled}
        />
      )}
    />
  );
}
