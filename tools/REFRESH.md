# Fixtures refresh

`docs/fixtures.json` is refreshed automatically by the **Refresh fixtures** GitHub Action
(`.github/workflows/refresh-fixtures.yml`), which runs `tools/refresh_fixtures.py` on GitHub's own servers:

- **Monday to Thursday:** every 2 hours, 8am to midnight
- **Friday to Sunday:** every 30 minutes, 8am to midnight

No Claude session, computer or login is needed. (Until October 2026 this was done by a Claude
scheduled task following instructions in this file; that task is now paused.)

## What it reads

| Source | Page |
|---|---|
| Derry GAA, all the club's teams | https://derry.clubandcounty.com/fixtures-results/team/an-gleann/aff0a6a4-5212-3297-0b2c-1cf539ad1546/ |
| Derry GAA, all-county listing (results often appear here sooner) | https://derry.clubandcounty.com/fixtures-results/ |
| Ulster LGFA fixtures and results (ladies club championships) | https://ulsterladiesgaelic.com/fixtures/ and /results/ |

## What it does

1. Picks out every game involving An Gleann, Glen, Glen Res, Glen B, Glen C, Glen 2 or An Gleann II (never Glenullin).
2. Works out the team (`team_for`), short opponent name (`short_team`, `PLACES`), venue (`short_venue`), home/away and status.
3. Merges into `docs/fixtures.json`, matching on date + team + opponent, so the keys the site uses for live
   scores and club-set venues never change. A result, walkover or concession never turns back into a fixture,
   a real score is never replaced by 0-0, and games the sources no longer show are kept.
4. Rebuilds `docs/cal/*.ics` when games change, and commits ("Fixtures refresh: N added, M results updated").
   With no changes it still saves the "last checked" time about every 2 hours ("Fixtures checked: no changes").

It never touches Firebase (live scores, club-added games and teams, venues set for TBC games, scorer logins).

## Run it now / check it

GitHub repo > **Actions** > **Refresh fixtures** > **Run workflow**. Tick "Check only" to see what it would change
without saving. Each run's summary lists how many games it read from each source and what changed.

## If it goes wrong

- **Red run, "Nothing could be read from any source"**: the sites were down or blocked the request. Nothing was
  changed; the next run will try again.
- **Warning "no Derry GAA games read"**: Derry GAA's page layout changed. The parser is `parse_cc()` in
  `tools/refresh_fixtures.py`; `python3 tools/test_refresh.py` checks it.
- **A game under the wrong team, or an odd opponent name**: add the competition to `team_for()` or the club to
  `PLACES` in `tools/refresh_fixtures.py`, then fix that game in `docs/fixtures.json` by hand.
- **Workflows disabled**: GitHub pauses scheduled workflows after 60 days with no repository activity.
  Press **Enable workflow** on the Actions tab.
