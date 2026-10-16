# America/Chicago civil time for the outage log and the monthly report.
# POSIX awk only (mawk and busybox awk): no strftime, no TZ database.
# US DST since 2007: second Sunday in March 02:00 CST (08:00 UTC) through
# the first Sunday in November 02:00 CDT (07:00 UTC).

function days_from_civil(y, m, d,    era, yoe, doy, doe) {
  y -= (m <= 2 ? 1 : 0)
  era = int((y >= 0 ? y : y - 399) / 400)
  yoe = y - era * 400
  doy = int((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

function civil_ymd(days,    z, era, doe, yoe, y, doy, mp, d, m) {
  z = days + 719468
  if (z >= 0)
    era = int(z / 146097)
  else
    era = int((z - 146096) / 146097)
  doe = z - era * 146097
  yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
  y = yoe + era * 400
  doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
  mp = int((5 * doy + 2) / 153)
  d = doy - int((153 * mp + 2) / 5) + 1
  m = mp + (mp < 10 ? 3 : -9)
  if (m <= 2)
    y++
  return sprintf("%04d %02d %02d", y, m, d)
}

function dow_sun0(y, m, d,    days) {
  # 1970-01-01 was Thursday. Sunday = 0.
  days = days_from_civil(y, m, d)
  return (days + 4) % 7
}

function nth_sunday(y, m, n,    dow, day) {
  dow = dow_sun0(y, m, 1)
  if (dow == 0)
    day = 1
  else
    day = 1 + (7 - dow)
  day += (n - 1) * 7
  return day
}

function dst_start_utc(y,    day) {
  day = nth_sunday(y, 3, 2)
  return days_from_civil(y, 3, day) * 86400 + 8 * 3600
}

function dst_end_utc(y,    day) {
  day = nth_sunday(y, 11, 1)
  return days_from_civil(y, 11, day) * 86400 + 7 * 3600
}

function utc_year(epoch,    p) {
  split(civil_ymd(int(epoch / 86400)), p, " ")
  return p[1] + 0
}

function ct_offset_seconds(epoch,    y, start, end) {
  y = utc_year(epoch)
  start = dst_start_utc(y)
  end = dst_end_utc(y)
  if (epoch >= start && epoch < end)
    return -5 * 3600
  return -6 * 3600
}

# Offset of local midnight. The 02:00 transitions never make midnight ambiguous:
# DST starts at 02:00 CST, so midnight on that Sunday is still CST;
# DST ends at 02:00 CDT, so midnight on that Sunday is still CDT.
function ct_midnight_offset(y, m, d,    start_day, end_day) {
  if (m < 3 || m > 11)
    return -6 * 3600
  if (m > 3 && m < 11)
    return -5 * 3600
  start_day = nth_sunday(y, 3, 2)
  end_day = nth_sunday(y, 11, 1)
  if (m == 3) {
    if (d > start_day)
      return -5 * 3600
    return -6 * 3600
  }
  if (d > end_day)
    return -6 * 3600
  return -5 * 3600
}

function ct_month_start(y, m) {
  return days_from_civil(y, m, 1) * 86400 - ct_midnight_offset(y, m, 1)
}

function fmt_clock(epoch,    days, sod, p, h, mi, s) {
  days = int(epoch / 86400)
  sod = epoch - days * 86400
  if (sod < 0) {
    sod += 86400
    days--
  }
  split(civil_ymd(days), p, " ")
  h = int(sod / 3600)
  mi = int((sod - h * 3600) / 60)
  s = sod - h * 3600 - mi * 60
  return sprintf("%04d-%02d-%02dT%02d:%02d:%02d", p[1], p[2], p[3], h, mi, s)
}

function fmt_off(off,    sign, a, h) {
  if (off < 0) {
    sign = "-"
    a = -off
  } else {
    sign = "+"
    a = off
  }
  h = int(a / 3600)
  return sprintf("%s%02d:00", sign, h)
}

function iso_utc(epoch) {
  return fmt_clock(epoch) "Z"
}

function iso_ct(epoch,    off) {
  off = ct_offset_seconds(epoch)
  return fmt_clock(epoch + off) fmt_off(off)
}

BEGIN {
  if (epoch != "") {
    e = epoch + 0
    local = e + ct_offset_seconds(e)
    split(civil_ymd(int(local / 86400)), p, " ")
    printf "%s %s %d %d %d\n", iso_utc(e), iso_ct(e), p[1] + 0, p[2] + 0, p[3] + 0
    exit
  }
  if (bounds != "") {
    split(bounds, a, "-")
    y = a[1] + 0
    m = a[2] + 0
    s = ct_month_start(y, m)
    if (m == 12) {
      y2 = y + 1
      m2 = 1
    } else {
      y2 = y
      m2 = m + 1
    }
    printf "%d %d\n", s, ct_month_start(y2, m2)
    exit
  }
  if (sweep_start != "") {
    step = sweep_step + 0
    if (step <= 0)
      step = 3600
    for (e = sweep_start + 0; e <= sweep_end + 0; e += step)
      printf "%d %s %s\n", e, iso_utc(e), iso_ct(e)
    exit
  }
}
