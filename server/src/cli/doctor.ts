/**
 * `npm run doctor` — what this box can do, before anything is asked of it.
 *
 * IT WAS THE SETUP REPORT AND IT STILL IS. `setupReport()` answers the local
 * readiness questions — is the data directory writable, is there a model, is
 * there a tool runtime, when was the last backup — and its JSON is the whole
 * of what anything parsing this output has ever seen. So it is still the top
 * level of the document and nothing was renamed inside it.
 *
 * WHAT IS ADDED IS THE OPERATING HALF, under two new keys. `deployment` is
 * whether this is a supervised service or a terminal process, plus the five
 * health checks — the difference between "this laptop can run the app" and
 * "this box IS running it, unattended, and is fine". `isolation` is how
 * separated the managed agent is from the credentials this process holds,
 * which is the question the README used to answer with a paragraph saying it
 * was not implemented.
 *
 * IT STILL EXITS NON-ZERO ONLY ON `writable`. That was the contract: a doctor
 * that failed because a laptop was not a production server would be a doctor
 * people stop running. A failing HEALTH check is reported in the document and
 * does not change the exit code — `npm run service-status` is the command
 * whose exit code means "the service is installed and not running", because
 * that is a question with one answer.
 */
import "../routes/chat.ts";
import "../routes/models.ts";
import { setupReport } from "../routes/setup.ts";
import { health } from "../integrations/deploy/health.ts";
import { isolation } from "../integrations/deploy/isolation.ts";
import { status } from "../integrations/deploy/service.ts";
import { manifestCollectors } from "../integrations/index.ts";
import { COLLECTORS as BUILTIN_COLLECTORS } from "../collector.ts";

const report = setupReport();
const collectorIds = Object.keys({ ...BUILTIN_COLLECTORS, ...manifestCollectors() }).sort();

const iso = isolation();
console.log(
  JSON.stringify(
    {
      ...report,
      deployment: {
        service: await status(),
        health: await health(collectorIds),
      },
      isolation: {
        level: iso.level,
        runningAs: iso.runningAs,
        configuredAgentUser: iso.configuredAgentUser,
        problem: iso.problem,
        agentHome: iso.agentHome,
        secretsLocked: iso.secretsLocked,
        scopedKeyRefusedOn: iso.scopedKey.refusedPrefixes.map((r) => r.prefix),
        agentKeyProblem: iso.agentKeyProblem,
        containerPath: iso.containerPath,
        summary: iso.summary,
        nextStep: iso.nextStep,
      },
    },
    null,
    2,
  ),
);
if (!report.writable) process.exitCode = 1;
