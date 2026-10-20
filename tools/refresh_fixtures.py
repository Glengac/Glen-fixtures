#!/usr/bin/env python3
"""
Refresh docs/fixtures.json for the An Gleann (Watty Graham's GAC Glen) site.

Sources
  Derry GAA (Club & County):  the club's team page and the all-county listing
  Ulster LGFA:                fixtures and results pages (ladies club championships)

Run from the repository root (the "Refresh fixtures" GitHub Action does this):
  python3 tools/refresh_fixtures.py              fetch, merge, write, rebuild calendars
  python3 tools/refresh_fixtures.py --dry-run    fetch and report, change nothing
  python3 tools/refresh_fixtures.py --html derry=page.html --html lgfa-fixtures=f.html ...
                                                 use saved pages instead of fetching

Rules it keeps (same as the old Claude task):
  * games are keyed on date + team + opponent, so existing names are never changed
  * a result, walkover or concession never turns back into a fixture
  * a real score is never replaced by 0-0
  * games the sources no longer show are kept (season history)
  * if every source fails, nothing is written and the run fails, so the site keeps its last good data
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "fixtures.json"
LONDON = ZoneInfo("Europe/London")
HEARTBEAT = timedelta(minutes=110)   # rewrite "updated" at least this often so "last checked" stays fresh

SOURCES = {
    "derry": "https://derry.clubandcounty.com/fixtures-results/team/an-gleann/aff0a6a4-5212-3297-0b2c-1cf539ad1546/",
    "derry-all": "https://derry.clubandcounty.com/fixtures-results/",
    "lgfa-fixtures": "https://ulsterladiesgaelic.com/fixtures/",
    "lgfa-results": "https://ulsterladiesgaelic.com/results/",
}

# --------------------------------------------------------------------------
# Text helpers
# --------------------------------------------------------------------------

def clean(s: str) -> str:
    return " ".join((s or "").replace(" ", " ").split())


def fold(s: str) -> str:
    """lower-case, accents and apostrophes removed, punctuation to spaces"""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[’'`´]", "", s)
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s).split())


GLEN_RE = re.compile(r"\b(an gleann|gleann|watty grahams?|glen)\b")


def is_glen(name: str) -> bool:
    return bool(GLEN_RE.search(fold(name)))


MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
CC_DATE_RE = re.compile(
    r"^(?:mon|tues|wednes|thurs|fri|satur|sun)day\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?\s+(\d{4})$", re.I)
SHORT_DATE_RE = re.compile(r"^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?\s+(\d{4})$", re.I)
SLASH_DATE_RE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")
SCORE_RE = re.compile(r"^\d{1,2}-\d{1,3}$")
TIME_RE = re.compile(r"^\d{1,2}:\d{2}$")
SLOT_RE = re.compile(r"^(\d{1,2}:\d{2}|tbc|tba|conceded|postponed|refixed|abandoned|w/?o)$", re.I)
LABEL_RE = re.compile(r"^(venue|referee|live via|live on|tickets|stream)\s*:\s*(.*)$", re.I)


def to_iso(text: str) -> str | None:
    t = clean(text)
    for rx in (CC_DATE_RE, SHORT_DATE_RE):
        m = rx.match(t)
        if m:
            mon = MONTHS.get(m.group(2).lower()[:3])
            if mon:
                try:
                    return date(int(m.group(3)), mon, int(m.group(1))).isoformat()
                except ValueError:
                    return None
    m = SLASH_DATE_RE.match(t)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            return None
    return None


def tokens(html: str) -> list[tuple[str, str]]:
    """The page as a reader sees it: ('date', iso) / ('text', s) / ('link', s, href)."""
    from bs4 import BeautifulSoup, Comment, NavigableString, Tag

    soup = BeautifulSoup(html, "html.parser")
    skip = {"script", "style", "noscript", "svg", "template", "head", "select", "option"}
    out: list[tuple] = []

    def walk(node):
        for child in node.children:
            if isinstance(child, Comment):
                continue
            if isinstance(child, NavigableString):
                t = clean(str(child))
                if t:
                    iso = to_iso(t)
                    out.append(("date", iso) if iso else ("text", t))
            elif isinstance(child, Tag):
                if child.name in skip:
                    continue
                if child.name == "a":
                    t = clean(child.get_text(" "))
                    if t:
                        iso = to_iso(t)
                        href = child.get("href") or ""
                        out.append(("date", iso, href) if iso else ("link", t, href))
                    continue
                if child.name in ("h1", "h2", "h3", "h4", "h5", "h6", "time"):
                    iso = to_iso(child.get_text(" "))
                    if iso:
                        out.append(("date", iso))
                        continue
                walk(child)

    walk(soup.body or soup)
    # "0" "-" "25" rendered as separate spans -> "0-25"
    merged: list[tuple] = []
    i = 0
    while i < len(out):
        t = out[i]
        if (t[0] == "text" and t[1].isdigit() and i + 2 < len(out)
                and out[i + 1][0] == "text" and out[i + 1][1] in ("-", "–")
                and out[i + 2][0] == "text" and out[i + 2][1].isdigit()):
            merged.append(("text", f"{t[1]}-{out[i + 2][1]}"))
            i += 3
            continue
        merged.append(t)
        i += 1
    return merged


# --------------------------------------------------------------------------
# Derry GAA (Club & County) parser
# --------------------------------------------------------------------------

def _is_score(s: str) -> bool:
    return bool(SCORE_RE.match(s)) or s.upper() == "CONC"


def parse_cc(html: str) -> list[dict]:
    """Every game on a Club & County fixtures/results page.

    Works on the pattern  <competition> <home> <score> <time> <score> <away>  followed by
    "Venue:" / "Referee:" lines, whether or not the names are links.
    """
    toks = tokens(html)
    games: list[dict] = []
    cur_date = None
    pending: list[tuple] = []     # tokens since the last game or date heading
    i, n = 0, len(toks)
    last = None

    while i < n:
        t = toks[i]
        if t[0] == "date":
            cur_date, pending, last = t[1], [], None
            i += 1
            continue
        text = t[1]
        low = text.lower()
        if low.startswith("load more results"):
            break                                   # league tables follow
        if low.startswith("load more fixtures"):
            pending, last = [], None
            i += 1
            continue
        lab = LABEL_RE.match(text)
        if lab:
            key = lab.group(1).lower()
            val = lab.group(2).strip()
            if not val and i + 1 < n and toks[i + 1][0] != "date" and not LABEL_RE.match(toks[i + 1][1]):
                val = toks[i + 1][1]
                i += 1
            if last is not None and key == "venue":
                last["venue"] = val
            elif last is not None and key == "referee":
                last["ref"] = val
            elif last is not None and key in ("live via", "live on", "stream"):
                last["live"] = val
            pending = []
            i += 1
            continue
        # <score> <slot> <score> with a name either side?
        if (cur_date and i + 3 < n and _is_score(text) and toks[i + 1][0] != "date" and SLOT_RE.match(toks[i + 1][1])
                and toks[i + 2][0] != "date" and _is_score(toks[i + 2][1]) and toks[i + 3][0] != "date"
                and len(pending) >= 2):
            home_tok = pending[-1]
            comp_toks = [pending[-2]]
            # a round written as its own fragment ("- Final") belongs to the competition before it
            k = len(pending) - 3
            while k >= 0 and re.match(r"^[-–]\s*\S", comp_toks[0][1]) and len(comp_toks) < 4:
                comp_toks.insert(0, pending[k])
                k -= 1
            g = {
                "date": cur_date,
                "comp": clean(" ".join(c[1] for c in comp_toks)),
                "href": next((c[2] for c in comp_toks if c[0] == "link"), ""),
                "home": home_tok[1],
                "hs": text,
                "slot": toks[i + 1][1],
                "as": toks[i + 2][1],
                "away": toks[i + 3][1],
            }
            games.append(g)
            last, pending = g, []
            i += 4
            continue
        pending.append(t)
        if len(pending) > 12:
            pending = pending[-12:]
        i += 1
    return games


# --------------------------------------------------------------------------
# Ulster LGFA parser (best effort; only games involving the club are used)
# --------------------------------------------------------------------------

LGFA_GRADE_RE = re.compile(r"\b(senior|intermediate|junior|minor)\b", re.I)


def parse_lgfa(html: str) -> list[dict]:
    flat = [(t[0], t[1], t[2] if len(t) > 2 else "") for t in tokens(html)]
    league_grade = {}
    for kind, text, href in flat:
        m = re.search(r"/league/(\d+)", href)
        g = LGFA_GRADE_RE.search(text) if m and kind == "link" else None
        if g:
            league_grade[m.group(1)] = g.group(1).title()
    games, seen = [], set()
    grade = None
    for idx, (kind, text, href) in enumerate(flat):
        m = re.search(r"/league/(\d+)", href)
        if m and m.group(1) in league_grade:
            grade = league_grade[m.group(1)]
        if kind == "link" and m:
            g = LGFA_GRADE_RE.search(text)
            if g:
                grade = g.group(1).title()
        if kind != "date":
            continue
        # look ahead a few tokens for: [time] team1 (V | s1 s2 | s1 V s2) team2 [venue]
        window = flat[idx + 1: idx + 10]
        texts = []
        for w in window:
            if w[0] == "date":
                continue
            both = re.fullmatch(r"(\d{1,2})\s*-\s*(\d{1,3})\s*[Vv]\s*(\d{1,2})\s*-\s*(\d{1,3})", w[1])
            one = re.fullmatch(r"(\d{1,2})\s*-\s*(\d{1,3})", w[1])
            if both:
                texts += [f"{both.group(1)}-{both.group(2)}", "V", f"{both.group(3)}-{both.group(4)}"]
            elif one:
                texts.append(f"{one.group(1)}-{one.group(2)}")
            else:
                texts.append(w[1])
        if not texts:
            continue
        j = 0
        tm = texts[0] if TIME_RE.match(texts[0]) else None
        if tm:
            j = 1
        if j + 2 >= len(texts):
            continue
        team1 = texts[j]
        if texts[j + 1].lower() in ("v", "vs", "v."):
            team2 = texts[j + 2] if j + 2 < len(texts) else ""
            s1 = s2 = None
            venue = texts[j + 3] if j + 3 < len(texts) else ""
        elif j + 3 < len(texts) and _is_score(texts[j + 1]) and _is_score(texts[j + 2]):
            s1, s2 = texts[j + 1], texts[j + 2]
            team2 = texts[j + 3]
            venue = texts[j + 4] if j + 4 < len(texts) else ""
        elif j + 3 < len(texts) and _is_score(texts[j + 1]) and texts[j + 2].lower() in ("v", "vs", "-") and _is_score(texts[j + 3]):
            s1, s2 = texts[j + 1], texts[j + 3]
            team2 = texts[j + 4] if j + 4 < len(texts) else ""
            venue = texts[j + 5] if j + 5 < len(texts) else ""
        else:
            continue
        if venue.lower() in ("more", "report", "match report"):
            venue = ""
        if not (is_glen(team1) or is_glen(team2)):
            continue
        # grade: nearest competition name above, else any grade word close by
        g = grade
        if not g:
            for back in range(idx - 1, max(-1, idx - 40), -1):
                mm = LGFA_GRADE_RE.search(flat[back][1]) if "club" in flat[back][1].lower() else None
                if mm:
                    g = mm.group(1).title()
                    break
        key = (text, fold(team1), fold(team2))
        if key in seen:
            continue
        seen.add(key)
        games.append({"date": text, "time": tm, "team1": team1, "team2": team2,
                      "s1": s1, "s2": s2, "venue": venue, "grade": g})
    return games


# --------------------------------------------------------------------------
# Naming: opponents, venues, competitions, rounds, teams
# --------------------------------------------------------------------------

# folded keyword -> short place name (opponents and their grounds)
PLACES = [
    ("baile na scrine", "Ballinascreen"), ("ballinascreen", "Ballinascreen"), ("draperstown", "Ballinascreen"),
    ("ballinderry", "Ballinderry"), ("st trea", "Ballymaguigan"), ("ballymaguigan", "Ballymaguigan"),
    ("banagher", "Banagher"), ("bellaghy", "Bellaghy"), ("wolfe tones", "Bellaghy"),
    ("ballerin", "Ballerin"), ("sarsfield", "Ballerin"),
    ("castledawson", "Castledawson"), ("malachy", "Castledawson"),
    ("claudy", "Claudy"), ("john mitchel", "Claudy"),
    ("eoghan rua", "Eoghan Rua"), ("coleraine", "Eoghan Rua"),
    ("craigbane", "Craigbane"), ("desertmartin", "Desertmartin"), ("st martin", "Desertmartin"),
    ("doire colmcille", "Doire Colmcille"), ("doire trasna", "Doire Trasna"),
    ("drumsurn", "Drumsurn"), ("dungiven", "Dungiven"), ("canice", "Dungiven"), ("kevin lynch", "Dungiven"),
    ("faughanvale", "Faughanvale"), ("foreglen", "Foreglen"), ("glack", "Glack"), ("glenullin", "Glenullin"),
    ("greenlough", "Greenlough"), ("oliver plunkett", "Greenlough"),
    ("kilrea", "Kilrea"), ("lavey", "Lavey"), ("erins own", "Lavey"),
    ("limavady", "Limavady"), ("wolfhounds", "Limavady"), ("lissan", "Lissan"),
    ("loup", "Loup"), ("an lub", "Loup"),
    ("magherafelt", "Magherafelt"), ("odonovan rossa", "Magherafelt"), ("o donovan rossa", "Magherafelt"),
    ("moneymore", "Moneymore"), ("newbridge", "Newbridge"), ("sean oleary", "Newbridge"), ("sean o leary", "Newbridge"),
    ("slaughtneil", "Slaughtneil"), ("sleacht neill", "Slaughtneil"), ("roibeard eimeid", "Slaughtneil"),
    ("robert emmet", "Slaughtneil"),
    ("steelstown", "Steelstown"), ("brian og", "Steelstown"), ("sean dolan", "Sean Dolans"),
    ("swatragh", "Swatragh"), ("na magha", "Na Magha"), ("slaughtmanus", "Slaughtmanus"),
    ("ardmore", "Ardmore"), ("termoneeny", "Termoneeny"), ("knockloughrim", "Termoneeny"),
]
# a club's home ground, when it isn't named after the club
GROUND = {"Eoghan Rua": "Coleraine"}
VENUE_SPECIAL = [
    ("watty graham", "Watty Graham Park"), ("an gleann", "Watty Graham Park"), ("owenbeg", "Owenbeg"),
    ("celtic park", "Celtic Park"), ("coleraine", "Coleraine"), ("eoghan rua", "Coleraine"),
]
COUNTIES = {"antrim", "armagh", "cavan", "derry", "donegal", "down", "fermanagh", "monaghan", "tyrone", "louth", "londonderry"}


def place_of(name: str) -> str | None:
    f = " " + fold(name) + " "
    for key, place in PLACES:
        if f" {key} " in f or f" {key}s " in f:
            return place
    return None


def short_team(name: str) -> str:
    n = clean(re.sub(r"\((?:c|C)\)", "", name))
    n = re.sub(r"\s*\((?:%s)\)\s*$" % "|".join(COUNTIES), "", n, flags=re.I)
    p = place_of(n)
    if p:
        return p
    n = re.sub(r"\b(GAC|GAA|CLG|GFC|LGFC|LGFA|Camogie|Club|Ladies)\b\.?", "", n, flags=re.I)
    n = re.sub(r"\s+(Res|Reserves|II|2|B|C)$", "", clean(n), flags=re.I)
    n = re.sub(r"^St\.? [A-Z][\w']*'?s\s+(?=\S)", "", clean(n))
    return clean(n.strip(" ,-")) or clean(name)


def short_venue(raw: str) -> str:
    v = clean(raw)
    f = fold(v)
    if not f or f in ("tbc", "tba", "to be confirmed", "venue tbc"):
        return "TBC"
    if f in ("glen", "maghera") or f.startswith("glen ") or f.endswith(" glen"):
        return "Watty Graham Park"
    if f in COUNTIES:
        return "TBC"
    for key, val in VENUE_SPECIAL:
        if key in f:
            return val
    p = place_of(v)
    if p:
        return GROUND.get(p, p)
    v = re.sub(r"\b(GAC|GAA|CLG|GFC)\b\.?", "", v, flags=re.I)
    return clean(v.strip(" ,-")) or "TBC"


def tidy_comp(text: str) -> str:
    c = clean(re.sub(r"\b20\d\d\b", "", text))
    c = " ".join(w.title() if (w.isupper() and len(w) > 3 and w.isalpha()) else w for w in c.split())
    return clean(c.strip(" -–"))


def tidy_round_part(p: str) -> str | None:
    f = fold(p)
    if not f or f in ("knockout", "knockouts", "knock out", "ko", "group stage", "league stage"):
        return None
    if re.fullmatch(r"semi ?finals?|sf\d*", f):
        return "Semi-final"
    if re.fullmatch(r"quarter ?finals?|qf\d*", f):
        return "Quarter-final"
    if re.fullmatch(r"finals?", f):
        return "Final"
    if re.fullmatch(r"preliminary( round)?", f):
        return "Preliminary"
    m = re.fullmatch(r"(round|rd) (\d+)", f)
    if m:
        return f"Round {m.group(2)}"
    p = clean(p)
    p = re.sub(r"\bSemi[ -]?Finals?\b", "Semi-final", p, flags=re.I)
    p = re.sub(r"\bQuarter[ -]?Finals?\b", "Quarter-final", p, flags=re.I)
    return p


def split_comp(text: str) -> tuple[str, str]:
    parts = [x for x in re.split(r"\s+[-–]\s*|\s*[-–]\s+", clean(text)) if x.strip()]
    if not parts:
        return clean(text), ""
    comp = tidy_comp(parts[0])
    rnd = [r for r in (tidy_round_part(p) for p in parts[1:]) if r]
    return comp, " · ".join(rnd)


AGE_RE = re.compile(r"\bu-?(\d{1,2})")


def sport_of(comp: str, href: str) -> str:
    h = (href or "").lower()
    if "/ladies_football/" in h:
        return "ladies"
    if "/camogie/" in h:
        return "camogie"
    if "/hurling/" in h:
        return "hurling"
    if "/football/" in h:
        return "football"
    f = fold(comp)
    if "camogie" in f:
        return "camogie"
    if "hurling" in f:
        return "hurling"
    if any(w in f for w in ("football", "recreational", "reserve", "development")):
        return "football"
    return "ladies"          # Derry LGFA competitions are named plainly ("U16 Championship")


def team_for(comp: str, href: str, label: str) -> tuple[str | None, str | None, str | None]:
    """(team id, new team name, group) for one of the club's games; id None = skip."""
    f, lab = fold(comp), fold(label)
    sport = sport_of(comp, href)
    age = AGE_RE.search(f)
    age = int(age.group(1)) if age else None
    if sport == "hurling":
        return None, None, None
    if sport == "camogie":
        return "cam", None, None
    if sport == "ladies":
        if "intermediate" in f:
            return "int", None, None
        if "minor" in f or age == 18:
            return "mlf", None, None
        if age == 16:
            return "u16l", None, None
        if age == 14:
            return ("u14l2" if re.search(r"\b(2|ii)$", lab) else "u14l"), None, None
        if "senior" in f:
            return "sl", "Senior Ladies", "Ladies football"
        if "junior" in f:
            return "jl", "Junior Ladies", "Ladies football"
        if age:
            return f"u{age}l", f"U{age} Ladies", "Ladies football"
        return None, None, None
    # football
    if "recreational" in f:
        return "rec", None, None
    if "reserve" in f or lab.endswith(" res") or lab.endswith(" reserves"):
        return "rf", None, None
    if "minor" in f or age == 18:
        return "mf", None, None
    if age == 16:
        return "u16f", None, None
    if age == 14:
        if lab.endswith(" c") or re.search(r"u14 ?c\b|division 3|div 3", f):
            return "u14c", None, None
        if lab.endswith(" b") or re.search(r"a1b\b|division 1b|div 1b", f):
            return "u14b", None, None
        return "u14a", None, None
    if age == 13 and "development" in f:
        return "u13d", None, None
    if age:
        return f"u{age}f", f"U{age} Football", "Football"
    if "senior" in f or "division 1 football league" in f or "football league" in f:
        return "sf", None, None
    return None, None, None


# --------------------------------------------------------------------------
# Building the club's games
# --------------------------------------------------------------------------

def london_today() -> date:
    return datetime.now(LONDON).date()


def derry_games(raw: list[dict], today: date, log) -> tuple[list[dict], dict]:
    out, new_teams, seen = [], {}, {}
    for r in raw:
        home_glen, away_glen = is_glen(r["home"]), is_glen(r["away"])
        if home_glen == away_glen:
            continue
        glen_side = "home" if home_glen else "away"
        label = r[glen_side]
        opp_raw = r["away" if home_glen else "home"]
        tid, tname, tgroup = team_for(r["comp"], r.get("href", ""), label)
        if not tid:
            log(f"skipped (no team for it): {r['date']} {r['comp']} | {r['home']} v {r['away']}")
            continue
        if tname:
            new_teams[tid] = {"id": tid, "name": tname, "group": tgroup}
        comp, rnd = split_comp(r["comp"])
        if tid == "mlf" and fold(comp) == "minor championship":
            comp = "Minor Championship"
        opp = short_team(opp_raw)
        venue = short_venue(r.get("venue", ""))
        us_c = bool(re.search(r"\(c\)", label, re.I)) or (r["hs"] if home_glen else r["as"]).upper() == "CONC"
        them_c = bool(re.search(r"\(c\)", opp_raw, re.I)) or (r["as"] if home_glen else r["hs"]).upper() == "CONC"
        us_s, them_s = (r["hs"], r["as"]) if home_glen else (r["as"], r["hs"])
        t = r["slot"] if TIME_RE.match(r["slot"]) else None
        if t and len(t) == 4:
            t = "0" + t
        g = {"d": r["date"], "t": t, "team": tid, "comp": comp, "round": rnd, "opp": opp, "venue": venue}
        if venue == "Watty Graham Park":
            g["ha"] = "H"
        elif venue != "TBC" and venue in (opp, GROUND.get(opp)):
            g["ha"] = "A"
        elif venue == "TBC":
            g["ha"] = "H" if home_glen else "A"
        else:
            g["ha"] = "N"
        if them_c:
            g.update(st="walkover", note=f"{opp} conceded")
        elif us_c:
            g.update(st="conceded", note="An Gleann conceded")
        elif SCORE_RE.match(us_s) and SCORE_RE.match(them_s) and not (us_s == "0-0" and them_s == "0-0"):
            g.update(st="result", us=us_s, them=them_s)
        else:
            g["st"] = "fixture"
        key = (g["d"], g["team"], g["opp"])
        prev = seen.get(key)
        if prev is None or (prev["st"] == "fixture" and g["st"] != "fixture"):
            seen[key] = g
    out = list(seen.values())
    return out, new_teams


def lgfa_games(raw: list[dict], log) -> tuple[list[dict], dict]:
    out, new_teams = [], {}
    for r in raw:
        iso = r["date"] if re.fullmatch(r"\d{4}-\d{2}-\d{2}", r["date"] or "") else to_iso(r["date"])
        if not iso:
            continue
        grade = (r.get("grade") or "").title()
        tid = {"Intermediate": "int", "Minor": "mlf", "Senior": "sl", "Junior": "jl"}.get(grade)
        if not tid:
            log(f"Ulster LGFA game with no grade, skipped: {r}")
            continue
        if tid in ("sl", "jl"):
            new_teams[tid] = {"id": tid, "name": f"{grade} Ladies", "group": "Ladies football"}
        first = is_glen(r["team1"])
        opp_raw = r["team2"] if first else r["team1"]
        venue = short_venue(r.get("venue", ""))
        g = {"d": iso, "t": r.get("time"), "team": tid, "comp": f"Ulster LGFA {grade} Club Championship",
             "round": "", "opp": short_team(opp_raw), "venue": venue}
        g["ha"] = ("H" if venue == "Watty Graham Park" else "A" if venue in (g["opp"], GROUND.get(g["opp"])) else
                   ("H" if first else "A") if venue == "TBC" else "N")
        if r.get("s1") and r.get("s2"):
            us, them = (r["s1"], r["s2"]) if first else (r["s2"], r["s1"])
            g.update(st="result", us=us, them=them)
        else:
            g["st"] = "fixture"
        out.append(g)
    return out, new_teams


# --------------------------------------------------------------------------
# Merge into fixtures.json
# --------------------------------------------------------------------------

FINAL = ("result", "walkover", "conceded")


def merge(data: dict, found: list[dict], new_teams: dict, log) -> dict:
    games = data["games"]
    stats = {"added": 0, "results": 0, "changed": 0}
    known_teams = {t["id"] for t in data["teams"]}
    for tid, t in new_teams.items():
        if tid not in known_teams and any(g["team"] == tid for g in found):
            data["teams"].append(t)
            known_teams.add(tid)
            log(f"new team added: {t['name']}")

    def one(pred):
        c = [g for g in games if pred(g)]
        return c[0] if len(c) == 1 else None

    for s in found:
        e = (one(lambda g: g["d"] == s["d"] and g["team"] == s["team"] and g["opp"] == s["opp"])
             or one(lambda g: g["d"] == s["d"] and g["team"] == s["team"])
             or one(lambda g: g["d"] == s["d"] and fold(g["opp"]) == fold(s["opp"])))
        if e is None and s["st"] == "fixture":
            # a fixture that moved date
            moved = one(lambda g: g["st"] == "fixture" and g["team"] == s["team"] and g["opp"] == s["opp"]
                        and fold(g["comp"]) == fold(s["comp"]) and g["d"] != s["d"])
            if moved and not any(g["d"] == s["d"] and g["team"] == s["team"] for g in games):
                log(f"moved: {moved['team']} v {moved['opp']} {moved['d']} -> {s['d']}")
                moved["d"] = s["d"]
                e = moved
                stats["changed"] += 1
        if e is None:
            g = dict(s)
            if g["st"] != "result":
                g.pop("us", None), g.pop("them", None)
            games.append(g)
            stats["added"] += 1
            log(f"added: {g['d']} {g['team']} v {g['opp']} ({g['st']})")
            continue

        was_fixture = e["st"] == "fixture"
        if s["st"] == "fixture":
            if e["st"] in FINAL:
                continue                                    # never back to a fixture
            if s.get("t") and s["t"] != e.get("t"):
                log(f"time: {e['d']} {e['team']} v {e['opp']} {e.get('t')} -> {s['t']}")
                e["t"] = s["t"]
                stats["changed"] += 1
        else:
            if s["st"] == "result":
                if e["st"] != "result" or e.get("us") != s["us"] or e.get("them") != s["them"]:
                    if e["st"] in ("walkover", "conceded"):
                        continue                            # a decided concession stays
                    e["st"], e["us"], e["them"] = "result", s["us"], s["them"]
                    e.pop("note", None)
                    stats["results"] += 1
                    log(f"result: {e['d']} {e['team']} v {e['opp']} {s['us']} - {s['them']}")
            elif e["st"] != s["st"]:
                e["st"], e["note"] = s["st"], s["note"]
                e.pop("us", None), e.pop("them", None)
                stats["results"] += 1
                log(f"{s['st']}: {e['d']} {e['team']} v {e['opp']}")
        if was_fixture and s["venue"] != "TBC" and fold(s["venue"]) != fold(e.get("venue", "")):
            log(f"venue: {e['d']} {e['team']} v {e['opp']} {e.get('venue')} -> {s['venue']}")
            e["venue"], e["ha"] = s["venue"], s["ha"]
            stats["changed"] += 1
        if not e.get("round") and s.get("round"):
            e["round"] = s["round"]
            stats["changed"] += 1

    fixtures = sorted((g for g in games if g["st"] == "fixture"), key=lambda g: (g["d"], g.get("t") or "99:99"))
    others = sorted((g for g in games if g["st"] != "fixture"), key=lambda g: (g["d"], g.get("t") or ""), reverse=True)
    data["games"] = fixtures + others
    return stats


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def fetch(url: str) -> str:
    import requests
    r = requests.get(url, timeout=40, headers={
        "User-Agent": "Mozilla/5.0 (compatible; GlenFixturesBot/1.0; club fixtures page)",
        "Accept-Language": "en-GB,en;q=0.9",
    })
    r.raise_for_status()
    return r.text


def annotate(title: str, lines: list[str]) -> None:
    """Show a summary on the GitHub Actions run page."""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    body = "\n".join(lines) or "(nothing)"
    body = body.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    safe_title = title.replace(",", " -").replace(":", " ")
    print(f"::notice title={safe_title}::{body[:60000]}")
    summ = os.environ.get("GITHUB_STEP_SUMMARY")
    if summ:
        with open(summ, "a", encoding="utf-8") as fh:
            fh.write(f"### {title}\n\n" + "\n".join(f"- {l}" for l in lines) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--html", action="append", default=[], help="source=path to use a saved page")
    ap.add_argument("--today", help="override today's date (YYYY-MM-DD) for testing")
    ap.add_argument("--data", default=str(DATA))
    args = ap.parse_args()

    report: list[str] = []
    log = lambda m: (print(m), report.append(m))
    saved = dict(x.split("=", 1) for x in args.html)
    today = date.fromisoformat(args.today) if args.today else london_today()

    pages = {}
    for key, url in SOURCES.items():
        if saved and key not in saved:
            continue
        try:
            pages[key] = Path(saved[key]).read_text(encoding="utf-8") if key in saved else fetch(url)
        except Exception as e:     # noqa: BLE001
            log(f"{key}: could not load ({e.__class__.__name__}: {e})")

    raw_derry = []
    for key in ("derry", "derry-all"):
        if key in pages:
            rows = parse_cc(pages[key])
            glen = [r for r in rows if is_glen(r["home"]) != is_glen(r["away"])]
            log(f"{key}: {len(rows)} games on the page, {len(glen)} involving the club")
            raw_derry += glen
    found, new_teams = derry_games(raw_derry, today, log)

    lgfa_ok = False
    for key in ("lgfa-fixtures", "lgfa-results"):
        if key in pages:
            rows = parse_lgfa(pages[key])
            lgfa_ok = True
            log(f"{key}: {len(rows)} games involving the club")
            g2, t2 = lgfa_games(rows, log)
            found += g2
            new_teams.update(t2)

    if not raw_derry and not lgfa_ok:
        log("Nothing could be read from any source - fixtures.json left unchanged.")
        annotate("Fixtures refresh failed", report)
        return 1
    if not raw_derry:
        log("WARNING: no Derry GAA games read - their page may have changed. Existing games kept.")

    path = Path(args.data)
    data = json.loads(path.read_text(encoding="utf-8"))
    canon = lambda d: json.dumps({"teams": d["teams"], "games": sorted(json.dumps(g, sort_keys=True) for g in d["games"])},
                                 sort_keys=True)
    before = canon(data)
    stats = merge(data, found, new_teams, log)
    changed = canon(data) != before

    now = datetime.now(LONDON).replace(microsecond=0)
    try:
        last = datetime.fromisoformat(data.get("updated", ""))
    except ValueError:
        last = None
    stale = last is None or now - last >= HEARTBEAT

    if changed:
        msg = f"Fixtures refresh: {stats['added']} added, {stats['results']} results updated"
        if stats["changed"]:
            msg += f", {stats['changed']} other changes"
    else:
        msg = "Fixtures checked: no changes"
    log(msg)

    if args.dry_run:
        annotate("Fixtures refresh (dry run, nothing saved)", report)
        return 0
    if not changed and not stale:
        annotate("Fixtures checked", report + ["Up to date; last-checked time is recent, nothing to save."])
        return 0

    data["updated"] = now.isoformat()
    text = json.dumps(data, indent=1, ensure_ascii=False) + "\n"
    json.loads(text)
    path.write_text(text, encoding="utf-8")
    if changed and path.resolve() == DATA.resolve():      # calendars are built from the real data file only
        sys.path.insert(0, str(ROOT / "tools"))
        import build_calendars
        build_calendars.main()
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"message={msg}\n")
    annotate(msg, report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
