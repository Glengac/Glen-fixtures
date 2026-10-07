#!/usr/bin/env python3
"""Build subscribable calendars (docs/cal/<team>.ics and docs/cal/all.ics) from docs/fixtures.json.

Run from the repository root:  python3 tools/build_calendars.py
Calendar apps re-fetch these files on their own, so subscribers see time and venue changes.
"""
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
LONDON = ZoneInfo("Europe/London")
VENUE_QUERY = {
    "Watty Graham Park": "Watty Graham Park, Maghera",
    "Owenbeg": "Owenbeg Derry GAA Centre of Excellence",
}


def esc(text):
    return (str(text).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n"))


def fold(line):
    """Fold to 75 octets per RFC 5545."""
    data = line.encode("utf-8")
    if len(data) <= 75:
        return line
    parts, cur = [], b""
    for ch in line:
        b = ch.encode("utf-8")
        if len(cur) + len(b) > (75 if not parts else 74):
            parts.append(cur.decode("utf-8"))
            cur = b""
        cur += b
    parts.append(cur.decode("utf-8"))
    return "\r\n ".join(parts)


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def event_lines(g, team_name, stamp):
    title = f"Glen v {g['opp']} ({team_name})"
    if g.get("st") == "result" and g.get("us") and g.get("them"):
        title = f"Glen {g['us']} v {g['them']} {g['opp']} ({team_name})"
    elif g.get("st") == "walkover":
        title = f"Glen v {g['opp']} ({team_name}) – walkover"
    comp = g['comp'] + (f" · {g['round']}" if g.get('round') else "")
    desc = f"{comp}\nCheck for time or venue changes before you travel."
    loc = "" if g.get("venue") in (None, "", "TBC") else VENUE_QUERY.get(g["venue"], g["venue"])
    uid = f"{g['d']}-{g['team']}-{slug(g['opp'])}@glen-fixtures"
    lines = ["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{stamp}"]
    if g.get("t"):
        start = datetime.fromisoformat(f"{g['d']}T{g['t']}").replace(tzinfo=LONDON).astimezone(timezone.utc)
        end = start + timedelta(minutes=90)
        lines += [f"DTSTART:{start:%Y%m%dT%H%M%SZ}", f"DTEND:{end:%Y%m%dT%H%M%SZ}"]
    else:
        day = datetime.fromisoformat(g["d"]).date()
        lines += [f"DTSTART;VALUE=DATE:{day:%Y%m%d}", f"DTEND;VALUE=DATE:{day + timedelta(days=1):%Y%m%d}"]
    lines += [f"SUMMARY:{esc(title)}", f"DESCRIPTION:{esc(desc)}"]
    if loc:
        lines.append(f"LOCATION:{esc(loc)}")
    lines.append("END:VEVENT")
    return lines


def calendar(name, games, teams, stamp):
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Glen fixtures//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
        f"X-WR-CALNAME:{esc(name)}", "X-WR-TIMEZONE:Europe/London",
        "REFRESH-INTERVAL;VALUE=DURATION:PT12H", "X-PUBLISHED-TTL:PT12H",
    ]
    for g in sorted(games, key=lambda x: (x["d"], x.get("t") or "")):
        lines += event_lines(g, teams.get(g["team"], "Glen"), stamp)
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(l) for l in lines) + "\r\n"


def main():
    data = json.loads((DOCS / "fixtures.json").read_text(encoding="utf-8"))
    teams = {t["id"]: t["name"] for t in data["teams"]}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = DOCS / "cal"
    out.mkdir(exist_ok=True)
    (out / "all.ics").write_text(calendar("Glen · all teams", data["games"], teams, stamp), encoding="utf-8", newline="")
    for tid, tname in teams.items():
        games = [g for g in data["games"] if g["team"] == tid]
        (out / f"{tid}.ics").write_text(calendar(f"Glen · {tname}", games, teams, stamp), encoding="utf-8", newline="")
    print(f"Wrote {len(teams) + 1} calendars to {out}")


if __name__ == "__main__":
    main()
