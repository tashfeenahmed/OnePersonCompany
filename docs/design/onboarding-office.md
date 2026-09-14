# Welcome office

The welcome illustration is a procedural Three.js scene, replacing the generated PNG. `OfficeIllustration.tsx` is a small React shell; `officeScene.ts` owns the camera, geometry and WebGL resources; `officeOrbit.ts` handles pointer capture, keyboard input and on-demand interaction frames. No models, textures, external fonts, environment maps or animation frameworks are downloaded.

The miniature office uses a blue-and-black X-ray style: translucent blue surfaces and additive edge outlines reveal the desk, planning board, books, plants and lamp through the walls. The fallback uses the same blue linework. A 2.8-second assembly and camera turn settles into a static view. Drag with a mouse, pen or finger to revolve the office, or use arrow keys while it is focused. Releasing a moving drag carries its recent angular velocity into a short friction-based glide. Holding still before release produces no glide. Horizontal rotation is unrestricted; vertical tilt is bounded above the floor. Home restores the initial view. Pointer interaction has no container border or visible instruction text; keyboard focus remains visible. The replay button runs the same finite intro from the chosen angle.

## Loading and rendering budget

- Import the scene only when the welcome illustration enters the viewport and the document is visible, after browser idle time (at most one second).
- Three.js is a separate dynamic chunk. Neither the application entry nor the onboarding chunk imports it eagerly. The initial production measurement is approximately 144 KB gzip for the optional scene, including Three.js.
- Cap intro rendering at 30fps. Drag and keyboard input coalesce into one render per browser frame. Momentum uses exact exponential integration with friction of 5.2 per second, capped angular velocity and a low-speed cutoff, with a hard stop after 1.8 seconds. It schedules no frames once settled. Re-grabbing, keyboard input, replay, hiding and unmounting interrupt the glide. Resizing requests a single render. Starting a drag settles and interrupts the intro; hiding or unmounting releases pointer capture and cancels pending interaction frames.
- Cap pixel ratio at 1.5 and the backing buffer at 1000 × 850 pixels. Shared mesh and edge geometries and materials; no lights, shadow maps or post-processing.
- Stop the intro when hidden or offscreen. Return to the settled view at the chosen angle when visible again.
- Respect reduced motion with one static render and no release momentum; direct dragging and keyboard rotation remain available. Data-saving mode, unavailable WebGL and context loss use the inline SVG fallback.
- On leaving welcome, cancel frames and idle callbacks, disconnect observers, remove event listeners, dispose mesh/edge geometry, material and renderer resources, release the WebGL context and remove the canvas.

This follows Three.js guidance on [rendering on demand](https://threejs.org/manual/en/rendering-on-demand.html) and [explicit resource disposal](https://threejs.org/manual/en/how-to-dispose-of-objects.html).

## Verification

`officeMotion.test.ts` checks finite animation, no idle frames, replay, reduced motion, cancellation when hidden, and disposal. `officeOrbit.test.ts` checks full revolutions, tilt limits, coalesced renders, mouse/touch/pen pointer handling, cancellation, keyboard controls and disposal. It also verifies decelerating momentum, comparable travel at 60Hz and 120Hz, eventual idle, interruption, reduced-motion behavior and pointer/keyboard focus styling. Browser checks cover real dragging and momentum, absence of a pointer focus border or visible hint, release outside the model, keyboard reset, the rendered scene, replay, welcome navigation and canvas removal. The production manifest verifies that the scene is absent from the app's eager import graph.
