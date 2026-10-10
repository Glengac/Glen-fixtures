# Fixtures refresh (run every two hours by a scheduled routine)

Refresh the An Gleann fixtures website (Watty Graham's GAC Glen, shown on the site as "An Gleann") with the latest fixtures and results from Derry GAA (as shown on derrygaa.ie) and Ulster LGFA. The site is a GitHub Pages site at https://glengac.github.io/Glen-fixtures/, served from this repository, Glengac/Glen-fixtures (website files in docs/). Live scores, club-added games, venues the club sets for TBC games, and scorer logins are stored separately in Firebase; do not touch them, and do not change any file other than docs/fixtures.json and docs/cal/.

THE RUN MUST END WITH A PUSH TO MAIN. Even when nothing changed, commit the new "updated" time with the message "Fixtures checked: no changes" and push it, because the site shows that time as "Fixtures last checked". Only skip the push if every source failed to load; then say so plainly. Keep the run short: the fetches listed below, at most one retry each. The repository's .claude/settings.json already allows fetching these sites.

## 1. Get up to date

In the repository root, run `git fetch origin main && git checkout main && git reset --hard origin/main`. Read docs/fixtures.json. Shape: {"updated": ISO string, "teams": [{id,name,group}], "games": [game, ...]}.

## 2. Fetch the sources with WebFetch

Do NOT ask WebFetch to quote pages verbatim (it then summarises and leaves games out). Instead ask for a table limited to a date window, with this prompt, filling in the date 14 days before today:

> Make a table of every game on this page involving An Gleann, An Gleann II or any Glen team (Glen, Glen Res, Glen B, Glen C, Glen 2; not Glenullin), fixtures and results, dated <DATE> or later. Columns: date, competition, round, home team, home score, time, away team, away score, venue. Include every such game, not a selection. If there are none, say so.

a. Derry GAA (all county games); derrygaa.ie's Fix & Res listing is loaded from these pages:
   - https://derry.clubandcounty.com/fixtures-results/team/an-gleann/aff0a6a4-5212-3297-0b2c-1cf539ad1546/ (all the club's teams)
   - https://derry.clubandcounty.com/fixtures-results/ (all-county listing; its results often appear sooner)
   Unplayed fixtures show 0-0. If the two pages disagree about a game, a real score beats 0-0.

b. Ulster LGFA (provincial ladies club championships): https://ulsterladiesgaelic.com/fixtures/ and https://ulsterladiesgaelic.com/results/ . The club appears as "Watty Grahams Glen (Derry)"; ask for a table of games involving that team with date, time, Team 1, Team 2, competition and venue (and scores on the results page).

## 3. Convert each of the club's games

{"d":"YYYY-MM-DD","t":"HH:MM" or null,"team":teamId,"comp":competition,"round":round or "","opp":opponent,"venue":venue,"ha":"H"|"A"|"N","st":"fixture"|"result"|"walkover"|"conceded","us":"G-P","them":"G-P","note":optional}

- us/them are always the club's score then the opponent's, whichever side the source lists first. Omit us/them for fixtures, walkovers and concessions.
- st: "fixture" if not yet played; "result" if played; "walkover" when the opponent conceded ("(C)" beside the opponent), note "<Opponent> conceded"; "conceded" when the club conceded, note "An Gleann conceded".
- comp: competition name without the round or year. For Ulster LGFA write it as "Ulster LGFA <Grade> Club Championship" (e.g. "Ulster LGFA Intermediate Club Championship"). round: tidy form such as "Semi-final", "Quarter-final", "Final", "Round 3", "Q1a", "Group 2 · Round 3", "Cup Division 2 · Quarter-final", "League Division 1 · Round 4" (use " · " between stage parts); use "" when the source gives no round. Never invent a round.
- team id, decided by competition and the club's team label:
  - sf Senior Football: O'Neills Senior Football Championship, Division 1 Football League (Glen / An Gleann).
  - rf Reserve Football: Senior Reserve championship, Division 1 Reserve Football League (Glen Res), but not Recreational competitions.
  - rec Recreational Reserves: any "Recreational Reserve" league or cup.
  - mf Minor Football: O'Neills U18 championships and U18 football leagues.
  - u16f U16 Football: B A Mullan Farms U16 championships, U16 Football League.
  - u14a U14 Football A: HSF Group U14A1 (An Gleann) and U14 League Div 1A. u14b U14 Football B: Glen B, U14A1B, U14 League Div 1B. u14c U14 Football C: Glen C, U14C, U14 League Div 3.
  - int Intermediate Ladies: Derry "Intermediate Championship" and "Intermediate Final", and Ulster LGFA Intermediate Club Championship.
  - mlf Minor Ladies: Derry generic "MINOR Championship" (write comp as "Minor Championship") and Ulster LGFA Minor Club Championship.
  - u16l U16 Ladies: Derry generic "U16 Championship" with Cup/Shield divisions.
  - u14l U14 Ladies (An Gleann) and u14l2 U14 Ladies 2 (Glen 2): Derry generic "U14 Championship" with Cup divisions.
  - cam Junior Camogie: camogie competitions for An Gleann II.
  - If a game fits none of these (for example Ulster LGFA Senior or Junior), add a new team to "teams" with a short lowercase id, a clear name such as "Senior Ladies", and group "Football", "Ladies football" or "Camogie".
- opp: short place name, e.g. "Sean O'Leary GAC Newbridge" -> "Newbridge", "Steelstown Brian Og's" -> "Steelstown", "St Oliver Plunkett's GAC, Greenlough" -> "Greenlough", "O'Donovan Rossa GAC" -> "Magherafelt", "CLG Roibeard Eiméid, Sleacht Néill" -> "Slaughtneil", "St Canice's GAC" -> "Dungiven", "John Mitchel's GAC, Claudy" -> "Claudy", "St Malachy's Castledawson" -> "Castledawson", "Eoghan Rua, Coleraine" -> "Eoghan Rua", "Burren (Down)" -> "Burren". Drop "Res", " 2", " B", " C", "(C)" suffixes and county names in brackets.
- venue: "Glen" -> "Watty Graham Park"; "Slaughtneil GAC" -> "Slaughtneil"; "St Colm's Ballinascreen" -> "Ballinascreen"; "St Malachys Castledawson" -> "Castledawson"; "Doire Colmcille GAC" -> "Doire Colmcille"; keep "Owenbeg" and other place names short; use "TBC" when not confirmed (an Ulster LGFA venue that only names a county is "TBC").
- ha: "H" when the venue is Watty Graham Park; "A" when the venue is the opponent's own ground; for Ulster LGFA games with venue TBC, "A" if the club is Team 2 and "H" if it is Team 1; otherwise "N" (Owenbeg, Celtic Park, another club's ground, finals days).
- Keep d, team and opp stable for a game once it is listed (the site uses them to attach a venue the club set for a TBC game).

## 4. Merge

Match on d + team + opp. Update matched games (time, venue, round, status, scores) and add new ones. Never turn a game that is already a result, walkover or conceded back into a fixture, and never replace a real score with 0-0 or remove its score because one page is lagging. If a fixture moved date, update the existing st "fixture" entry with the same team + opp + comp instead of adding a duplicate. Keep every existing game the sources no longer show (older history). Sort: fixtures by date ascending first, then all other games newest first. Set "updated" to the current Europe/London time in ISO 8601 with its UTC offset (e.g. 2026-10-09T08:50:00+01:00), on every run.

## 5. Write

Write docs/fixtures.json with json.dumps(data, indent=1, ensure_ascii=False) plus a trailing newline, check it parses, then run `python3 tools/build_calendars.py` from the repository root to rebuild docs/cal/*.ics.

## 6. Commit and push to main

Commit only docs/fixtures.json and docs/cal/ with a short message: "Fixtures refresh: N added, M results updated", or "Fixtures checked: no changes" when only the timestamp changed. Use git -c user.name="Claude" -c user.email="noreply@anthropic.com". End the message with a blank line then "Co-Authored-By: Claude <noreply@anthropic.com>". Fetch origin main first, then push to main (not a claude/ branch, and no pull request). If the push is rejected because main moved, rebase onto origin/main and push once more. Confirm the push with `git ls-remote origin refs/heads/main` matching your commit.

## 7. Report

Never invent games or scores. If one source can't be reached or returns nothing usable, keep that source's games as they are, say so, and still commit and push the rest and the new "updated" time. If pushing fails, report the exact error text. Finish with a short step-by-step list of what worked and what didn't, then a two or three line summary: games added, results updated, anything you couldn't place.
