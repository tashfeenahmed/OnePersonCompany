/**
 * THE MANAGED AGENTS' DOORS.
 *
 * ONE ROUTE FOR BOTH, AND THAT IS THE SAME ARGUMENT `/api/chat` MAKES. A
 * caller never learns which agent answered it except as a fact on the answer,
 * so there is no `/api/hermes` and no `/api/openclaw`: there is a list of two,
 * with the state of each, and the id in the path. The two integrations keep
 * their credential pages under `/api/plugins` like every other plugin; this is
 * where the PROCESSES are managed.
 *
 *   GET  /api/agents                    both, plus which is live
 *   GET  /api/agents/:id                one
 *   POST /api/agents/:id/install        start the install (long, so: a job)
 *   POST /api/agents/:id/start          configure from the active provider, spawn
 *   POST /api/agents/:id/stop           SIGTERM, and stop it coming back at boot
 *   POST /api/agents/:id/reconfigure    rewrite its provider config now
 *   POST /api/agents/:id/make-live      make it the chat backend
 *   POST /api/agents/:id/mode           managed instance, or pasted credentials
 *
 * NO ROUTE HERE RETURNS A SECRET, and none could: the report type has no field
 * that can hold one. The provider key is written to the agent's config file at
 * mode 0600 and the door key to a file beside it, and neither is ever put in a
 * response, a log line or a command-line argument.
 *
 * THE LIVE BACKEND IS WRITTEN THROUGH `pluginConfig`, not from here. That
 * module owns the `chat.backend` key and its validation, and a second writer
 * would be a second opinion about what a legal value is — the exact mistake
 * the closed registries in this codebase exist to prevent.
 */
import { Hono } from "hono";
import * as instance from "../agents/instance.ts";
import { readChatBackend, writeChatBackend } from "./pluginConfig.ts";
import { activeProvider } from "../models/provider.ts";

export const agentRoutes = new Hono();

/** The path parameter, checked once. An id outside the two is a 404 rather
 *  than a lookup that returns undefined three lines later. */
function parse(raw: string): instance.AgentId | null {
  return raw === "hermes" || raw === "openclaw" ? raw : null;
}

/**
 * Both agents, and the two facts that are about the pair rather than either.
 *
 * `live` is which one answers a chat turn — the single `chat.backend` value,
 * which is where "only one" is enforced for the whole app. `provider` says
 * whether there is anything to point an agent at AT ALL, because "install
 * refused" and "no model provider" are different sentences and only one of
 * them is about this feature.
 */
function everything() {
  const live = readChatBackend();
  const p = activeProvider();
  return {
    agents: instance.AGENT_IDS.map((id) => instance.report(id, live)),
    /* Which is chosen as the chat backend — managed or remote, this route does
       not care and neither does chat/backend.ts. */
    live,
    /* Which managed agent has a CHILD PROCESS. Not the same question: an agent
       can be running and not chosen, and that is worth being able to see. */
    running: instance.runningAgent(),
    provider: p
      ? {
          id: p.id,
          label: p.label,
          /* The endpoint's label and URL, never its key. */
          endpoints: p.endpoints.map((e) => ({ label: e.label, baseUrl: e.baseUrl })),
          defaultModel: p.defaultModel,
        }
      : null,
    /* Said in words rather than left to the page to reconstruct from a null. */
    why: p
      ? null
      : "No default model provider is connected, so neither agent can be started. " +
        "Connect FreeLLMAPI, a local model, OpenAI or OpenRouter and make one the default.",
  };
}

agentRoutes.get("/", (c) => c.json(everything()));

agentRoutes.get("/:id", (c) => {
  const id = parse(c.req.param("id"));
  if (!id) return c.json({ error: "There are two agents: hermes and openclaw." }, 404);
  return c.json(instance.report(id, readChatBackend()));
});

/**
 * Begin an install.
 *
 * 202 AND NOT 200, because nothing is installed when this answers. Hermes is a
 * clone, a Python 3.11 virtualenv and a compiled dependency tree; OpenClaw is
 * an npm tree of a few hundred packages. The state is polled from
 * `GET /api/agents`, which carries the step and the last lines of output —
 * this says only whether the job STARTED.
 */
agentRoutes.post("/:id/install", (c) => {
  const id = parse(c.req.param("id"));
  if (!id) return c.json({ error: "There are two agents: hermes and openclaw." }, 404);
  const started = instance.install(id);
  if (!started.ok)
    return c.json({ error: started.error, ...instance.report(id, readChatBackend()) }, 409);
  return c.json(instance.report(id, readChatBackend()), 202);
});

/**
 * Configure it from the active provider, then spawn it.
 *
 * 409 covers three refusals that are all "not now" rather than "not ever": not
 * installed, no model provider to point it at, and the other agent already
 * running. Each carries its own sentence, because the fix for each is a
 * different button on the same page.
 */
agentRoutes.post("/:id/start", async (c) => {
  const id = parse(c.req.param("id"));
  if (!id) return c.json({ error: "There are two agents: hermes and openclaw." }, 404);
  const started = await instance.start(id);
  if (!started.ok)
    return c.json({ error: started.error, ...instance.report(id, readChatBackend()) }, 409);
  return c.json(instance.report(id, readChatBackend()));
});

agentRoutes.post("/:id/stop", async (c) => {
  const id = parse(c.req.param("id"));
  if (!id) return c.json({ error: "There are two agents: hermes and openclaw." }, 404);
  await instance.stop(id, "asked to stop from the plugin page");
  return c.json(instance.report(id, readChatBackend()));
});

/**
 * Rewrite this agent's provider config from whatever is the default right now.
 *
 * There is a watcher that does this on its own every fifteen seconds — see
 * `watchProvider` — so this route is the impatient version of it, for the
 * moment straight after somebody changes the default provider and wants to see
 * the agent follow. A running agent is restarted, because neither of them
 * re-reads its config file.
 */
agentRoutes.post("/:id/reconfigure", async (c) => {
  const id = parse(c.req.param("id"));
  if (!id) return c.json({ error: "There are two agents: hermes and openclaw." }, 404);
  const done = await instance.reconfigure(id);
  if (!done.ok)
    return c.json({ error: done.error, ...instance.report(id, readChatBackend()) }, 409);
  return c.json(instance.report(id, readChatBackend()));
});

/**
 * Make this one the agent that answers.
 *
 * IT IS THE SAME SWITCH `PUT /api/chat/backend` FLIPS, deliberately: there is
 * one `chat.backend` value and one place that decides what may be written to
 * it. This route exists because the agents page is where somebody is standing
 * when they want it, not because the rule is different here.
 *
 * IT DOES NOT CHECK THAT THE AGENT IS RUNNING. Choosing a backend that is not
 * connected yet is a first-class state everywhere else in this app — pick it,
 * then go and start it — and the answer comes back with the whole state, so a
 * choice that did not make anything live says so without a second request.
 */
agentRoutes.post("/:id/make-live", (c) => {
  const id = parse(c.req.param("id"));
  if (!id) return c.json({ error: "There are two agents: hermes and openclaw." }, 404);
  writeChatBackend(id);
  return c.json(everything());
});

/**
 * Which credential this plugin uses: the managed instance, or a pasted remote
 * one.
 *
 * BOTH CAN EXIST AT ONCE and that is the reason this is a setting rather than
 * an inference. An owner with a Hermes on another box and a Hermes here has
 * two accounts in the vault, both valid, and nothing in "which is connected"
 * can decide between them. The adapters read this value; `managed` sends a
 * chat turn to the account this app created, anything else falls back to the
 * first connected one, which is the rule that was there before.
 */
agentRoutes.post("/:id/mode", async (c) => {
  const id = parse(c.req.param("id"));
  if (!id) return c.json({ error: "There are two agents: hermes and openclaw." }, 404);
  const body = (await c.req.json().catch(() => null)) as { mode?: string } | null;
  const mode = body?.mode;
  if (mode !== "managed" && mode !== "remote")
    return c.json({ error: 'Expected { mode: "managed" | "remote" }.' }, 400);
  instance.writeMode(id, mode);
  return c.json(instance.report(id, readChatBackend()));
});
