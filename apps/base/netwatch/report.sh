#!/bin/sh
# Build the monthly outage report from the CSV and the open-outage state file,
# then POST a short plain-text summary to the n8n SMS webhook.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DATA_DIR=${DATA_DIR:-/data}
NOW=${NOW:-$(date +%s)}
CSV=$DATA_DIR/outages.csv
STATE=$DATA_DIR/state
COVERAGE=$DATA_DIR/coverage_start
LOCK=$DATA_DIR/netwatch.lock

mkdir -p "$DATA_DIR/reports" /tmp

if [ -z "${REPORT_MONTH:-}" ] || [ "$REPORT_MONTH" = "auto" ]; then
  line=$(awk -v epoch="$NOW" -f "$SCRIPT_DIR/time.awk")
  # shellcheck disable=SC2086
  set -- $line
  year=$3
  mon=$4
  if [ "$mon" -eq 1 ]; then
    year=$((year - 1))
    mon=12
  else
    mon=$((mon - 1))
  fi
  REPORT_MONTH=$(printf '%04d-%02d' "$year" "$mon")
fi

case $REPORT_MONTH in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]) ;;
  *)
    echo "netwatch: REPORT_MONTH must be YYYY-MM" >&2
    exit 1
    ;;
esac
mon_n=$(printf '%s' "$REPORT_MONTH" | awk -F- '{ print $2 + 0 }')
if [ "$mon_n" -lt 1 ] || [ "$mon_n" -gt 12 ]; then
  echo "netwatch: REPORT_MONTH must be YYYY-MM" >&2
  exit 1
fi

SNAP=/tmp/netwatch-outages.csv
STSNAP=/tmp/netwatch-state
COVSNAP=/tmp/netwatch-coverage
: > "$SNAP"
rm -f "$STSNAP" "$COVSNAP"
touch "$LOCK"
exec 9>>"$LOCK"
flock -x 9
if [ -f "$CSV" ]; then
  cp "$CSV" "$SNAP"
fi
if [ -f "$STATE" ]; then
  cp "$STATE" "$STSNAP"
fi
if [ -f "$COVERAGE" ]; then
  cp "$COVERAGE" "$COVSNAP"
fi
flock -u 9

state_arg=
coverage_arg=
if [ -f "$STSNAP" ]; then
  state_arg=$STSNAP
fi
if [ -f "$COVSNAP" ]; then
  coverage_arg=$COVSNAP
fi

REPORT=$DATA_DIR/reports/${REPORT_MONTH}.md
SMSFILE=$DATA_DIR/reports/${REPORT_MONTH}.sms

awk \
  -v month="$REPORT_MONTH" \
  -v now_epoch="$NOW" \
  -v state_file="$state_arg" \
  -v coverage_file="$coverage_arg" \
  -v report_path="$REPORT" \
  -v sms_path="$SMSFILE" \
  -f "$SCRIPT_DIR/time.awk" \
  -f "$SCRIPT_DIR/report.awk" \
  "$SNAP"

if [ ! -s "$REPORT" ] || [ ! -s "$SMSFILE" ]; then
  echo "netwatch: report was not written" >&2
  exit 1
fi
echo "netwatch: wrote $REPORT" >&2

if [ "${PRINT_REPORT:-}" = "1" ]; then
  cat "$REPORT"
  echo "----- SMS -----"
  cat "$SMSFILE"
fi

send_sms() {
  url=${WEBHOOK_URL:-}
  token=${WEBHOOK_TOKEN:-}
  case $url in
    ""|PLACEHOLDER*)
      echo "netwatch: SMS skipped (webhook URL is unset or still the placeholder). Report: $REPORT" >&2
      return 0
      ;;
  esac
  case $token in
    ""|PLACEHOLDER*)
      echo "netwatch: SMS skipped (webhook token is unset or still the placeholder). Report: $REPORT" >&2
      return 0
      ;;
  esac
  sent=$DATA_DIR/reports/${REPORT_MONTH}.sent
  if [ -f "$sent" ] && [ "${FORCE_SMS:-}" != "1" ]; then
    echo "netwatch: SMS already sent for $REPORT_MONTH. Set FORCE_SMS=1 to send again." >&2
    return 0
  fi
  sms=$(awk 'NR == 1 { printf "%s", $0 }' "$SMSFILE")
  if [ -z "$sms" ]; then
    echo "netwatch: empty SMS text" >&2
    return 1
  fi
  esc=$(printf '%s' "$sms" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); print }')
  payload=$(printf '{"message":"%s"}' "$esc")
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    --max-time 20 \
    -X POST "$url" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    --data "$payload" 2>/dev/null || true)
  case $code in
    2??)
      printf '%s %s\n' "$(date +%s)" "$code" > "$sent"
      sync
      echo "netwatch: SMS sent (HTTP $code)" >&2
      ;;
    *)
      echo "netwatch: SMS failed (HTTP ${code:-none})" >&2
      return 1
      ;;
  esac
}

send_sms
