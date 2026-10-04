/**
 * A FIGURE THE MODEL DESCRIBES AND THIS FILE DRAWS.
 *
 * The draftsman (typst.ts) asks the model for a hand-placed SVG, which is the
 * better picture when it arrives. On the Dell's local thinking model it mostly
 * did not: from 2026-09-17 every papers run spent its whole answer reasoning
 * about coordinates ("Let me carefully plan this figure…", 12–15k characters)
 * and never reached `</svg>`, so a month of papers printed with no diagram.
 *
 * This is the path that cannot fail that way. The model is asked for a few
 * hundred tokens of JSON — boxes, which stage each sits in, and the arrows
 * between them — and the layout is arithmetic here: stages are columns left to
 * right, boxes stack inside a stage, labels wrap to the box, arrows run edge to
 * edge and a backward arrow loops underneath. The result is plain, always
 * landscape, always inside the canvas the draftsman's checks want, and uses
 * only elements resvg prints.
 */

export const DIAGRAM_SPEC = `You describe one diagram for an academic paper as a small JSON object. A program lays it out and draws it; you only say WHAT is in it.

Reply with ONLY a fenced code block whose info string is exactly \`json diagram\`, holding this shape:
{
  "stages": ["Input", "Mechanism", "Output"],
  "nodes": [{ "id": "a", "label": "what this box is, 2-6 words", "stage": 0 }],
  "edges": [{ "from": "a", "to": "b", "label": "optional, 1-3 words" }]
}

RULES:
- 2 to 5 stages, in reading order left to right. A stage heading is 1-3 words.
- 3 to 10 nodes. "stage" is the index of the stage the box sits in. At most 3 nodes per stage.
- Labels are short noun phrases — they are printed inside a narrow box. No sentences.
- Edges show what flows or depends on what. Most go from an earlier stage to a later one; a feedback loop may go backwards.
- It must show the MECHANISM the caption names, so a reader who sees only the figure understands the idea.
- No prose outside the block. Do not think out loud.`;

export type DiagramSpec = {
  stages: string[];
  nodes: { id: string; label: string; stage: number }[];
  edges: { from: string; to: string; label: string }[];
};

/** The spec out of whatever the model said: the fenced block, else the first
 *  `{` to the last `}`. Parsed and bounded, never repaired. */
export function parseDiagram(text: string): DiagramSpec | { error: string } {
  const raw = String(text ?? "");
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(raw)?.[1];
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  let o: unknown = null;
  for (const candidate of [fence, open >= 0 && close > open ? raw.slice(open, close + 1) : undefined]) {
    if (!candidate) continue;
    try {
      o = JSON.parse(candidate);
      break;
    } catch {
      /* the next shape, or none */
    }
  }
  if (!o || typeof o !== "object" || Array.isArray(o))
    return { error: `no diagram object in ${raw.length} characters — it began “${raw.slice(0, 80)}”` };
  const r = o as Record<string, unknown>;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

  const stages = (Array.isArray(r.stages) ? r.stages : []).map((x) => str(x, 28)).filter(Boolean).slice(0, 5);
  const seen = new Set<string>();
  const nodes = (Array.isArray(r.nodes) ? r.nodes : [])
    .map((x) => {
      const n = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      return { id: str(n.id, 40), label: str(n.label, 60), stage: Math.trunc(Number(n.stage)) };
    })
    .filter((n) => n.id && n.label && !seen.has(n.id) && (seen.add(n.id), true))
    .slice(0, 12);
  if (nodes.length < 2) return { error: `the diagram had ${nodes.length} usable node${nodes.length === 1 ? "" : "s"}` };

  /* A stage index that is missing or out of range is clamped rather than
     refused — the boxes and arrows are the content, the column is layout. */
  const columns = Math.max(stages.length, 1);
  for (const n of nodes) n.stage = Number.isFinite(n.stage) ? Math.min(Math.max(n.stage, 0), columns - 1) : 0;
  if (!stages.length) {
    const used = Math.max(...nodes.map((n) => n.stage)) + 1;
    for (let i = 0; i < used; i += 1) stages.push("");
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(r.edges) ? r.edges : [])
    .map((x) => {
      const e = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      return { from: str(e.from, 40), to: str(e.to, 40), label: str(e.label, 22) };
    })
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    .slice(0, 16);

  return { stages, nodes, edges };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Greedy word wrap to a character budget, at most `lines` lines. */
function wrap(text: string, chars: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= chars || !line) line = next;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = `${out[lines - 1]!.slice(0, chars - 1)}…`;
  }
  return out.map((l) => (l.length > chars ? `${l.slice(0, chars - 1)}…` : l));
}

/**
 * The spec, drawn. 560 units wide — the draftsman's maximum, so a column-wide
 * figure prints its 10-unit labels at a readable size — and as tall as the
 * fullest stage needs, within 150–300.
 */
export function renderDiagram(spec: DiagramSpec): string {
  const W = 560;
  const FONT = 10;
  const cols = spec.stages.length;
  const colW = W / cols;
  const boxW = Math.min(colW - 26, 150);
  const chars = Math.max(8, Math.floor(boxW / (FONT * 0.55)));
  const lineH = FONT + 3;
  const header = spec.stages.some(Boolean) ? 22 : 6;

  const byStage = spec.stages.map((_, i) => spec.nodes.filter((n) => n.stage === i));
  const labels = new Map(spec.nodes.map((n) => [n.id, wrap(n.label, chars, 3)]));
  const boxH = Math.max(...spec.nodes.map((n) => labels.get(n.id)!.length)) * lineH + 12;
  const most = Math.max(...byStage.map((s) => s.length));
  const hasBack = spec.edges.some((e) => {
    const a = spec.nodes.find((n) => n.id === e.from)!;
    const b = spec.nodes.find((n) => n.id === e.to)!;
    return b.stage <= a.stage;
  });
  const gap = 18;
  const H = Math.min(300, Math.max(150, header + most * boxH + (most - 1) * gap + (hasBack ? 34 : 14)));
  const bodyH = H - header - (hasBack ? 30 : 8);

  const pos = new Map<string, { x: number; y: number; stage: number }>();
  byStage.forEach((nodes, i) => {
    const stackH = nodes.length * boxH + (nodes.length - 1) * gap;
    const top = header + Math.max(0, (bodyH - stackH) / 2);
    nodes.forEach((n, j) => pos.set(n.id, { x: i * colW + (colW - boxW) / 2, y: top + j * (boxH + gap), stage: i }));
  });

  const parts: string[] = [];
  parts.push(
    `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
      `<path d="M0 0 L10 5 L0 10 z" fill="#333333"/></marker></defs>`,
  );
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);

  spec.stages.forEach((label, i) => {
    if (i > 0)
      parts.push(
        `<line x1="${(i * colW).toFixed(1)}" y1="4" x2="${(i * colW).toFixed(1)}" y2="${H - 4}" stroke="#dddddd" stroke-width="1" stroke-dasharray="3 3"/>`,
      );
    if (label)
      parts.push(
        `<text x="${(i * colW + colW / 2).toFixed(1)}" y="14" font-family="serif" font-size="${FONT + 1}" font-weight="bold" text-anchor="middle" fill="#222222">${esc(label)}</text>`,
      );
  });

  let back = 0;
  for (const e of spec.edges) {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    const ay = a.y + boxH / 2;
    const by = b.y + boxH / 2;
    let d: string;
    let lx: number;
    let ly: number;
    if (b.stage > a.stage) {
      const x1 = a.x + boxW;
      const x2 = b.x;
      const mx = (x1 + x2) / 2;
      d = `M${x1.toFixed(1)} ${ay.toFixed(1)} C${mx.toFixed(1)} ${ay.toFixed(1)} ${mx.toFixed(1)} ${by.toFixed(1)} ${(x2 - 1).toFixed(1)} ${by.toFixed(1)}`;
      /* Midway across the gap at the TARGET's height: two arrows fanning out
         of one box have parted by then, and the label clears both boxes. */
      lx = mx;
      ly = by - 4;
    } else if (b.stage === a.stage) {
      /* Same stage: straight down (or up) between the stacked boxes. */
      const x = a.x + boxW / 2;
      const down = b.y > a.y;
      const y1 = down ? a.y + boxH : a.y;
      const y2 = down ? b.y : b.y + boxH;
      d = `M${x.toFixed(1)} ${y1.toFixed(1)} L${x.toFixed(1)} ${(y2 + (down ? -1 : 1)).toFixed(1)}`;
      lx = x + 4;
      ly = (y1 + y2) / 2 + 3;
    } else {
      /* Backwards: a loop underneath everything, each one a little lower. */
      const floor = H - 14 + Math.min(back, 2) * 4;
      back += 1;
      const x1 = a.x + boxW / 2;
      const x2 = b.x + boxW / 2;
      d = `M${x1.toFixed(1)} ${(a.y + boxH).toFixed(1)} L${x1.toFixed(1)} ${floor.toFixed(1)} L${x2.toFixed(1)} ${floor.toFixed(1)} L${x2.toFixed(1)} ${(b.y + boxH + 1).toFixed(1)}`;
      lx = (x1 + x2) / 2;
      ly = floor - 3;
    }
    parts.push(`<path d="${d}" fill="none" stroke="#333333" stroke-width="1.2" marker-end="url(#ah)"/>`);
    if (e.label)
      parts.push(
        `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-family="serif" font-size="${FONT - 2}" font-style="italic" text-anchor="${b.stage === a.stage ? "start" : "middle"}" fill="#444444" stroke="#ffffff" stroke-width="3" paint-order="stroke">${esc(e.label)}</text>`,
      );
  }

  for (const n of spec.nodes) {
    const p = pos.get(n.id)!;
    const lines = labels.get(n.id)!;
    parts.push(
      `<rect x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH}" rx="4" fill="#f4f6fa" stroke="#333333" stroke-width="1"/>`,
    );
    const first = p.y + boxH / 2 - ((lines.length - 1) * lineH) / 2 + FONT * 0.35;
    lines.forEach((l, i) =>
      parts.push(
        `<text x="${(p.x + boxW / 2).toFixed(1)}" y="${(first + i * lineH).toFixed(1)}" font-family="serif" font-size="${FONT}" text-anchor="middle" fill="#111111">${esc(l)}</text>`,
      ),
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}
