"""Checks tools/refresh_fixtures.py against pages shaped like Derry GAA (Club & County) and Ulster LGFA.

Builds the pages from the games already in docs/fixtures.json (with Derry's long club names),
so re-reading them must change nothing; then checks that real changes are picked up.

Run from the repository root:  python3 tools/test_refresh.py
"""
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import refresh_fixtures as rf  # noqa: E402

LONG = {
    "Newbridge": "Sean O'Leary GAC Newbridge", "Kilrea": "Kilrea Pearses", "Glenullin": "Glenullin",
    "Steelstown": "Steelstown Brian Og's", "Bellaghy": "Wolfe Tones Bellaghy", "Magherafelt": "O'Donovan Rossa GAC",
    "Slaughtneil": "CLG Roibeard Eiméid, Sleacht Néill", "Dungiven": "St Canice's GAC", "Claudy": "John Mitchel's GAC, Claudy",
    "Castledawson": "St Malachy's Castledawson", "Eoghan Rua": "Eoghan Rua, Coleraine", "Burren": "Burren (Down)",
    "Greenlough": "St Oliver Plunkett's GAC, Greenlough", "Ballinascreen": "St Colm's Ballinascreen", "Lavey": "Erin's Own Lavey",
    "Loup": "St Patrick's Loup", "Banagher": "St Mary's Banagher", "Ballinderry": "Ballinderry Shamrocks",
    "Desertmartin": "St Martin's Desertmartin", "Doire Colmcille": "Doire Colmcille", "Faughanvale": "Faughanvale GAC",
    "Glack": "Glack", "Lissan": "Lissan", "Sean Dolans": "Sean Dolan's", "Swatragh": "Swatragh", "Ballerin": "Sarsfields Ballerin",
}
VENUE_RAW = {"Watty Graham Park": "Glen", "Slaughtneil": "Slaughtneil GAC", "Ballinascreen": "St Colm's Ballinascreen",
             "Castledawson": "St Malachys Castledawson", "Doire Colmcille": "Doire Colmcille GAC"}
LABEL = {"rf": "Glen Res", "rec": "Glen Res", "u14b": "Glen B", "u14c": "Glen C", "u14l2": "Glen 2", "cam": "An Gleann II"}
SPORT = {"int": "ladies_football", "mlf": "ladies_football", "u16l": "ladies_football", "u14l": "ladies_football",
         "u14l2": "ladies_football", "cam": "camogie"}
RAW_COMP = {"Minor Championship": "MINOR Championship"}
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def heading(iso):
    from datetime import date
    d = date.fromisoformat(iso)
    suf = "th" if 11 <= d.day <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(d.day % 10, "th")
    return f"{DAYS[d.weekday()]} {d.day}{suf} {d.strftime('%b %Y')}"


def raw_round(r):
    return " - ".join(p.replace("Semi-final", "Semi Final").replace("Quarter-final", "Quarter Final") for p in r.split(" · "))


def block(g, links=True):
    glen = LABEL.get(g["team"], "An Gleann")
    opp = LONG.get(g["opp"], g["opp"])
    us, them = g.get("us", "0-0"), g.get("them", "0-0")
    if g["st"] == "walkover":
        opp, us, them = opp + " (C)", "0-0", "CONC"
    home_first = g["ha"] != "A"
    home, away = (glen, opp) if home_first else (opp, glen)
    hs, as_ = (us, them) if home_first else (them, us)
    comp = RAW_COMP.get(g["comp"], g["comp"]) + (" 2026 - " + raw_round(g["round"]) if g["round"] else " 2026")
    venue = VENUE_RAW.get(g["venue"], g["venue"])
    time = g["t"] or "TBC"
    if g["st"] in ("walkover", "conceded"):
        time = "Conceded"
    sport = SPORT.get(g["team"], "football")
    a = (lambda text, href: f'<a href="{href}">{text}</a>') if links else (lambda text, href: f"<span>{text}</span>")
    return (f'<div class="fx">{a(comp, f"https://derry.clubandcounty.com/fixtures-results/{sport}/club/x/c/6ebd6106-f1d1-430b-b0d7-27a78d469151/")}'
            f'<div>{a(home, "https://derry.clubandcounty.com/fixtures-results/team/h/1/")}<span>{hs}</span><span>{time}</span>'
            f'<span>{as_}</span>{a(away, "https://derry.clubandcounty.com/fixtures-results/team/a/2/")}</div>'
            f'<p><strong>Venue:</strong> {a(venue, "#")}</p></div>')


def page(games, links=True, extra=""):
    by = {}
    for g in games:
        by.setdefault(g["d"], []).append(g)
    body = "".join(f"<h3>{heading(d)}</h3>" + "".join(block(g, links) for g in gs) for d, gs in sorted(by.items(), reverse=True))
    return (f"<html><body><nav><a href='/fixtures-results/football/club/senior/'>SENIOR</a></nav><h1>Team: An Gleann</h1>"
            f"{extra}{body}<button>Load more Results</button><table><tr><td>An Gleann</td><td>3-4</td></tr></table></body></html>")


def run(data, pages, today="2026-10-20", dry=False):
    tmp = Path(tempfile.mkdtemp())
    (tmp / "fixtures.json").write_text(json.dumps(data), encoding="utf-8")
    args = []
    for k, html in pages.items():
        (tmp / f"{k}.html").write_text(html, encoding="utf-8")
        args += ["--html", f"{k}={tmp / (k + '.html')}"]
    cmd = [sys.executable, str(ROOT / "tools" / "refresh_fixtures.py"), "--data", str(tmp / "fixtures.json"), "--today", today] + args
    if dry:
        cmd.append("--dry-run")
    p = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    return p, json.loads((tmp / "fixtures.json").read_text(encoding="utf-8"))


def main():
    orig = json.loads((ROOT / "docs" / "fixtures.json").read_text(encoding="utf-8"))
    derry_games = [g for g in orig["games"] if not g["comp"].startswith("Ulster LGFA")]

    # 1. Re-reading what's already there changes nothing (with and without links)
    for links in (True, False):
        p, out = run(copy.deepcopy(orig), {"derry": page(derry_games, links)}, dry=True)
        assert p.returncode == 0, p.stderr
        assert "Fixtures checked: no changes" in p.stdout, p.stdout
        n = [l for l in p.stdout.splitlines() if l.startswith("derry:")][0]
        assert f"{len(derry_games)} involving the club" in n, (n, len(derry_games))
        print(f"no-change round trip ({'links' if links else 'plain text'}): OK - {n}")

    # 2. Real changes: U16 final result, a new fixture, a time change, a walkover
    changed = copy.deepcopy(derry_games)
    final = next(g for g in changed if g["st"] == "fixture")
    final.update(st="result", us="2-11", them="1-9")
    new_fix = {"d": "2026-10-25", "t": "14:00", "team": "sf", "comp": "Division 1 Football League", "round": "Round 15",
               "opp": "Lavey", "venue": "Watty Graham Park", "ha": "H", "st": "fixture"}
    new_away = {"d": "2026-10-28", "t": "19:30", "team": "u14b", "comp": "HSF Group U14A1B Football Championship",
                "round": "Semi-final", "opp": "Castledawson", "venue": "Castledawson", "ha": "A", "st": "fixture"}
    new_wo = {"d": "2026-10-18", "t": None, "team": "rec", "comp": "Recreational Reserve League", "round": "Round 16",
              "opp": "Banagher", "venue": "Watty Graham Park", "ha": "H", "st": "walkover"}
    p, out = run(copy.deepcopy(orig), {"derry": page(changed + [new_fix, new_away, new_wo])})
    assert p.returncode == 0, p.stderr + p.stdout
    games = out["games"]
    f2 = next(g for g in games if g["d"] == final["d"] and g["team"] == "u16f")
    assert f2["st"] == "result" and f2["us"] == "2-11" and f2["them"] == "1-9", f2
    nf = next(g for g in games if g["d"] == "2026-10-25")
    assert (nf["team"], nf["opp"], nf["venue"], nf["ha"], nf["round"], nf["st"]) == ("sf", "Lavey", "Watty Graham Park", "H", "Round 15", "fixture"), nf
    na = next(g for g in games if g["d"] == "2026-10-28")
    assert (na["team"], na["opp"], na["venue"], na["ha"], na["round"]) == ("u14b", "Castledawson", "Castledawson", "A", "Semi-final"), na
    nw = next(g for g in games if g["d"] == "2026-10-18" and g["team"] == "rec")
    assert nw["st"] == "walkover" and nw["note"] == "Banagher conceded" and "us" not in nw, nw
    assert len(games) == len(orig["games"]) + 3, len(games)
    assert games[0]["st"] == "fixture" and games[0]["d"] == "2026-10-25", games[:2]
    assert out["updated"] != orig["updated"]
    assert "Fixtures refresh: 3 added, 1 results updated" in p.stdout, p.stdout
    print("changes picked up: OK -", [l for l in p.stdout.splitlines() if l.startswith("Fixtures")][0])

    # 3. A lagging page never undoes a result; the all-county page's real score wins over 0-0
    lag = copy.deepcopy(derry_games)
    sf_semi = next(g for g in lag if g["team"] == "sf" and g["round"] == "Semi-final")
    sf_semi.pop("us"), sf_semi.pop("them"); sf_semi["st"] = "fixture"
    p, out = run(copy.deepcopy(orig), {"derry": page(lag)}, dry=True)
    assert "Fixtures checked: no changes" in p.stdout, p.stdout
    print("lagging page keeps the result: OK")

    # 4. Ulster LGFA: fixtures list layout and a result
    lgfa_fix = ("<html><body><a href='https://ulsterladiesgaelic.com/league/219943'>Intermediate Club</a>"
                "<a href='https://ulsterladiesgaelic.com/league/219956'>Minor Club</a>"
                "<h4><a href='https://ulsterladiesgaelic.com/league/219956'>01/11/2026</a></h4>"
                "<ul><li>01 Nov 2026</li><li>14:00</li><li>Watty Grahams Glen (Derry)</li><li>V</li>"
                "<li>Clann Éireann (Armagh)</li><li>Armagh</li><li><a href='#'>More</a></li></ul>"
                "<h4><a href='https://ulsterladiesgaelic.com/league/219943'>24/10/2026</a></h4>"
                "<ul><li>24 Oct 2026</li><li>14:00</li><li>Naomh Padraig (Donegal)</li><li>V</li><li>Mayobridge (Down)</li>"
                "<li>Donegal</li><li><a href='#'>More</a></li></ul></body></html>")
    lgfa_res = ("<html><body><h4><a href='https://ulsterladiesgaelic.com/league/219943'>Intermediate Club</a></h4>"
                "<ul><li>11 Oct 2026</li><li>11:30</li><li>Burren (Down)</li><li>4-9</li><li>1-4</li>"
                "<li>Watty Grahams Glen (Derry)</li><li>Burren</li></ul></body></html>")
    p, out = run(copy.deepcopy(orig), {"derry": page(derry_games), "lgfa-fixtures": lgfa_fix, "lgfa-results": lgfa_res})
    assert p.returncode == 0, p.stderr + p.stdout
    lg = next(g for g in out["games"] if g["d"] == "2026-11-01")
    assert (lg["team"], lg["opp"], lg["venue"], lg["ha"], lg["comp"]) == (
        "mlf", "Clann Éireann", "TBC", "H", "Ulster LGFA Minor Club Championship"), lg
    burren = [g for g in out["games"] if g["opp"] == "Burren"]
    assert len(burren) == 1 and burren[0]["us"] == "1-4", burren
    assert "Fixtures refresh: 1 added, 0 results updated" in p.stdout, p.stdout
    print("Ulster LGFA fixture added, existing result matched: OK")

    # 5. Nothing readable -> fails and writes nothing
    p, out = run(copy.deepcopy(orig), {"derry": "<html><body>Site down</body></html>"})
    assert p.returncode == 1 and out == orig, p.stdout
    print("unreadable source leaves data alone: OK")

    # 6. Recent check and no changes -> nothing written (no needless commits)
    fresh = copy.deepcopy(orig)
    from datetime import datetime
    fresh["updated"] = datetime.now(rf.LONDON).replace(microsecond=0).isoformat()
    p, out = run(fresh, {"derry": page(derry_games)})
    assert out == fresh, "wrote despite nothing to do"
    print("no needless rewrite: OK")
    print("ALL OK")


if __name__ == "__main__":
    main()
