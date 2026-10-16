#!/bin/sh
# Unit tests for the outage state machine and the monthly report.
# Uses python3 only as an independent clock oracle. The report itself is awk.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
ok() {
  echo "ok: $*"
}

# Never call a real webhook from the tests.
export WEBHOOK_URL=PLACEHOLDER_TEST
export WEBHOOK_TOKEN=PLACEHOLDER_TEST
unset FORCE_SMS || true

CURL_CALLED=$(mktemp)
export CURL_CALLED
mkdir -p "$(dirname "$CURL_CALLED")"
fakepath=$(mktemp -d)
cat > "$fakepath/curl" << EOF
#!/bin/sh
echo called >> "$CURL_CALLED"
exit 99
EOF
chmod +x "$fakepath/curl"
export PATH="$fakepath:$PATH"

awk 'BEGIN { print "awk ready" }' >/dev/null || fail "awk missing"
command -v flock >/dev/null || fail "flock missing"
command -v python3 >/dev/null || fail "python3 missing"

echo "calendar sweep ($(command -v awk))"
python3 - "$ROOT/time.awk" << 'PY'
import subprocess, sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

awk_file = sys.argv[1]
ct = ZoneInfo("America/Chicago")

def run_sweep(start, end, step):
    out = subprocess.check_output(
        ["awk", "-v", f"sweep_start={start}", "-v", f"sweep_end={end}",
         "-v", f"sweep_step={step}", "-f", awk_file],
        text=True,
    )
    mismatches = []
    for line in out.splitlines():
        epoch_s, utc, local = line.split()
        epoch = int(epoch_s)
        got_utc = datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        got_ct = datetime.fromtimestamp(epoch, ct).isoformat()
        if utc != got_utc or local != got_ct:
            mismatches.append((epoch, utc, got_utc, local, got_ct))
            if len(mismatches) >= 5:
                break
    return mismatches

ranges = [(1767225600, 1798761600, 3600)]  # 2026-01-01 .. 2027-01-01 UTC, hourly
# Second-level around the 2026 DST edges (08:00Z Mar 8 and 07:00Z Nov 1).
ranges.append((1772956800 - 7200, 1772956800 + 7200, 1))
ranges.append((1793516400 - 7200, 1793516400 + 7200, 1))
bad = []
for start, end, step in ranges:
    bad.extend(run_sweep(start, end, step))
if bad:
    for row in bad:
        print("mismatch", row)
    sys.exit(1)
print(f"calendar matched zoneinfo ({sum((e-s)//st + 1 for s,e,st in ranges)} instants)")
PY
ok "America/Chicago conversion"

newdir() {
  mktemp -d
}

rows() {
  awk 'NR > 1 && $0 != "" { c++ } END { print c + 0 }' "$1/outages.csv"
}

phase_of() {
  if [ ! -f "$1/state" ]; then
    echo ok
    return
  fi
  awk -F= '$1 == "phase" { print $2 }' "$1/state"
}

since_of() {
  awk -F= '$1 == "since" { print $2 }' "$1/state"
}

type_of() {
  awk -F= '$1 == "type" { print $2 }' "$1/state"
}

echo "probe state machine"
D=$(newdir)
DATA_DIR=$D "$ROOT/probe.sh" step 1000 ok "up"
[ "$(phase_of "$D")" = "ok" ] || fail "initial phase"
[ "$(rows "$D")" -eq 0 ] || fail "initial csv"

DATA_DIR=$D "$ROOT/probe.sh" step 1000 internet "gw=up;ext=down:1.1.1.1:443"
[ "$(phase_of "$D")" = "pending" ] || fail "expected pending"
[ "$(since_of "$D")" = "1000" ] || fail "pending since"
[ "$(rows "$D")" -eq 0 ] || fail "pending wrote csv"

DATA_DIR=$D "$ROOT/probe.sh" step 1059 internet "gw=up;ext=down:1.1.1.1:443"
[ "$(phase_of "$D")" = "pending" ] || fail "59s should stay pending"
[ "$(rows "$D")" -eq 0 ] || fail "59s wrote csv"

DATA_DIR=$D "$ROOT/probe.sh" step 1060 internet "gw=up;ext=down:1.1.1.1:443"
[ "$(phase_of "$D")" = "open" ] || fail "60s should confirm"
[ "$(since_of "$D")" = "1000" ] || fail "open since drifted"
[ "$(rows "$D")" -eq 0 ] || fail "confirm wrote csv"
cp "$D/state" "$D/state.open"

DATA_DIR=$D "$ROOT/probe.sh" step 1300 internet "gw=up;ext=down:1.1.1.1:443"
[ "$(phase_of "$D")" = "open" ] || fail "still open"
[ "$(since_of "$D")" = "1000" ] || fail "restarted outage"
[ "$(rows "$D")" -eq 0 ] || fail "still-open wrote csv"

DATA_DIR=$D "$ROOT/probe.sh" step 1600 ok "recovered"
[ "$(phase_of "$D")" = "ok" ] || fail "did not close"
[ "$(rows "$D")" -eq 1 ] || fail "expected one csv row"
awk -F, 'NR==2 {
  if ($1 != 1000 || $4 != 1600 || $7 != 600 || $8 != "internet") exit 1
}' "$D/outages.csv" || fail "csv columns"

# Crash after the CSV append and before state was cleared.
cp "$D/state.open" "$D/state"
DATA_DIR=$D "$ROOT/probe.sh" step 1700 ok "recovered again"
[ "$(rows "$D")" -eq 1 ] || fail "double-counted outage"
[ "$(phase_of "$D")" = "ok" ] || fail "state not cleared after reconcile"
ok "sustain, continue, close, no double-count"

D=$(newdir)
DATA_DIR=$D "$ROOT/probe.sh" step 2000 lan "gw=down"
DATA_DIR=$D "$ROOT/probe.sh" step 2059 ok "up"
[ "$(rows "$D")" -eq 0 ] || fail "short lan outage was recorded"
[ "$(phase_of "$D")" = "ok" ] || fail "short lan left state"
ok "sub-60s blip ignored"

D=$(newdir)
DATA_DIR=$D "$ROOT/probe.sh" step 3000 internet "ext"
DATA_DIR=$D "$ROOT/probe.sh" step 3060 internet "ext"
DATA_DIR=$D "$ROOT/probe.sh" step 3200 lan "gw=down"
[ "$(phase_of "$D")" = "pending" ] || fail "type change should pend lan"
[ "$(type_of "$D")" = "lan" ] || fail "pending type"
[ "$(since_of "$D")" = "3200" ] || fail "lan since"
awk -F, 'NR==2 {
  if ($1 != 3000 || $4 != 3200 || $7 != 200 || $8 != "internet") exit 1
}' "$D/outages.csv" || fail "internet close on type change"
DATA_DIR=$D "$ROOT/probe.sh" step 3260 lan "gw=down"
[ "$(phase_of "$D")" = "open" ] || fail "lan not confirmed"
DATA_DIR=$D "$ROOT/probe.sh" step 3400 ok "up"
[ "$(rows "$D")" -eq 2 ] || fail "expected internet and lan rows"
awk -F, 'NR==3 { if ($8 != "lan" || $7 != 200 || $1 != 3200) exit 1 }' "$D/outages.csv" || fail "lan row"
ok "internet to lan records both"

D=$(newdir)
DATA_DIR=$D "$ROOT/probe.sh" step 1768500000 internet "gw=up;ext=down:1.1.1.1:443"
DATA_DIR=$D "$ROOT/probe.sh" step 1768500060 internet "gw=up;ext=down:1.1.1.1:443"
DATA_DIR=$D "$ROOT/probe.sh" step 1768505400 ok "up"
grep -q '1768500000,2026-01-15T18:00:00Z,2026-01-15T12:00:00-06:00,1768505400,' "$D/outages.csv" \
  || fail "csv timestamps: $(cat "$D/outages.csv")"
ok "csv uses UTC and America/Chicago"

echo "classify"
ncdir=$(mktemp -d)
NC_LOG=$(mktemp)
export NC_LOG
cat > "$ncdir/nc" << 'EOF'
#!/bin/sh
has_n=0
prev=
last=
for a in "$@"; do
  if [ "$a" = "-n" ]; then
    has_n=1
  fi
  prev=$last
  last=$a
done
printf '%s %s %s\n' "$has_n" "$prev" "$last" >> "$NC_LOG"
case $prev in
  192.168.68.1)
    if [ "$last" = "9" ]; then
      exit 1
    fi
    exit 0
    ;;
  1.1.1.1)
    if [ "${NC_CLOUDFLARE_UP:-}" = "1" ]; then
      exit 0
    fi
    exit 1
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$ncdir/nc"

D=$(newdir)
: > "$NC_LOG"
NOW=5000 DATA_DIR=$D GATEWAY_HOST=192.168.68.1 GATEWAY_PORTS=443,80 \
  EXTERNAL_PROBES=1.1.1.1:443,8.8.8.8:443,one.one.one.one:443 \
  PATH="$ncdir:$PATH" "$ROOT/probe.sh" once
[ "$(phase_of "$D")" = "pending" ] || fail "all-external-down should pend internet, got $(phase_of "$D")"
[ "$(type_of "$D")" = "internet" ] || fail "expected internet ($(type_of "$D"))"
grep -q 'ext=down:' "$D/state" || fail "missing external detail"
# IP probes pass -n. The hostname does not.
awk '$2 == "1.1.1.1" && $1 != 1 { exit 1 }' "$NC_LOG" || fail "ip probe was not numeric"
awk '$2 == "one.one.one.one" && $1 != 0 { exit 1 }' "$NC_LOG" || fail "hostname probe used -n"
ok "gateway up and all external down is internet"

D=$(newdir)
: > "$NC_LOG"
NOW=5000 NC_CLOUDFLARE_UP=1 DATA_DIR=$D PATH="$ncdir:$PATH" "$ROOT/probe.sh" once
[ "$(phase_of "$D")" = "ok" ] || fail "one live external should be ok"
ok "partial external failure is not an outage"

D=$(newdir)
: > "$NC_LOG"
NOW=5000 DATA_DIR=$D GATEWAY_HOST=192.168.68.1 GATEWAY_PORTS=9 \
  NC_CLOUDFLARE_UP=1 PATH="$ncdir:$PATH" "$ROOT/probe.sh" once
[ "$(phase_of "$D")" = "pending" ] || fail "gateway down should pend"
[ "$(type_of "$D")" = "lan" ] || fail "gateway down should be lan ($(type_of "$D"))"
grep -q 'ext_up=' "$D/state" || fail "lan detail should note external that still answered"
ok "gateway down is lan even if an external answers"

echo "reports"
export PRINT_REPORT=0
NOW_SEP=1790831400  # 2026-10-01 00:10 America/Chicago

build_fixture() {
  fix=$1
  python3 - "$fix" << 'PY'
import sys
from datetime import datetime
from zoneinfo import ZoneInfo
ct = ZoneInfo("America/Chicago")

def ep(s):
    return int(datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=ct).timestamp())

rows = [
    (ep("2026-01-15 12:00:00"), ep("2026-01-15 13:30:00"), "internet", "jan-maintenance"),
    (ep("2026-03-02 12:00:00"), ep("2026-03-02 12:10:00"), "internet", "mar-blip"),
    (ep("2026-09-13 01:00:00"), ep("2026-09-13 02:30:00"), "internet", "sep-maintenance"),
    (ep("2026-09-20 10:00:00"), ep("2026-09-20 10:20:00"), "lan", "switch-reboot"),
    (ep("2026-09-30 23:00:00"), ep("2026-10-01 00:05:00"), "internet", "spans-midnight"),
]
path = sys.argv[1]
with open(path, "w", encoding="utf-8") as fh:
    fh.write("start_epoch,start_utc,start_ct,end_epoch,end_utc,end_ct,duration_seconds,type,detail\n")
    for start, end, kind, detail in rows:
        fh.write(f"{start},x,x,{end},x,x,{end-start},{kind},{detail}\n")
PY
}

assert_report() {
  # $1 report file, $2 mode: september | october | partial | open | empty
  python3 - "$1" "$2" << 'PY'
import sys
from datetime import datetime
from zoneinfo import ZoneInfo
ct = ZoneInfo("America/Chicago")
text = open(sys.argv[1], encoding="utf-8").read()
mode = sys.argv[2]

def ep(s):
    return int(datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=ct).timestamp())

def bounds(y, m):
    start = datetime(y, m, 1, tzinfo=ct)
    end = datetime(y + 1, 1, 1, tzinfo=ct) if m == 12 else datetime(y, m + 1, 1, tzinfo=ct)
    return int(start.timestamp()), int(end.timestamp())

def overlap(a0, a1, b0, b1):
    o0, o1 = max(a0, b0), min(a1, b1)
    return max(0, o1 - o0)

def line_value(prefix):
    for line in text.splitlines():
        if line.startswith(prefix):
            return line[len(prefix):].strip()
    raise SystemExit(f"missing line {prefix!r}")

def seconds_of(prefix):
    import re
    raw = line_value(prefix)
    m = re.search(r"\((\d+)s\)", raw)
    if not m:
        raise SystemExit(f"no seconds in {raw}")
    return int(m.group(1))

def expect(prefix, value):
    got = line_value(prefix)
    if str(value) not in got:
        raise SystemExit(f"{prefix} expected {value} in {got}")

outages = [
    (ep("2026-01-15 12:00:00"), ep("2026-01-15 13:30:00"), "internet"),
    (ep("2026-03-02 12:00:00"), ep("2026-03-02 12:10:00"), "internet"),
    (ep("2026-09-13 01:00:00"), ep("2026-09-13 02:30:00"), "internet"),
    (ep("2026-09-20 10:00:00"), ep("2026-09-20 10:20:00"), "lan"),
    (ep("2026-09-30 23:00:00"), ep("2026-10-01 00:05:00"), "internet"),
]

if mode == "september":
    now = ep("2026-10-01 00:10:00")
    coverage = ep("2026-01-01 00:00:00")
    month = (2026, 9)
    expect_down = 9000
    expect_count = 2
    expect_long = 5400
    expect_ytd_down = 15000
    expect_ytd_count = 4
elif mode == "october":
    now = ep("2026-10-01 00:10:00")
    coverage = ep("2026-01-01 00:00:00")
    month = (2026, 10)
    expect_down = 300
    expect_count = 1
    expect_long = 300
    expect_ytd_down = 15300
    expect_ytd_count = 4
elif mode == "partial":
    now = ep("2026-10-01 00:10:00")
    coverage = ep("2026-03-15 00:00:00")
    month = (2026, 9)
    expect_down = 9000
    expect_count = 2
    expect_long = 5400
    expect_ytd_down = 9000
    expect_ytd_count = 2
elif mode == "open":
    now = ep("2026-10-01 00:10:00")
    coverage = ep("2026-01-01 00:00:00")
    month = (2026, 9)
    outages = [(ep("2026-09-29 18:00:00"), now, "internet")]
    expect_down = 108000
    expect_count = 1
    expect_long = 108000
    expect_ytd_down = 108000
    expect_ytd_count = 1
elif mode == "empty":
    if "This month was not monitored." not in text:
        raise SystemExit("empty log should not claim the month was monitored")
    if "100.00%" in text:
        raise SystemExit("empty log claimed 100% availability")
    print("empty report ok")
    sys.exit(0)
else:
    raise SystemExit(mode)

def stats(y, m, kind):
    p0, p1 = bounds(y, m)
    c0, c1 = max(p0, coverage), min(p1, now)
    if c1 <= c0:
        return None
    segs = []
    for a0, a1, t in outages:
        if t != kind:
            continue
        seg = overlap(a0, a1, c0, c1)
        if seg:
            segs.append(seg)
    return {
        "monitored": c1 - c0,
        "count": len(segs),
        "down": sum(segs),
        "longest": max(segs) if segs else 0,
        "avg": (sum(segs) // len(segs)) if segs else 0,
        "partial": coverage > p0 or (p0 < now < p1),
    }

y, m = month
got = stats(y, m, "internet")
if got["down"] != expect_down or got["count"] != expect_count or got["longest"] != expect_long:
    raise SystemExit(f"oracle sanity {got} expected down {expect_down}")
if seconds_of("- Internet downtime: ") != got["down"]:
    raise SystemExit("downtime mismatch")
if line_value("- Internet outages: ") != str(got["count"]):
    raise SystemExit("count mismatch")
if seconds_of("- Internet longest: ") != got["longest"]:
    raise SystemExit("longest mismatch")
if seconds_of("- Internet average: ") != got["avg"]:
    raise SystemExit("average mismatch")
if line_value("- Monitored seconds: ") != str(got["monitored"]):
    raise SystemExit(f"monitored {line_value('- Monitored seconds: ')} != {got['monitored']}")
pct = 100 * (got["monitored"] - got["down"]) / got["monitored"]
avail = f"{pct:.2f}%"
got_avail = line_value("- Internet availability: ")
if not got_avail.startswith(avail):
    raise SystemExit(f"availability {got_avail} != {avail}")
if got["partial"] and "(partial)" not in got_avail:
    raise SystemExit("expected partial marker")
if not got["partial"] and "(partial)" in got_avail:
    raise SystemExit("unexpected partial marker")

# Year to date through this month.
ytd_down = ytd_count = ytd_long = ytd_mon = 0
seen = []
y0, _ = bounds(y, 1)
_, y1 = bounds(y, m)
c0, c1 = max(y0, coverage), min(y1, now)
for a0, a1, t in outages:
    if t != "internet":
        continue
    seg = overlap(a0, a1, c0, c1)
    if seg:
        ytd_count += 1
        ytd_down += seg
        ytd_long = max(ytd_long, seg)
ytd_mon = c1 - c0
if ytd_down != expect_ytd_down or ytd_count != expect_ytd_count:
    raise SystemExit(f"ytd oracle {ytd_down} {ytd_count}")
if seconds_of("- YTD downtime: ") != ytd_down:
    raise SystemExit("ytd downtime mismatch")
if line_value("- YTD outages: ") != str(ytd_count):
    raise SystemExit("ytd count mismatch")
if line_value("- YTD monitored seconds: ") != str(ytd_mon):
    raise SystemExit("ytd monitored mismatch")

if mode == "september":
    if "continues outside this month" not in text:
        raise SystemExit("spanning outage was not marked")
    if "switch-reboot" not in text:
        raise SystemExit("lan outage missing from the report")
    if "LAN outages: 1" not in text:
        raise SystemExit("lan count")
    # January is a monitored month in the table. February is clean.
    if "| 2026-01 | 1 |" not in text or "| 2026-02 | 0 |" not in text:
        raise SystemExit("ytd table months")
if mode == "partial":
    if "| 2026-01 | n/a | n/a | n/a | not monitored |" not in text:
        raise SystemExit("january should be not monitored")
    if "| 2026-02 | n/a | n/a | n/a | not monitored |" not in text:
        raise SystemExit("february should be not monitored")
if mode == "open":
    if "(open)" not in text:
        raise SystemExit("open outage not marked")
    if "(108000s)" not in text or "(108600s)" not in text:
        raise SystemExit("open outage durations")
if mode == "october":
    if "(partial)" not in line_value("- Internet availability: "):
        raise SystemExit("mid-month october should be partial")
print(f"{mode} report matched oracle down={got['down']}s avail={got_avail}")
PY
}

D=$(newdir)
build_fixture "$D/outages.csv"
printf '%s\n' 1767225600 > "$D/coverage_start"  # will be replaced
python3 - << 'PY' > "$D/coverage_start"
from datetime import datetime
from zoneinfo import ZoneInfo
ct = ZoneInfo("America/Chicago")
print(int(datetime(2026, 1, 1, tzinfo=ct).timestamp()))
PY
NOW=$NOW_SEP DATA_DIR=$D REPORT_MONTH=2026-09 "$ROOT/report.sh" >/tmp/netwatch-september.out
assert_report "$D/reports/2026-09.md" september
sms=$(cat "$D/reports/2026-09.sms")
printf '%s\n' "$sms"
case $sms in
  "[Skynet] Sep 2026 internet: 2 outages, down 2h30m, longest 1h30m, avg 1h15m, avail 99.65%."*) ;;
  *) fail "sms headline: $sms" ;;
esac
case $sms in
  *"YTD: 4 outages, down 4h10m, avail "*) ;;
  *) fail "sms ytd: $sms" ;;
esac
case $sms in
  *"LAN (not ISP): 1, 20m."*) ;;
  *) fail "sms lan: $sms" ;;
esac
case $sms in
  *"Top: 09-13 01:00 1h30m; 09-30 23:00 1h (full 1h5m)."*) ;;
  *) fail "sms top: $sms" ;;
esac
[ "$(printf '%s' "$sms" | wc -c)" -le 320 ] || fail "sms longer than 320"
[ ! -s "$CURL_CALLED" ] || fail "curl was invoked"
ok "september report and sms"

NOW=$NOW_SEP DATA_DIR=$D REPORT_MONTH=2026-10 "$ROOT/report.sh" >/dev/null
assert_report "$D/reports/2026-10.md" october
ok "october partial includes the 5 minute spill"

D=$(newdir)
build_fixture "$D/outages.csv"
python3 - << 'PY' > "$D/coverage_start"
from datetime import datetime
from zoneinfo import ZoneInfo
ct = ZoneInfo("America/Chicago")
print(int(datetime(2026, 3, 15, tzinfo=ct).timestamp()))
PY
NOW=$NOW_SEP DATA_DIR=$D REPORT_MONTH=2026-09 "$ROOT/report.sh" >/dev/null
assert_report "$D/reports/2026-09.md" partial
ok "coverage starting mid-March"

D=$(newdir)
python3 - << 'PY' > "$D/coverage_start"
from datetime import datetime
from zoneinfo import ZoneInfo
ct = ZoneInfo("America/Chicago")
print(int(datetime(2026, 1, 1, tzinfo=ct).timestamp()))
PY
python3 - << 'PY' > "$D/state"
from datetime import datetime
from zoneinfo import ZoneInfo
ct = ZoneInfo("America/Chicago")
since = int(datetime(2026, 9, 29, 18, 0, tzinfo=ct).timestamp())
print(f"phase=open\ntype=internet\nsince={since}\ndetail=still-down")
PY
NOW=$NOW_SEP DATA_DIR=$D REPORT_MONTH=2026-09 "$ROOT/report.sh" >/dev/null
assert_report "$D/reports/2026-09.md" open
ok "open outage clipped at the month boundary"

D=$(newdir)
NOW=$NOW_SEP DATA_DIR=$D REPORT_MONTH=2026-09 "$ROOT/report.sh" >/dev/null
assert_report "$D/reports/2026-09.md" empty
sms=$(cat "$D/reports/2026-09.sms")
[ "$sms" = "[Skynet] Sep 2026 internet: not monitored. YTD: not monitored." ] || fail "empty sms: $sms"
ok "first run with no log"

D=$(newdir)
printf '%s\n' 'start_epoch,start_utc,start_ct,end_epoch,end_utc,end_ct,duration_seconds,type,detail' > "$D/outages.csv"
python3 - << 'PY' > "$D/coverage_start"
from datetime import datetime
from zoneinfo import ZoneInfo
ct = ZoneInfo("America/Chicago")
print(int(datetime(2026, 1, 1, tzinfo=ct).timestamp()))
PY
env -u REPORT_MONTH NOW=$NOW_SEP DATA_DIR=$D "$ROOT/report.sh" >/dev/null
[ -f "$D/reports/2026-09.md" ] || fail "auto month did not write September"
ok "00:10 on the 1st reports the month that just ended"

jan1=$(python3 - << 'PY'
from datetime import datetime
from zoneinfo import ZoneInfo
ct = ZoneInfo("America/Chicago")
print(int(datetime(2027, 1, 1, 0, 10, tzinfo=ct).timestamp()))
PY
)
D=$(newdir)
printf '%s\n' 'start_epoch,start_utc,start_ct,end_epoch,end_utc,end_ct,duration_seconds,type,detail' > "$D/outages.csv"
printf '%s\n' 1767225600 > "$D/coverage_start"
env -u REPORT_MONTH NOW="$jan1" DATA_DIR=$D "$ROOT/report.sh" >/dev/null
[ -f "$D/reports/2026-12.md" ] || fail "January 1 should report December"
ok "new year reports the previous December"

# Sample used in the pull request.
D=$(newdir)
build_fixture "$D/outages.csv"
python3 - << 'PY' > "$D/coverage_start"
from datetime import datetime
from zoneinfo import ZoneInfo
ct = ZoneInfo("America/Chicago")
print(int(datetime(2026, 1, 1, tzinfo=ct).timestamp()))
PY
NOW=$NOW_SEP DATA_DIR=$D REPORT_MONTH=2026-09 "$ROOT/report.sh" >/dev/null
cp "$D/reports/2026-09.md" /tmp/netwatch-sample.md
cp "$D/reports/2026-09.sms" /tmp/netwatch-sample.sms

echo "ALL TESTS PASSED ($(command -v awk))"

if [ -n "${NETWATCH_BUSYBOX:-}" ] && [ -z "${NETWATCH_REEXEC:-}" ]; then
  wrap=$(mktemp -d)
  cat > "$wrap/awk" << EOF
#!/bin/sh
exec ${NETWATCH_LOADER:?} --library-path ${NETWATCH_LIB:?}:${NETWATCH_LIB:?}/../usr/lib ${NETWATCH_BUSYBOX:?} awk "\$@"
EOF
  chmod +x "$wrap/awk"
  echo "=== re-running under busybox ==="
  NETWATCH_REEXEC=1 PATH="$wrap:$PATH" \
    "${NETWATCH_LOADER}" --library-path "${NETWATCH_LIB}:${NETWATCH_LIB}/../usr/lib" \
    "${NETWATCH_BUSYBOX}" sh "$0"
fi
