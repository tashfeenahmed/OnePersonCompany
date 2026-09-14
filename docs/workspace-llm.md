# Workspace LLM

Open your user menu at the bottom of the sidebar, then **LLM**. Choose FreeLLMAPI, OpenRouter, Local or OpenAI. Connect credentials under **Models and connections** first. **Off** disables built-in LLM requests without deleting connections.

The choice is saved on the server and shared by Chat, Settings, sub-agents, Studio scripts, briefings, analysis and other built-in AI jobs. Each provider retains its configured model, endpoints and concurrency policy. Switching provider does not replace these settings. Other tabs refresh automatically.

Managed Hermes and OpenClaw instances inherit the choice before their next request. If an answer is already running, a configuration change waits for it to finish before restarting the agent; concurrent requests using the same configuration can still run in parallel. Preparation is bounded and cancellable. Remote assistants own their model configuration: use a managed instance when the workspace must control their model. Image, voice and rendering services retain their specialized engines.

## WorkDash Stewie handoff

Stewie uses the workspace LLM for its script and WorkDash for research, captures, voice cloning and rendering. Provider credentials never cross this handoff.

The connected WorkDash agent must support:

- `GET /agent/reel`: `externalScript: true`.
- `POST /agent/reel/prepare-script`: accepts `prompt`, `mode`, `urls`; returns `messages`, `grounded`, `sources`. This reads research without calling an LLM or waking the render worker.
- `POST /agent/reel/start`: accepts the existing options plus `script: { text, provider, model, grounded, sources }`. It validates six alternating Peter/Stewie lines, persists them with the job and renders them without rewriting them using another LLM. A resumed job reuses the saved script.

Older agents are reported as needing an update before a render starts. WorkDash's own requests without `script` keep their existing behavior.

Validation: `server/src/models/workspace-choice.test.ts` exercises persisted selection and text, tool and Stewie calls across all four providers using fake endpoints. `server/src/agents/provider-use.test.ts` covers concurrent answers, configuration changes, cancellation, failures and early stream closure. Tests run against disposable databases.
