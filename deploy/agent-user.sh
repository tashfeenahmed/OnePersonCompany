#!/bin/sh
# ---------------------------------------------------------------------------
# A DEDICATED OS ACCOUNT FOR THE MANAGED AGENT — the one-time setup that turns
# OnePersonCompany's `same-user` isolation into `separate-user`.
#
# WHAT PROBLEM THIS SOLVES. By default the managed gateway (Hermes or OpenClaw)
# runs as you. It gets a minimal environment and a working directory of its
# own, and it holds an API key that is refused on the owner surface — but the
# FILESYSTEM does not stop it opening server/data/vault.key, which decrypts
# every credential on the box, or the database, or the owner's service key.
# The only thing that stops that is a different uid.
#
# WHAT IT DOES. Creates an account, gives it the agent home and nothing else,
# and installs a sudoers rule that lets YOU start a process as it — without a
# password, because the API has no terminal to type one into, and limited to
# exactly the two gateway binaries so the rule is not a general-purpose root
# ladder.
#
# IT SHOWS BEFORE IT ACTS. Run it with no arguments and it prints exactly what
# it would do and stops. `--apply` performs it. It needs sudo for the account
# and the sudoers file and asks for it there rather than being run as root, so
# that the "who is the owner" question has an answer.
#
# WHAT YOU GIVE UP. The agent can no longer read your files. That is the point,
# and it is also the cost: an agent asked to look at a repository in your home
# directory cannot, and one that shells out to a tool configured in your
# dotfiles gets the account's own configuration instead. Decide that first.
# ---------------------------------------------------------------------------
set -eu

AGENT_USER="${OPC_AGENT_USER:-opc-agent}"
APPLY=""
[ "${1:-}" = "--apply" ] && APPLY=1

# The repository this script sits in, and the data directory under it.
HERE=$(cd "$(dirname "$0")/.." && pwd)
DATA_DIR="${OPC_DATA_DIR:-$HERE/server/data}"
AGENT_HOME="$DATA_DIR/agent-home"
OWNER=$(id -un)
OS=$(uname -s)

say() { printf '%s\n' "$*"; }
step() { printf '  %s\n' "$*"; }

say ""
say "  Agent account setup for OnePersonCompany"
say ""
say "  repository   $HERE"
say "  data dir     $DATA_DIR"
say "  agent home   $AGENT_HOME"
say "  owner        $OWNER"
say "  agent user   $AGENT_USER"
say "  platform     $OS"
say ""

if [ "$OS" != "Linux" ] && [ "$OS" != "Darwin" ]; then
  say "  This script speaks Linux (useradd) and macOS (dscl). On $OS, create a"
  say "  service account by hand, give it $AGENT_HOME, and add a NOPASSWD sudo"
  say "  rule for the two gateway binaries."
  exit 1
fi

# --------------------------------------------------------------- the plan ---

GATEWAYS="$DATA_DIR/hermes/home/.local/bin/hermes $DATA_DIR/openclaw/node_modules/.bin/openclaw"
SUDOERS_FILE="/etc/sudoers.d/opc-agent"
SUDOERS_LINE="$OWNER ALL=($AGENT_USER) NOPASSWD: $DATA_DIR/hermes/home/.local/bin/hermes, $DATA_DIR/openclaw/node_modules/.bin/openclaw, /usr/bin/env"

say "  WHAT WOULD HAPPEN"
say ""
if [ "$OS" = "Linux" ]; then
  step "sudo useradd --system --home-dir $AGENT_HOME --shell /usr/sbin/nologin $AGENT_USER"
else
  step "sudo dscl . -create /Users/$AGENT_USER  (a hidden service account, uid picked from the free range)"
fi
step "sudo chown -R $AGENT_USER $AGENT_HOME        # the agent owns its home and only its home"
step "chmod 0600 $DATA_DIR/vault.key $DATA_DIR/service-key $DATA_DIR/opc.db"
step "chmod 0600 $AGENT_HOME/service-key.agent  then  sudo chown $AGENT_USER $AGENT_HOME/service-key.agent"
step "sudo chmod -R a+rX $DATA_DIR/hermes $DATA_DIR/openclaw   # the installs are readable, not writable"
step "echo '$SUDOERS_LINE' | sudo tee $SUDOERS_FILE && sudo chmod 0440 $SUDOERS_FILE"
say ""
say "  AND THEN, IN THE APP: Settings -> Deployment -> \"Run the agent as this OS"
say "  user\" -> $AGENT_USER. Restart the agent from Settings -> Models."
say ""
say "  WHAT THE AGENT WILL STILL BE ABLE TO REACH"
say ""
step "http://127.0.0.1:8787/api  with the SCOPED key at $AGENT_HOME/service-key.agent"
step "  — every skill, every board write, the mailbox, the machines"
step "  — refused on /api/plugins writes, /api/backups, /api/security writes,"
step "    /api/agents writes, /api/models writes and /api/workspace writes"
step "$AGENT_HOME  and the two gateway installations, read-only"
say ""
say "  WHAT IT WILL NOT BE ABLE TO READ"
say ""
step "$DATA_DIR/vault.key      — every credential on this box"
step "$DATA_DIR/service-key    — the owner key, which opens everything"
step "$DATA_DIR/opc.db         — the database"
step "your home directory"
say ""

if [ -z "$APPLY" ]; then
  say "  Nothing has been done. Run it again with --apply to perform it."
  say ""
  exit 0
fi

# -------------------------------------------------------------- the doing ---

if id "$AGENT_USER" >/dev/null 2>&1; then
  say "  $AGENT_USER already exists; leaving the account alone."
elif [ "$OS" = "Linux" ]; then
  sudo useradd --system --home-dir "$AGENT_HOME" --shell /usr/sbin/nologin "$AGENT_USER"
  say "  created $AGENT_USER"
else
  # macOS has no useradd. Pick a free uid below 500 so the account is hidden
  # from the login window, which is what a service account wants.
  UID_NEXT=$(dscl . -list /Users UniqueID | awk '$2 > 200 && $2 < 400 { print $2 }' | sort -n | tail -1)
  UID_NEXT=$((${UID_NEXT:-300} + 1))
  sudo dscl . -create "/Users/$AGENT_USER"
  sudo dscl . -create "/Users/$AGENT_USER" UserShell /usr/bin/false
  sudo dscl . -create "/Users/$AGENT_USER" RealName "OnePersonCompany agent"
  sudo dscl . -create "/Users/$AGENT_USER" UniqueID "$UID_NEXT"
  sudo dscl . -create "/Users/$AGENT_USER" PrimaryGroupID 20
  sudo dscl . -create "/Users/$AGENT_USER" NFSHomeDirectory "$AGENT_HOME"
  say "  created $AGENT_USER with uid $UID_NEXT"
fi

mkdir -p "$AGENT_HOME"
sudo chown -R "$AGENT_USER" "$AGENT_HOME"
say "  $AGENT_HOME now belongs to $AGENT_USER"

for f in "$DATA_DIR/vault.key" "$DATA_DIR/service-key" "$DATA_DIR/opc.db"; do
  [ -e "$f" ] && chmod 0600 "$f" && say "  0600 $f"
done

if [ -e "$AGENT_HOME/service-key.agent" ]; then
  chmod 0600 "$AGENT_HOME/service-key.agent"
  sudo chown "$AGENT_USER" "$AGENT_HOME/service-key.agent"
  say "  the scoped key belongs to $AGENT_USER"
else
  say "  NOTE: $AGENT_HOME/service-key.agent does not exist yet. Start the app"
  say "  once — it is minted at boot — then re-run this with --apply."
fi

for g in $GATEWAYS; do
  [ -e "$g" ] && sudo chmod -R a+rX "$(dirname "$(dirname "$g")")" && say "  made $(dirname "$g") readable"
done

printf '%s\n' "$SUDOERS_LINE" | sudo tee "$SUDOERS_FILE" >/dev/null
sudo chmod 0440 "$SUDOERS_FILE"
say "  wrote $SUDOERS_FILE"

say ""
say "  Done. Now set the agent user in Settings -> Deployment and restart the"
say "  agent. If the gateway will not start, its log is the first place to look:"
say "  a sudo rule that does not match shows up there as sudo's own message."
say ""
