# Gameplay footage previews

Studio → Stewie starts with **Auto**, which sends an empty background choice and lets the Workdash worker pick a random clip. Selecting a thumbnail sends that clip's exact name to the existing render pipeline.

The picker shows frames from your own gameplay files. After connecting Workdash, run this on the One Person Company host with a copy of the worker's background folder:

```sh
npm run gameplay-previews -- /path/to/worker/video_assests/backgrounds
```

FFmpeg extracts one small JPEG per MP4. Full videos are not copied. Run the command again after adding, replacing or removing clips; it replaces the catalogue only after every preview succeeds. Use the same `OPC_DATA_DIR` and `OPC_ENV_FILE` as your app when running a custom deployment.

The catalogue and images stay in the ignored application data directory, scoped to the connected Workdash agent. They are served through authenticated local routes, with browser caching and lazy image loading. No service key or source folder path reaches the browser.

When the worker is awake, its current clip list determines the available choices. When it is asleep, the imported catalogue remains available. An unfamiliar clip still appears by name with “Preview unavailable” until its preview is imported. Viewing the picker does not wake the worker, load a gameplay video or launch an encoder.
