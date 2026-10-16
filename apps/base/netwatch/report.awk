# Monthly internet-outage report. Loaded together with time.awk.
# Reads the CSV on stdin/argv. Open outage and coverage come from files.
#
# Internet downtime is the part of each outage that falls inside the period.
# An outage that crosses a month boundary counts in each month, and once in
# the year-to-date totals. LAN rows are listed and are not ISP downtime.

function mon_long(m,    n) {
  split("January,February,March,April,May,June,July,August,September,October,November,December", n, ",")
  return n[m]
}

function mon_short(m,    n) {
  split("Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec", n, ",")
  return n[m]
}

function read_state(file,    line, k, v) {
  st_phase = "ok"
  st_type = ""
  st_since = 0
  st_detail = ""
  if (file == "")
    return
  while ((getline line < file) > 0) {
    k = line
    sub(/=.*/, "", k)
    v = line
    sub(/^[^=]*=/, "", v)
    if (k == "phase")
      st_phase = v
    else if (k == "type")
      st_type = v
    else if (k == "since")
      st_since = v + 0
    else if (k == "detail")
      st_detail = v
  }
  close(file)
}

function read_epoch_file(file,    line, v) {
  v = 0
  if (file == "")
    return 0
  if ((getline line < file) > 0)
    v = line + 0
  close(file)
  return v
}

function add_rec(start, end, type, detail, openflag,    key) {
  start += 0
  end += 0
  openflag += 0
  if (type != "internet" && type != "lan") {
    skipped++
    return
  }
  if (start <= 0 || end <= start) {
    skipped++
    return
  }
  key = start SUBSEP type
  if (seen[key])
    return
  seen[key] = 1
  n++
  R_s[n] = start
  R_e[n] = end
  R_t[n] = type
  R_d[n] = detail
  R_o[n] = openflag
}

function sort_recs(    i, j, ts, te, tt, td, to) {
  for (i = 1; i <= n; i++) {
    for (j = i + 1; j <= n; j++) {
      if (R_s[j] < R_s[i] || (R_s[j] == R_s[i] && R_t[j] < R_t[i])) {
        ts = R_s[i]; R_s[i] = R_s[j]; R_s[j] = ts
        te = R_e[i]; R_e[i] = R_e[j]; R_e[j] = te
        tt = R_t[i]; R_t[i] = R_t[j]; R_t[j] = tt
        td = R_d[i]; R_d[i] = R_d[j]; R_d[j] = td
        to = R_o[i]; R_o[i] = R_o[j]; R_o[j] = to
      }
    }
  }
}

function next_month(y, m) {
  if (m == 12) {
    NY = y + 1
    NM = 1
  } else {
    NY = y
    NM = m + 1
  }
}

function month_bounds(y, m) {
  MB0 = ct_month_start(y, m)
  next_month(y, m)
  MB1 = ct_month_start(NY, NM)
}

function overlap(a0, a1, b0, b1,    o0, o1) {
  o0 = a0
  if (b0 > o0)
    o0 = b0
  o1 = a1
  if (b1 < o1)
    o1 = b1
  if (o1 > o0)
    return o1 - o0
  return 0
}

function period_stats(p0, p1, want,    i, c0, c1, seg, count, down, longest) {
  ST_monitored = 0
  ST_count = 0
  ST_down = 0
  ST_longest = 0
  ST_avg = 0
  ST_c0 = p0
  ST_c1 = p1
  if (no_coverage)
    return
  c0 = p0
  if (coverage > c0)
    c0 = coverage
  c1 = p1
  if (now_epoch < c1)
    c1 = now_epoch
  if (c1 <= c0)
    return
  ST_monitored = c1 - c0
  ST_c0 = c0
  ST_c1 = c1
  count = 0
  down = 0
  longest = 0
  for (i = 1; i <= n; i++) {
    if (R_t[i] != want)
      continue
    seg = overlap(R_s[i], R_e[i], c0, c1)
    if (seg <= 0)
      continue
    count++
    down += seg
    if (seg > longest)
      longest = seg
  }
  ST_count = count
  ST_down = down
  ST_longest = longest
  if (count > 0)
    ST_avg = int(down / count)
}

function is_partial(p0, p1) {
  if (no_coverage)
    return 0
  if (coverage > p0)
    return 1
  if (now_epoch < p1 && now_epoch > p0)
    return 1
  return 0
}

function fmt_hms(sec,    h, m, s) {
  sec = int(sec)
  if (sec < 0)
    sec = 0
  h = int(sec / 3600)
  m = int((sec % 3600) / 60)
  s = sec % 60
  if (h > 0)
    return sprintf("%dh %02dm %02ds", h, m, s)
  if (m > 0)
    return sprintf("%dm %02ds", m, s)
  return sprintf("%ds", s)
}

function fmt_both(sec) {
  return fmt_hms(sec) " (" int(sec) "s)"
}

function fmt_short(sec,    h, m) {
  sec = int(sec)
  if (sec < 0)
    sec = 0
  h = int(sec / 3600)
  m = int((sec % 3600) / 60)
  if (h > 0 && m > 0)
    return sprintf("%dh%dm", h, m)
  if (h > 0)
    return sprintf("%dh", h)
  if (m > 0)
    return sprintf("%dm", m)
  return sprintf("%ds", sec)
}

function fmt_pct(down, covered,    pct) {
  if (covered <= 0)
    return "n/a"
  pct = 100 * (covered - down) / covered
  if (pct < 0)
    pct = 0
  if (pct > 100)
    pct = 100
  return sprintf("%.2f%%", pct)
}

function avail_text(down, covered, p0, p1,    cell) {
  if (covered <= 0)
    return "not monitored"
  cell = fmt_pct(down, covered)
  if (is_partial(p0, p1))
    return cell " (partial)"
  return cell
}

function short_ct(epoch,    off, local, days, sod, p, h, mi) {
  off = ct_offset_seconds(epoch)
  local = epoch + off
  days = int(local / 86400)
  sod = local - days * 86400
  split(civil_ymd(days), p, " ")
  h = int(sod / 3600)
  mi = int((sod - h * 3600) / 60)
  return sprintf("%02d-%02d %02d:%02d", p[2], p[3], h, mi)
}

function table_detail(s) {
  gsub(/\|/, "/", s)
  return s
}

function end_label(i, p0, p1) {
  if (R_o[i] == 1)
    return iso_ct(R_e[i]) " (open)"
  if (R_s[i] < p0 || R_e[i] > p1)
    return iso_ct(R_e[i]) " (continues outside this month)"
  return iso_ct(R_e[i])
}

function w(line) {
  rep = rep line "\n"
}

function sms_top(c0, c1,    i, k, best, best_i, seg, full, item, out) {
  out = ""
  for (i = 1; i <= n; i++)
    delete used[i]
  for (k = 1; k <= 3; k++) {
    best = 0
    best_i = 0
    for (i = 1; i <= n; i++) {
      if (used[i])
        continue
      if (R_t[i] != "internet")
        continue
      seg = overlap(R_s[i], R_e[i], c0, c1)
      if (seg > best) {
        best = seg
        best_i = i
      }
    }
    if (best_i == 0)
      break
    used[best_i] = 1
    full = R_e[best_i] - R_s[best_i]
    item = short_ct(R_s[best_i]) " " fmt_short(best)
    if (full != best)
      item = item " (full " fmt_short(full) ")"
    if (out == "")
      out = item
    else
      out = out "; " item
  }
  return out
}

BEGIN {
  FS = ","
  abort = 0
  if (length(month) != 7 || substr(month, 5, 1) != "-") {
    print "netwatch: REPORT_MONTH must be YYYY-MM" > "/dev/stderr"
    abort = 1
    exit 1
  }
  target_year = substr(month, 1, 4) + 0
  target_month = substr(month, 6, 2) + 0
  if (target_year < 1970 || target_month < 1 || target_month > 12) {
    print "netwatch: REPORT_MONTH must be YYYY-MM" > "/dev/stderr"
    abort = 1
    exit 1
  }
  now_epoch += 0
  if (now_epoch <= 0) {
    print "netwatch: now_epoch is required" > "/dev/stderr"
    abort = 1
    exit 1
  }
  read_state(state_file)
  coverage = read_epoch_file(coverage_file)
  coverage_missing = (coverage <= 0)
  n = 0
  skipped = 0
  no_coverage = 0
  rep = ""
}

/^start_epoch,/ { next }
$0 == "" { next }

{
  gsub(/\r/, "", $0)
  if (NF < 8) {
    skipped++
    next
  }
  detail = $9
  for (i = 10; i <= NF; i++)
    detail = detail "," $i
  add_rec($1 + 0, $4 + 0, $8, detail, 0)
}

END {
  if (abort)
    exit 1
  if (st_phase == "open")
    add_rec(st_since, now_epoch, st_type, st_detail, 1)
  sort_recs()
  if (coverage_missing) {
    if (n == 0) {
      no_coverage = 1
    } else {
      coverage = R_s[1]
      for (i = 2; i <= n; i++) {
        if (R_s[i] < coverage)
          coverage = R_s[i]
      }
    }
  }

  month_bounds(target_year, target_month)
  p0 = MB0
  p1 = MB1

  period_stats(p0, p1, "internet")
  m_count = ST_count
  m_down = ST_down
  m_longest = ST_longest
  m_avg = ST_avg
  m_monitored = ST_monitored
  m_c0 = ST_c0
  m_c1 = ST_c1

  period_stats(p0, p1, "lan")
  lan_count = ST_count
  lan_down = ST_down
  lan_longest = ST_longest

  month_bounds(target_year, 1)
  y0 = MB0
  y1 = p1
  period_stats(y0, y1, "internet")
  ytd_count = ST_count
  ytd_down = ST_down
  ytd_longest = ST_longest
  ytd_monitored = ST_monitored
  period_stats(y0, y1, "lan")
  ytd_lan_count = ST_count
  ytd_lan_down = ST_down

  w("# Internet outage report — " mon_long(target_month) " " target_year)
  w("")
  w("Timezone: America/Chicago. An internet outage means the home gateway answered and every external probe failed, for at least 60 seconds. Gateway-unreachable intervals are LAN problems and are not counted as ISP downtime.")
  w("")
  w("Report time: " iso_ct(now_epoch) ".")
  w("Month window: " iso_ct(p0) " to " iso_ct(p1) ".")
  if (no_coverage) {
    w("No coverage timestamp and no outages were found. Availability is not reported as 100%.")
  } else if (coverage_missing) {
    w("The coverage file was missing. Availability starts at the first logged outage (" iso_ct(coverage) "), so earlier time is excluded.")
  } else {
    w("Logger coverage start: " iso_ct(coverage) ".")
  }
  if (skipped > 0)
    w("Skipped " skipped " log rows that were incomplete or not an internet or LAN outage.")
  w("")
  w("## Internet (ISP)")
  w("")
  if (m_monitored <= 0) {
    w("This month was not monitored. No availability figure is claimed.")
  } else {
    w("- Internet outages: " m_count)
    w("- Internet downtime: " fmt_both(m_down))
    w("- Internet longest: " fmt_both(m_longest))
    w("- Internet average: " fmt_both(m_avg))
    w("- Internet availability: " avail_text(m_down, m_monitored, p0, p1))
    w("- Monitored seconds: " m_monitored)
    w("")
    w("Duration in the totals is only the part inside this month. The table shows the real start and end.")
    w("")
    w("| Start (CT) | End (CT) | In this period | Full duration | Detail |")
    w("| --- | --- | --- | --- | --- |")
    any = 0
    for (i = 1; i <= n; i++) {
      if (R_t[i] != "internet")
        continue
      seg = overlap(R_s[i], R_e[i], m_c0, m_c1)
      if (seg <= 0)
        continue
      any = 1
      w("| " iso_ct(R_s[i]) " | " end_label(i, p0, p1) " | " fmt_both(seg) " | " fmt_both(R_e[i] - R_s[i]) " | " table_detail(R_d[i]) " |")
    }
    if (!any)
      w("| none | | | | |")
  }
  w("")
  w("## LAN / gateway unreachable")
  w("")
  w("These intervals are not included in the ISP counts or availability above.")
  w("")
  if (m_monitored <= 0) {
    w("This month was not monitored.")
  } else if (lan_count == 0) {
    w("No LAN outages in this month.")
  } else {
    w("- LAN outages: " lan_count)
    w("- LAN downtime: " fmt_both(lan_down))
    w("- LAN longest: " fmt_both(lan_longest))
    w("")
    w("| Start (CT) | End (CT) | In this period | Full duration | Detail |")
    w("| --- | --- | --- | --- | --- |")
    for (i = 1; i <= n; i++) {
      if (R_t[i] != "lan")
        continue
      seg = overlap(R_s[i], R_e[i], m_c0, m_c1)
      if (seg <= 0)
        continue
      w("| " iso_ct(R_s[i]) " | " end_label(i, p0, p1) " | " fmt_both(seg) " | " fmt_both(R_e[i] - R_s[i]) " | " table_detail(R_d[i]) " |")
    }
  }
  w("")
  w("## Year to date " target_year)
  w("")
  w("Through " month ". A boundary-spanning outage is counted in each month it touches and once in this YTD row. Downtime is only time inside " target_year ".")
  w("")
  if (ytd_monitored <= 0) {
    w("No year-to-date coverage.")
  } else {
    w("- YTD outages: " ytd_count)
    w("- YTD downtime: " fmt_both(ytd_down))
    w("- YTD longest: " fmt_both(ytd_longest))
    w("- YTD availability: " avail_text(ytd_down, ytd_monitored, y0, y1))
    w("- YTD monitored seconds: " ytd_monitored)
  }
  w("")
  w("| Month | Outages | Downtime | Longest | Availability |")
  w("| --- | --- | --- | --- | --- |")
  for (m = 1; m <= target_month; m++) {
    month_bounds(target_year, m)
    period_stats(MB0, MB1, "internet")
    if (ST_monitored <= 0) {
      w("| " sprintf("%04d-%02d", target_year, m) " | n/a | n/a | n/a | not monitored |")
    } else {
      w("| " sprintf("%04d-%02d", target_year, m) " | " ST_count " | " fmt_both(ST_down) " | " fmt_both(ST_longest) " | " avail_text(ST_down, ST_monitored, MB0, MB1) " |")
    }
  }
  if (ytd_monitored <= 0) {
    w("| YTD | n/a | n/a | n/a | not monitored |")
  } else {
    w("| YTD | " ytd_count " | " fmt_both(ytd_down) " | " fmt_both(ytd_longest) " | " avail_text(ytd_down, ytd_monitored, y0, y1) " |")
  }
  w("")
  if (ytd_lan_count == 1)
    w("LAN year to date (not included above): 1 outage, " fmt_both(ytd_lan_down) ".")
  else if (ytd_lan_count > 1)
    w("LAN year to date (not included above): " ytd_lan_count " outages, " fmt_both(ytd_lan_down) ".")
  else
    w("LAN year to date: none.")
  w("")

  if (m_monitored <= 0)
    sms = "[Skynet] " mon_short(target_month) " " target_year " internet: not monitored."
  else
    sms = "[Skynet] " mon_short(target_month) " " target_year " internet: " m_count " outages, down " fmt_short(m_down) ", longest " fmt_short(m_longest) ", avg " fmt_short(m_avg) ", avail " fmt_pct(m_down, m_monitored) "."
  if (ytd_monitored <= 0)
    sms = sms " YTD: not monitored."
  else {
    sms = sms " YTD: " ytd_count " outages, down " fmt_short(ytd_down) ", avail " fmt_pct(ytd_down, ytd_monitored)
    if (is_partial(y0, y1))
      sms = sms " partial"
    sms = sms "."
  }
  if (lan_count > 0)
    sms = sms " LAN (not ISP): " lan_count ", " fmt_short(lan_down) "."
  tops = ""
  if (m_monitored > 0)
    tops = sms_top(m_c0, m_c1)
  if (tops != "")
    sms = sms " Top: " tops "."
  if (length(sms) > 320)
    sms = substr(sms, 1, 317) "..."

  printf "%s", rep > report_path
  close(report_path)
  printf "%s\n", sms > sms_path
  close(sms_path)
}
