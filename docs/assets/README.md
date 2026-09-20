# README artwork

- `banner.svg` is original vector artwork using the application's warm neutral palette.
- `overview.png`, `venture-idea.png`, and `sub-agents.png` are screenshots of the real application, captured in an isolated demo installation.
- The README's videos are screen recordings of the same kind of isolated demo installation. GitHub only plays a video inline when it was uploaded through the web editor, so the files are not in the repository: they were attached to pull request #8 and the README references their `user-attachments` URLs. The workspace in them (Alex Morgan of Morgan Labs; Inkwell, Trailmark, Ledgerly, FormFox, Quiet Hours, Pixel Pantry) and every number, customer, email and domain shown are fictional.
- Morrow, Fieldnote, Harbor, Alex, the account labels, and all metrics in the screenshots are fictional. Their domains use the reserved `.test` namespace.

To update a screenshot, use a separate data directory and browser profile. Seed
only synthetic fixtures, finish workspace synchronization, and verify all images
and charts have loaded before capturing. Never capture a personal or production
workspace for public documentation, and do not copy its database or credentials
into a demo.

Keep the PNGs readable at GitHub's content width. Keep each video under GitHub's 10 MB upload limit, and include descriptive alt text wherever an image is used.
