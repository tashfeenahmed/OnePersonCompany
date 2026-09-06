/**
 * `npm run install-service` — and, by the same file,
 * `npm run uninstall-service` and `npm run service-status`.
 *
 * WHY IT DEFAULTS TO A DRY RUN. Installing a service means putting a
 * supervised process into somebody's login session that will restart itself
 * and come back after a reboot. That is a thing to decide, not a thing to have
 * happen because you ran a command with a promising name. So the default run
 * writes the unit and the environment file into `deploy/out/`, prints them,
 * says exactly where they WOULD go, and stops. `--install` is the second,
 * explicit decision.
 *
 * IT IS NOT A SEPARATE PROGRAM FROM THE ROUTE. Everything here calls
 * `integrations/deploy/service.ts`, which is what Settings → Deployment calls
 * too — so the unit a person reads out of `deploy/out/` is byte-for-byte the
 * one either door installs. Two generators would be two answers to "what is
 * actually running", which is the question this whole area exists to answer.
 *
 * IT PRINTS RATHER THAN LOGS. This is a command somebody typed, so the output
 * is for a person: what was written, where, what to run next, and — for
 * `--status` — what the supervisor said, verbatim and trimmed.
 */
import { readFileSync } from "node:fs";
import { install, logTail, plan, status, uninstall, writeDryRun } from "../integrations/deploy/service.ts";
import { isolation } from "../integrations/deploy/isolation.ts";

const args = new Set(process.argv.slice(2));
const mode = args.has("--uninstall")
  ? "uninstall"
  : args.has("--status")
    ? "status"
    : args.has("--install")
      ? "install"
      : "plan";

function line(s = "") {
  console.log(s);
}

const p = plan();

if (p.platform === "unsupported" && mode !== "status") {
  line(`  There is no service format here for ${process.platform}.`);
  line("  This installer speaks launchd (macOS) and systemd user units (Linux).");
  line("  Run `npm start` under whatever supervisor this system uses.");
  process.exitCode = 1;
} else if (mode === "plan") {
  const written = writeDryRun();
  line();
  line(`  DRY RUN — nothing has been installed.`);
  line();
  line(`  Platform      ${p.platform === "darwin" ? "macOS (launchd user agent)" : "Linux (systemd user service)"}`);
  line(`  Runs as       ${p.user}`);
  line(`  Node          ${p.node}`);
  line(`  Entry         ${p.entry}`);
  line(`  Working dir   ${p.root}`);
  line(`  Logs          ${p.outLog}`);
  line(`                ${p.errLog}`);
  line();
  line(`  Unit written for reading:  ${written.unit}`);
  line(`  It would be installed at:  ${p.unitPath}`);
  line(`  Environment template:      ${written.env}`);
  line(`  It would be written at:    ${p.envPath}${""}`);
  line(`                             (only if that file does not already exist — an existing one is never replaced)`);
  line();
  line("  ---- the unit ----");
  line(readFileSync(written.unit, "utf8").trimEnd());
  line("  ------------------");
  line();
  line("  Install it with:  npm run install-service -- --install");
  line("  Remove it with:   npm run uninstall-service");
  line("  Check on it with: npm run service-status");
  line();
} else if (mode === "install") {
  const res = await install();
  line();
  for (const s of res.steps) line(`  ${s}`);
  line();
  if (!res.ok) {
    line(`  FAILED — ${res.error}`);
    process.exitCode = 1;
  } else {
    line(`  Installed. ${p.platform === "darwin" ? "launchd" : "systemd --user"} owns it now.`);
    line(`  Logs:   ${p.outLog}`);
    line(`          ${p.errLog}`);
    line(`  Status: npm run service-status`);
    if (p.platform === "linux") {
      line();
      line(`  A systemd USER service stops when ${p.user} logs out. For an unattended box:`);
      line(`      sudo loginctl enable-linger ${p.user}`);
      line("  That is the one command here that needs a privilege and it is not run for you.");
    } else {
      line();
      line("  A launchd USER agent runs only while you are logged in. A Mac that must serve");
      line("  this across a reboot with nobody logged in wants a LaunchDaemon, which runs as");
      line("  root before login — a different security conversation; see the README.");
    }
    line();
  }
} else if (mode === "uninstall") {
  const res = await uninstall();
  line();
  for (const s of res.steps) line(`  ${s}`);
  line();
  if (!res.ok) {
    line(`  FAILED — ${res.error}`);
    process.exitCode = 1;
  }
} else {
  const s = await status();
  const iso = isolation();
  line();
  line(`  Platform    ${s.platform}`);
  line(`  Label       ${s.label}`);
  line(`  Unit file   ${s.unitPath} ${s.installed ? "(present)" : "(NOT present)"}`);
  line(`  Environment ${s.envPath} ${s.envPresent ? "(present)" : "(NOT present)"}`);
  line(`  Running     ${s.running === null ? "unknown — the supervisor could not be asked" : s.running ? `yes, pid ${s.pid}` : "no"}`);
  line(`  Agent       ${iso.level}${iso.problem ? ` — ${iso.problem}` : ""}`);
  line();
  if (s.supervisor) {
    line("  ---- what the supervisor said ----");
    for (const l of s.supervisor.split("\n").slice(0, 30)) line(`  ${l}`);
    line("  ----------------------------------");
    line();
  }
  const tail = logTail("err", 15);
  line(`  ---- last lines of ${tail.path} ----`);
  if (!tail.lines.length) line(`  ${tail.note}`);
  for (const l of tail.lines) line(`  ${l}`);
  line();
  /* A service that is installed and not running is the state worth an exit
     code: it is what a monitor or a shell script is checking for. */
  if (s.installed && s.running === false) process.exitCode = 1;
}
