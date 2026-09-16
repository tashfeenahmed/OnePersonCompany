# Welcome office illustration

`office-team.webp` is the 1200 × 1200 square illustration used by
`components/onboarding/OfficeIllustration.tsx`. It has a real alpha channel and is
approximately 237 KB. The welcome screen no longer imports the Three.js scene.

Generated with the built-in image-generation tool, using
`../studio/digital-studio.webp` as the aesthetic reference. The first output baked
in a checkerboard. A second image edit replaced that background with a solid
chroma key; direct local background removal, as previously authorized for the
Studio artwork, produced the final transparent WebP. The artwork's emerald fills
and black outlines were retained. Reviewed against white and dark backgrounds.

## Original generation prompt

Use case: illustration-story. Create a NEW square 1:1 onboarding illustration for One Person Company. The input image is STYLE REFERENCE ONLY: match its crisp flat editorial collage aesthetic, expressive geometric characters, bold cyan, hot pink, orange, red, emerald green and deep purple solid fills, playful black line details and overlapping inventive silhouettes. Change the subject and composition completely into a compact vibrant office for a solo founder and a team of helpful AI subagents. A central human founder at a desk coordinating four small friendly expressive assistant coworkers/robot agents at nearby desks. Convey research with a magnifying glass and papers, analysis with a small chart monitor, coding with simple code symbols on a laptop, and creative work with a pen tool and color swatches. Add an office plant, desk lamp, coffee mug, and a few floating linked task cards/checkmarks to convey collaboration. Arrange as one tightly interlocking balanced square composition, not separate icons, with layered desks and faces and a coherent office scene. Clear bold silhouettes legible at a 450px displayed size. Flat vector-like raster illustration, no 3D, no gradients, no glow, no photographic texture. No readable words, no typography, no logos, no watermark, no UI screenshot. All objects fully inside the square with about 5 percent breathing room around the silhouette. Background MUST be genuinely transparent alpha outside the illustration and through open negative spaces; do not draw a checkerboard, black rectangle, room wall or colored backdrop. Preserve black outline details inside the subjects. Output a high-quality square PNG illustration.

## Background edit prompt

Precise background replacement for production compositing. Preserve the square office illustration, all characters, robots, objects, linework, positions, colors and composition. Change ONLY the gray checkerboard background and all checkerboard gaps between objects to a completely flat solid pure chroma green RGB(0,255,0), hex #00FF00. The green is a temporary background for removal in production, not part of the illustration. Absolutely no checkerboard, transparency simulation, texture, shadows or gradients in this green area. Keep the existing emerald leaves their existing darker emerald; do not recolor the artwork. Every area that currently shows gray checks, including internal gaps between desks, cards and characters, must be exactly the same pure bright green. Keep edges crisp, all objects fully within the square, and preserve the rest unchanged.
