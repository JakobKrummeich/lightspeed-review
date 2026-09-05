#!/usr/bin/env sh
# Installs this clone as the global `lightspeed` command, and — when told which
# agent you use — writes that agent's skill where it will actually read it.
#
# It exists so the install is one thing to remember instead of three, and so a
# reinstall after `git pull` is the same command as the first install.
#
# The agent is never guessed. Every agent reads a different file, so installing
# for the wrong one writes a document nothing loads and looks like it worked;
# with no `--agent` this installs the binary and prints the line to run next.
#
#   ./install.sh --agent pi          binary, plus pi's skill
#   LIGHTSPEED_AGENT=pi ./install.sh same, without an interactive command line
#   ./install.sh                     binary only
#
# `npm install -g .` does not copy the clone: it links the global package to this
# directory and runs `prepare` (the bundle build) right here, so the clone's own
# dependencies have to be installed first and the clone has to stay where it is.
# npm's default global prefix is often a root-owned /usr, which is not worth a
# sudo for a personal tool: when it is not writable this installs under ~/.local.
set -eu

agents="pi claude-code codex opencode vscode"
agent="${LIGHTSPEED_AGENT:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --agent)
      shift
      [ $# -gt 0 ] || { echo "error: --agent needs a value ($agents)" >&2; exit 2; }
      agent="$1"
      ;;
    --agent=*) agent="${1#--agent=}" ;;
    -h | --help)
      echo "usage: ./install.sh [--agent <$(echo "$agents" | tr ' ' '|')>]"
      exit 0
      ;;
    *)
      echo "error: unknown argument $1" >&2
      echo "usage: ./install.sh [--agent <$(echo "$agents" | tr ' ' '|')>]" >&2
      exit 2
      ;;
  esac
  shift
done

# Checked here rather than left to `lightspeed init`, so a typo'd id fails before
# a five-second install instead of after it.
if [ -n "$agent" ]; then
  case " $agents " in
    *" $agent "*) ;;
    *)
      echo "error: \`$agent\` is not a supported agent" >&2
      echo "supported: $(echo "$agents" | tr ' ' ',' | sed 's/,/, /g')" >&2
      exit 2
      ;;
  esac
fi

# Runs a step with its output held back, and prints all of it only when the step
# fails. A quiet flag would do the first half, but every one of these tools is
# quiet about its errors too, and an install that stops with no reason given is
# the failure mode this script exists to prevent.
quietly() {
  log=$(mktemp)
  "$@" >"$log" 2>&1 && status=0 || status=$?
  [ "$status" -eq 0 ] || cat "$log" >&2
  rm -f "$log"
  return "$status"
}

# The build that `prepare` runs needs the dev dependencies, and a fresh clone has
# none: without this step the install dies inside npm with a module-not-found
# for esbuild. pnpm owns the lockfile, so it is used when present; npm is the
# fallback for a machine that only wants the tool, and it must not leave a second
# lockfile behind in a repository that has committed to one. A node_modules that
# npm built earlier is replaced without the question pnpm would otherwise ask —
# and, off a terminal, silently answer with a failure.
install_dependencies() {
  if command -v pnpm >/dev/null 2>&1; then
    quietly pnpm install --frozen-lockfile --config.confirm-modules-purge=false
  else
    quietly npm install --no-package-lock --no-audit --no-fund
  fi
}

# The package was called `lightspeed` until npm turned out to have that name
# taken; it is `lightspeed-review` now and still owns the `lightspeed` binary.
# npm refuses to overwrite a binary another package owns, so upgrading over an
# install from before the rename fails with EEXIST. Only that failure earns the
# retry: any other one is printed as npm wrote it, because a swallowed build
# error looks exactly like a network hiccup and costs an hour to tell apart.
# (`--silent` would swallow the EEXIST line too; errors are kept, chatter is not.)
install_globally() {
  log=$(mktemp)
  if npm install -g . "$@" --loglevel=error >"$log" 2>&1; then
    rm -f "$log"
    return 0
  fi
  if ! grep -q EEXIST "$log"; then
    cat "$log" >&2
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
  echo "removing the previous install under the old package name"
  npm rm -g lightspeed "$@" --loglevel=error >/dev/null 2>&1 || true
  npm install -g . "$@" --loglevel=error
}

cd "$(dirname "$0")"
echo "installing lightspeed $(node -p "require('./package.json').version") from $(pwd)"
install_dependencies

prefix=$(npm prefix -g)
if [ -w "$prefix/lib/node_modules" ] || [ -w "$prefix/lib" ]; then
  install_globally
else
  prefix="$HOME/.local"
  echo "$(npm prefix -g) is not writable; installing into $prefix instead"
  install_globally --prefix "$prefix"
fi

# Reported from the prefix that was written, not from PATH: an older install
# under another prefix would otherwise be announced as this one.
lightspeed="$prefix/bin/lightspeed"
echo "installed: $lightspeed"
found="$(command -v lightspeed 2>/dev/null || true)"
if [ -z "$found" ]; then
  echo "warning: $prefix/bin is not on your PATH — add it to your shell profile"
elif [ "$found" != "$lightspeed" ]; then
  echo "warning: \`lightspeed\` on your PATH is $found, which shadows this install"
fi

if [ -n "$agent" ]; then
  # A skill that could not be written is worth a warning and not a failed
  # install: the binary is in place and `lightspeed init` can be re-run alone.
  if "$lightspeed" init --agent "$agent"; then
    echo "next: restart your agent — skills are scanned at startup, so a running session sees nothing"
  else
    echo "warning: the binary installed but \`lightspeed init --agent $agent\` did not" >&2
    echo "next: re-run \`lightspeed init --agent $agent\` to see why, then restart your agent"
  fi
  # The skill is installed by now, so the config is all that is left: `--config`
  # stands alone and does not ask for the agent a second time.
  echo "      and add .lightspeed.conf.json to a repo you review: \`lightspeed init --config\`"
else
  echo "next: lightspeed init --agent pi   (or $(echo "$agents" | cut -d' ' -f2- | tr ' ' ',' | sed 's/,/, /g'))"
  echo "      then restart your agent — skills are scanned at startup"
  echo "      and add .lightspeed.conf.json to a repo you review: \`lightspeed init --config\`"
fi
