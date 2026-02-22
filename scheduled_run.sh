#!/bin/zsh
# Cron: 0 9 * * 1-5 /Users/rafjaf/gcf/Vault/Computer/Programmation/Mes\ programmes/nodejs/juportal_crawler/scheduled_run.sh >> /Users/rafjaf/gcf/Vault/Computer/Programmation/Mes\ programmes/nodejs/juportal_crawler/scheduled_run.log 2>&1

export HOME="/Users/rafjaf"
export NTFY_TOPIC="MBPS"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="/Users/rafjaf/gcf/Vault/Computer/Programmation/Mes programmes/nodejs/juportal_crawler"
cd "$SCRIPT_DIR" || {
  ntfy pub --title "Juportal Crawler" --tags "x,warning" --priority high "Failed to cd into script directory"
  exit 1
}

OUTPUT=$(node index.js 2>&1)
EXIT_CODE=$?

# Extract the SUMMARY line, stripping any ANSI colour codes
SUMMARY=$(printf '%s' "$OUTPUT" | grep 'SUMMARY:' | tail -1 \
  | sed 's/.*SUMMARY: //' \
  | sed $'s/\x1b\\[[0-9;]*m//g')

if [ $EXIT_CODE -ne 0 ]; then
  ntfy pub --title "Juportal Crawler" --tags "x,rotating_light" --priority high "Crawler failed (exit $EXIT_CODE)"
elif [ -z "$SUMMARY" ]; then
  ntfy pub --title "Juportal Crawler" --tags "warning" "Run completed (no summary found)"
elif [ "$SUMMARY" = "Nothing new found." ]; then
  ntfy pub --title "Juportal Crawler" --tags "white_check_mark" "$SUMMARY"
else
  # New data was found — commit and push
  git add -A
  if git commit -m "crawler: $SUMMARY"; then
    if git push; then
      ntfy pub --title "Juportal Crawler" --tags "tada" "$SUMMARY"
    else
      ntfy pub --title "Juportal Crawler" --tags "x,warning" --priority high "Git push failed — $SUMMARY"
    fi
  else
    ntfy pub --title "Juportal Crawler" --tags "warning" "Git commit failed — $SUMMARY"
  fi
fi