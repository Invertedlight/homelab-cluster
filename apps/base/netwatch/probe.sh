#!/bin/sh
# Probe the home gateway and a few external TCP endpoints, and append
# completed outages to $DATA_DIR/outages.csv. An in-progress outage lives in
# $DATA_DIR/state so a restart does not drop it or record it twice.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

DATA_DIR=${DATA_DIR:-/data}
GATEWAY_HOST=${GATEWAY_HOST:-192.168.68.1}
GATEWAY_PORTS=${GATEWAY_PORTS:-443,80}
EXTERNAL_PROBES=${EXTERNAL_PROBES:-1.1.1.1:443,8.8.8.8:443,one.one.one.one:443}
PROBE_INTERVAL_SECONDS=${PROBE_INTERVAL_SECONDS:-30}
SUSTAIN_SECONDS=${SUSTAIN_SECONDS:-60}
CONNECT_TIMEOUT_SECONDS=${CONNECT_TIMEOUT_SECONDS:-3}

STATE=$DATA_DIR/state
CSV=$DATA_DIR/outages.csv
COVERAGE=$DATA_DIR/coverage_start
HEARTBEAT=$DATA_DIR/heartbeat
LOCK=$DATA_DIR/netwatch.lock
CSV_HEADER='start_epoch,start_utc,start_ct,end_epoch,end_utc,end_ct,duration_seconds,type,detail'

phase=ok
type=
since=0
detail=

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

sanitize() {
  # Commas would add CSV columns. Cap the length so one probe line stays small.
  printf '%s' "$1" | awk '
    BEGIN { ORS = "" }
    {
      gsub(/[\n\r",\\]/, ";")
      if (length($0) > 300)
        $0 = substr($0, 1, 300)
      print
    }
  '
}

tcp_open() {
  _host=$1
  _port=$2
  _rc=1
  case $_host in
    *[A-Za-z]*)
      nc -z -w "$CONNECT_TIMEOUT_SECONDS" "$_host" "$_port" >/dev/null 2>&1 && _rc=0 || _rc=$?
      ;;
    *)
      nc -z -w "$CONNECT_TIMEOUT_SECONDS" -n "$_host" "$_port" >/dev/null 2>&1 && _rc=0 || _rc=$?
      ;;
  esac
  if [ "$_rc" -eq 127 ]; then
    echo "netwatch: nc is not available" >&2
    exit 127
  fi
  [ "$_rc" -eq 0 ]
}

init_data() {
  mkdir -p "$DATA_DIR/reports"
  touch "$LOCK"
  exec 9>>"$LOCK"
  flock -x 9
  if [ ! -f "$CSV" ]; then
    printf '%s\n' "$CSV_HEADER" > "$CSV"
    sync
  fi
  if [ "${1:-}" = "coverage" ] && [ ! -s "$COVERAGE" ]; then
    date +%s > "$COVERAGE"
    sync
  fi
  flock -u 9
}

load_state() {
  phase=ok
  type=
  since=0
  detail=
  [ -f "$STATE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    k=${line%%=*}
    v=${line#*=}
    case $k in
      phase) phase=$v ;;
      type) type=$v ;;
      since) since=$v ;;
      detail) detail=$v ;;
    esac
  done < "$STATE"
  case $phase in
    ok|pending|open) ;;
    *) phase=ok ;;
  esac
  case $since in
    ''|*[!0-9]*) since=0 ;;
  esac
  if [ "$phase" != "ok" ] && [ "$since" -le 0 ]; then
    phase=ok
    type=
    detail=
  fi
}

save_state() {
  tmp=$DATA_DIR/state.tmp
  {
    printf 'phase=%s\n' "$phase"
    printf 'type=%s\n' "$type"
    printf 'since=%s\n' "$since"
    printf 'detail=%s\n' "$detail"
  } > "$tmp"
  sync
  mv "$tmp" "$STATE"
  sync
}

csv_has() {
  _s=$1
  _t=$2
  awk -F, -v s="$_s" -v t="$_t" '
    NR > 1 && $1 == s && $8 == t { found = 1 }
    END { exit (found ? 0 : 1) }
  ' "$CSV"
}

fmt_pair() {
  _line=$(awk -v epoch="$1" -f "$SCRIPT_DIR/time.awk")
  _utc=${_line%% *}
  _rest=${_line#* }
  _ct=${_rest%% *}
  printf '%s %s\n' "$_utc" "$_ct"
}

append_outage() {
  _start=$1
  _end=$2
  _otype=$3
  _odetail=$4
  if csv_has "$_start" "$_otype"; then
    return 0
  fi
  _dur=$((_end - _start))
  if [ "$_dur" -lt 0 ]; then
    _dur=0
  fi
  _pair=$(fmt_pair "$_start")
  _utc_s=${_pair%% *}
  _ct_s=${_pair#* }
  _pair=$(fmt_pair "$_end")
  _utc_e=${_pair%% *}
  _ct_e=${_pair#* }
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$_start" "$_utc_s" "$_ct_s" "$_end" "$_utc_e" "$_ct_e" \
    "$_dur" "$_otype" "$_odetail" >> "$CSV"
  sync
}

# If the CSV already contains this open outage, a previous process crashed
# after the append and before clearing state. Drop the state and do not
# append again.
reconcile_committed() {
  if [ "$phase" = "open" ] && csv_has "$since" "$type"; then
    log "open outage already in csv; clearing state since=$since type=$type"
    phase=ok
    type=
    since=0
    detail=
    save_state
  fi
}

apply_transition() {
  flock -x 9
  load_state
  reconcile_committed

  if [ "$phase" = "open" ]; then
    if [ "$COND" = "$type" ]; then
      detail=$DETAIL
      save_state
      flock -u 9
      return 0
    fi
    append_outage "$since" "$NOW" "$type" "$detail"
    log "outage closed type=$type since=$since end=$NOW duration=$((NOW - since))"
    phase=ok
    type=
    since=0
    detail=
    save_state
  fi

  if [ "$COND" = "ok" ]; then
    if [ "$phase" != "ok" ]; then
      phase=ok
      type=
      since=0
      detail=
      save_state
    fi
    flock -u 9
    return 0
  fi

  if [ "$phase" = "pending" ] && [ "$type" = "$COND" ]; then
    detail=$DETAIL
    _elapsed=$((NOW - since))
    if [ "$_elapsed" -ge "$SUSTAIN_SECONDS" ]; then
      phase=open
      save_state
      log "outage confirmed type=$type since=$since elapsed=${_elapsed}s"
    else
      save_state
    fi
    flock -u 9
    return 0
  fi

  phase=pending
  type=$COND
  since=$NOW
  detail=$DETAIL
  save_state
  log "outage pending type=$type since=$since"
  flock -u 9
}

classify() {
  gw_hit=
  ext_total=0
  ext_fail=0
  ext_down=
  ext_up=
  old_ifs=$IFS
  IFS=,
  for port in $GATEWAY_PORTS; do
    [ -n "$port" ] || continue
    if tcp_open "$GATEWAY_HOST" "$port"; then
      gw_hit=$port
      break
    fi
  done
  for spec in $EXTERNAL_PROBES; do
    [ -n "$spec" ] || continue
    host=${spec%:*}
    port=${spec##*:}
    [ -n "$host" ] && [ -n "$port" ] || continue
    ext_total=$((ext_total + 1))
    if tcp_open "$host" "$port"; then
      if [ -n "$ext_up" ]; then
        ext_up="$ext_up;$host:$port"
      else
        ext_up="$host:$port"
      fi
    else
      ext_fail=$((ext_fail + 1))
      if [ -n "$ext_down" ]; then
        ext_down="$ext_down;$host:$port"
      else
        ext_down="$host:$port"
      fi
    fi
  done
  IFS=$old_ifs

  if [ -z "$gw_hit" ]; then
    COND=lan
    DETAIL="gw=down;host=$GATEWAY_HOST;ports=$GATEWAY_PORTS"
    if [ -n "$ext_up" ]; then
      DETAIL="$DETAIL;ext_up=$ext_up"
    fi
  elif [ "$ext_total" -gt 0 ] && [ "$ext_fail" -eq "$ext_total" ]; then
    COND=internet
    DETAIL="gw=up:$GATEWAY_HOST:$gw_hit;ext=down:$ext_down"
  else
    COND=ok
    DETAIL="gw=up:$GATEWAY_HOST:${gw_hit:-none};ext_up=${ext_up:-none}"
  fi
  DETAIL=$(sanitize "$DETAIL")
}

beat() {
  date +%s > "$HEARTBEAT"
  sync
}

usage() {
  echo "usage: probe.sh run | once | step <now> <ok|internet|lan> <detail>" >&2
  exit 1
}

cmd=${1:-run}
case $cmd in
  run)
    init_data coverage
    log "netwatch probe starting gateway=$GATEWAY_HOST ports=$GATEWAY_PORTS external=$EXTERNAL_PROBES sustain=${SUSTAIN_SECONDS}s interval=${PROBE_INTERVAL_SECONDS}s"
    while true; do
      _loop_start=$(date +%s)
      classify
      NOW=$(date +%s)
      apply_transition
      beat
      _elapsed=$(($(date +%s) - _loop_start))
      if [ "$_elapsed" -lt "$PROBE_INTERVAL_SECONDS" ]; then
        sleep $((PROBE_INTERVAL_SECONDS - _elapsed))
      fi
    done
    ;;
  once)
    init_data coverage
    classify
    if [ -z "${NOW:-}" ]; then
      NOW=$(date +%s)
    fi
    apply_transition
    beat
    ;;
  step)
    init_data
    NOW=${2:?now}
    COND=${3:?cond}
    case $COND in
      ok|internet|lan) ;;
      *) usage ;;
    esac
    DETAIL=$(sanitize "${4:-}")
    apply_transition
    ;;
  *)
    usage
    ;;
esac
