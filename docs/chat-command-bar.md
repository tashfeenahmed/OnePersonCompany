# Chat command bar

`client/src/components/chat/CommandBar.tsx` adapts the Bencho Command pattern
provided in the design reference to the app's existing chat composer.

- The input stays still. A 56px action moves out from beneath its right edge,
  with 12px of reserved space between them. The liquid silhouette and button
  share the same transform; there is no separate CSS translation.
- The default corner, bridge and edge settings are 28, 3 and 22. Fill comes
  from the app's opaque card tokens, so all palettes and both themes work.
- The empty-state Enter hint only fades. The attachment button remains
  available, and venture selection and Integrations sit below the bar.
- Send stays visible as Stop while a response is running, even when the
  draft is empty. Enter sends, Shift+Enter inserts a newline, and IME
  composition does not send. Clicking Send or Stop returns focus to the input.
- Draft storage, file reading, request routing and cancellation still belong
  to Chat. The reusable bar doesn't create another copy of chat state.

`liquid-gooey` is loaded with the lazy Chat page. No Framer Motion dependency,
continuous animation or page-wide SVG filter is needed for this interaction.
The package handles reduced-motion transforms; the idle hint and action icon
also disable their fades when reduced motion is requested. Text and controls
are separate from the filtered silhouette.

Dependency: [Liquid Gooey](https://github.com/Jakubantalik/Libraries/tree/main/packages/liquid-gooey),
MIT. Its license is included in `client/public/licenses/liquid-gooey.txt`.
