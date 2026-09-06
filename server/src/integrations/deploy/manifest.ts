/**
 * DEPLOY — how this app RUNS, as against what it measures.
 *
 * IT IS AN AREA AND NOT A PAGE IN SETTINGS, because three separate things
 * share one subject and none of them is a measurement of a venture:
 *
 *   THE SERVICE. Whether the process is supervised, whether it comes back
 *   after a reboot, where its logs are, what its own health checks say, and
 *   how often each source is collected. See service.ts, health.ts,
 *   scheduler.ts and cadence.ts.
 *
 *   THE AGENT'S BOX. How separated a spawned Hermes or OpenClaw is from this
 *   process's credentials — a scoped API key that is refused on the owner
 *   surface, a working directory that is not the repository, and optionally a
 *   separate OS account or a container. See isolation.ts.
 *
 *   THE MACHINE LEASES. Who is using a shared GPU or desk machine, so that
 *   nothing sleeps it out from under them, and who woke it so that this app
 *   only ever powers off what it powered on. See leases.ts.
 *
 * NO CREDENTIAL. Nothing here talks to a vendor: every fact on this area is
 * read from this machine's own filesystem, its own supervisor, its own
 * database. So there is no plugin entry and no collector — a collector is a
 * fetch from somebody else's API, and there is nobody else in this story.
 *
 * ONE CONFIG ENTRY ON A PSEUDO-PLUGIN, which is `chat`'s and `models`' trick:
 * `deploy` is a row in `plugins` with no account behind it, holding the one
 * setting this area owns. The per-source COLLECTION CADENCE is not here — it
 * is one key added to every collectable plugin's own settings page, from
 * routes/pluginConfig.ts, because a cadence belongs on the page of the thing
 * it collects.
 *
 * `onStart` DOES TWO CHEAP THINGS AND SWEEPS NOTHING. It mints the scoped
 * agent key (so the `opc` wrapper has something to `cat` before an agent is
 * ever installed) and tightens the modes on the four files a separate agent
 * account must not be able to read. It deliberately does NOT release stale
 * leases at boot: a lease that lapsed while the process was down is a fact
 * about a job that died, and sweeping it silently at every restart — which on
 * a development box is several times an hour — would erase exactly the
 * evidence somebody restarted to go and look for.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { agentKey } from "../../auth.ts";
import { deployRoutes } from "./deploy-routes.ts";
import { AGENT_USER_KEY, PLUGIN, hardenSecrets } from "./isolation.ts";
import { SKILLS, PACKS } from "./skills.ts";

export const manifest: IntegrationManifest = {
  id: "deploy",

  config: {
    [PLUGIN]: {
      keys: {
        [AGENT_USER_KEY]: {
          label: "Run the agent as this OS user",
          hint:
            "EMPTY IS THE DEFAULT AND IS NOT A MISTAKE: the managed agent runs as you, in its own working " +
            "directory, with a minimal environment and a scoped API key. Naming another account here makes this " +
            "app spawn the gateway through `sudo -u <user>` instead, so that vault.key, the database and the " +
            "owner service key are unreadable to it — which is the only isolation the filesystem will actually " +
            "enforce. THE ACCOUNT HAS TO EXIST AND THE SUDO RULE HAS TO BE IN PLACE FIRST: run " +
            "`deploy/agent-user.sh` once, read what it prints, and only then type the name here. Until both are " +
            "true the spawn fails with sudo's own error and the agent will not start. OPC_AGENT_USER in the " +
            "environment overrides this box.",
          ph: "opc-agent",
          check(value) {
            const v = value.trim();
            if (!v) return null;
            if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(v))
              return "That is not a POSIX user name — lower case, starting with a letter or underscore, at most 32 characters.";
            return null;
          },
        },
      },
    },
  },

  skills: SKILLS,
  packs: PACKS,

  routes: [{ path: "/api/deploy", app: deployRoutes }],

  onStart() {
    /* Minted unconditionally, for the reason security/manifest.ts mints the
       owner key: the two things that read it are a two-line shell wrapper and
       a subprocess's environment, and neither can create a file. */
    agentKey();
    const changed = hardenSecrets();
    for (const c of changed) console.log(`[deploy] tightened ${c.path} from ${c.from} to ${c.to}`);
  },
};
