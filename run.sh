#!/bin/sh
# Launcher: load allowlisted TROLLEY_* settings from ~/.zshrc (only if they're not already set), find Node >= 22.5, start the server.
# Only `export TROLLEY_<NAME>=value` lines matching the allowlist are read. Nothing else in ~/.zshrc gets executed.
ALLOW='TROLLEY_(ACCESS_KEY|SECRET_KEY|ENVIRONMENT|KNOWN_KEYS|RATE_LIMIT|RATE_LIMIT_PER_MIN|CONCURRENCY|CACHE_DIR|REQUEST_TIMEOUT_MS|PAGE_SIZE|RECIPIENT_CACHE|PAYMENT_CACHE|SYNC_ENABLED|CONFIG_FILE|TIMEZONE|PAYDAY_DAY|BATCH_CREATE_DAY|BATCH_GROUPS|PAYDAY_MONITOR|NOTIFY_EMAIL|FAIL_RATE_WARN|FAIL_RATE_HIGH|FAIL_MIN_COUNT|FAIL_SMALL_BATCH_COUNT|FAIL_SMALL_BATCH_SIZE)'
if [ -f "$HOME/.zshrc" ]; then
  grep -E "^[[:space:]]*export[[:space:]]+${ALLOW}=" "$HOME/.zshrc" | sed -E 's/^[[:space:]]*export[[:space:]]+//' > "${TMPDIR:-/tmp}/.trolley-env.$$" 2>/dev/null
  while IFS= read -r line; do
    name=${line%%=*}; val=${line#*=}
    case "$val" in \"*\") val=${val#\"}; val=${val%\"};; \'*\') val=${val#\'}; val=${val%\'};; esac
    eval "cur=\${$name:-}"
    [ -z "$cur" ] && export "$name=$val"
  done < "${TMPDIR:-/tmp}/.trolley-env.$$"
  rm -f "${TMPDIR:-/tmp}/.trolley-env.$$"
fi
cd "$(dirname "$0")"
ok() { "$1" -e 'const[a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' 2>/dev/null; }
NODE=node
if ! ok "$NODE"; then
  for c in $(ls -d "$HOME"/.asdf/installs/nodejs/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -rV); do ok "$c" && NODE=$c && break; done
fi

[ "$1" = "init" ] && { shift; exec "$NODE" server/init.mjs "$@"; }
[ "$1" = "monitor" ] && { shift; exec "$NODE" server/monitor-cli.mjs "$@"; }
[ "$1" = "sync" ] && { shift; exec "$NODE" server/job.mjs "$@"; }
if [ "$1" = "schedule" ]; then
  PLUGIN=$(pwd); L1=com.trolley-plugin.payment-sync; L2=com.trolley-plugin.recipient-sync; MODE=daemon; [ "$3" = "--agent" ] && MODE=agent
  LD=/Library/LaunchDaemons; LA="$HOME/Library/LaunchAgents"; SUDO="sudo sh '$PLUGIN/run.sh' schedule"
  if [ "$3" = "--monitor" ] || [ "$2" = "status" ]; then LM=com.trolley-plugin.payday-monitor
    case "$2" in
      install) "$NODE" server/schedule.mjs >/dev/null && mkdir -p "$LA" && plutil -lint "launchd/agent/$LM.plist" >/dev/null || exit 1
        launchctl bootout "gui/$(id -u)/$LM" 2>/dev/null; cp "launchd/agent/$LM.plist" "$LA/" && launchctl bootstrap "gui/$(id -u)" "$LA/$LM.plist" && echo "Payday monitor LaunchAgent installed (runs only while you're logged in)."; exit $? ;;
      uninstall) launchctl bootout "gui/$(id -u)/$LM" 2>/dev/null; rm -f "$LA/$LM.plist"; echo "Payday monitor removed."; exit 0 ;;
      status) if [ -f "$LA/$LM.plist" ]; then printf '%s: LaunchAgent installed' $LM; launchctl print "gui/$(id -u)/$LM" >/dev/null 2>&1 && echo ", loaded" || echo ", not loaded"; else echo "$LM: not installed"; fi
        f="$HOME/Library/Logs/trolley-plugin/payday-monitor.log"; [ -f "$f" ] && tail -n 1 "$f"; [ "$3" = "--monitor" ] && exit 0 ;;
    esac
  fi
  case "$2" in
    stage) "$NODE" server/schedule.mjs && for f in launchd/*/*.plist; do plutil -lint "$f" || exit 1; done ;;
    install)
      if [ "$MODE" = agent ]; then
        "$NODE" server/schedule.mjs >/dev/null && mkdir -p "$LA" || exit 1
        for l in $L1 $L2; do plutil -lint "launchd/agent/$l.plist" >/dev/null || exit 1; launchctl bootout "gui/$(id -u)/$l" 2>/dev/null; cp "launchd/agent/$l.plist" "$LA/"; launchctl bootstrap "gui/$(id -u)" "$LA/$l.plist" || exit 1; done
        echo "LaunchAgents installed (run only while you're logged in)."
      elif [ "$(id -u)" != 0 ]; then
        "$NODE" server/schedule.mjs >/dev/null || exit 1; for l in $L1 $L2; do plutil -lint "launchd/daemon/$l.plist" >/dev/null || exit 1; done
        echo "Staged and validated. Run once: $SUDO install"
      else
        for l in $L1 $L2; do f="launchd/daemon/$l.plist"; [ -f "$f" ] || { echo "Not staged: run 'sh run.sh schedule install' as yourself first." >&2; exit 1; }
          plutil -lint "$f" >/dev/null || exit 1; launchctl bootout "system/$l" 2>/dev/null; cp "$f" "$LD/$l.plist"; chown root:wheel "$LD/$l.plist"; chmod 644 "$LD/$l.plist"; launchctl bootstrap system "$LD/$l.plist" || exit 1; done
        echo "LaunchDaemons installed: $L1 $L2"
      fi ;;
    uninstall)
      if [ "$MODE" = agent ]; then for l in $L1 $L2; do launchctl bootout "gui/$(id -u)/$l" 2>/dev/null; rm -f "$LA/$l.plist"; done; echo "LaunchAgents removed."
      elif [ "$(id -u)" != 0 ]; then echo "Needs root: $SUDO uninstall"
      else for l in $L1 $L2; do launchctl bootout "system/$l" 2>/dev/null; rm -f "$LD/$l.plist"; done; echo "LaunchDaemons removed."; fi ;;
    status)
      for l in $L1 $L2; do
        if [ -f "$LD/$l.plist" ]; then printf '%s: LaunchDaemon installed' "$l"; launchctl print "system/$l" >/dev/null 2>&1 && echo ", loaded" || echo ", not loaded"
        elif [ -f "$LA/$l.plist" ]; then printf '%s: LaunchAgent installed' "$l"; launchctl print "gui/$(id -u)/$l" >/dev/null 2>&1 && echo ", loaded" || echo ", not loaded"
        else echo "$l: not installed"; fi
        launchctl print-disabled system 2>/dev/null | grep -q "\"$l\" => disabled\|\"$l\" => true" && echo "  (disabled)"
      done
      for n in payment-sync recipient-sync; do f="$HOME/Library/Logs/trolley-plugin/$n.log"; [ -f "$f" ] && { echo "last $n:"; tail -n 1 "$f"; }; done ;;
    *) echo "usage: sh run.sh schedule stage|install|uninstall|status [--agent|--monitor]" >&2; exit 64 ;;
  esac
  exit $?
fi
[ "$1" = "backfill" ] && { shift; exec "$NODE" server/backfill.mjs "$@"; }
exec "$NODE" server/index.mjs
