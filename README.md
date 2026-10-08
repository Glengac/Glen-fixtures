# Glen fixtures & results

Fixtures, results and live scores for every Watty Graham's GAC Glen team.

- **Website files** are in `docs/` and are served by GitHub Pages (Settings > Pages > Deploy from a branch > `main` / `docs`).
- **Fixtures and results** live in `docs/fixtures.json`. A scheduled Claude task refreshes it every two hours (8am to midnight) from Derry GAA and Ulster LGFA.
- **Team calendars** (`docs/cal/*.ics`) are rebuilt from the fixtures with `python3 tools/build_calendars.py`. People subscribe to them from the Fixtures tab, and their calendar keeps itself up to date.
- **Live scores, team sheets, club-added games and venues set for TBC games** are stored in Firebase Realtime Database under `/live`. Anyone can read them; only the club admin and the logins listed under `/scorers` can change them. Several games can be live at once (`/live/matches`). The Firebase settings go in `docs/firebase-config.js`.
- **Scorers** are managed on the site: the club admin signs in and taps **Manage scorers** at the bottom to create a login, send a password reset or remove someone.

## Scoring a game

1. Open the site, tap **Scorer sign-in** at the bottom, and sign in.
2. On the **Live** tab, pick the game, name the team, then tap **Set up live game**. To run another game at the same time, tap **Start another live game**; each game gets its own tab.
3. Tap **Throw-in** when the game starts, then tap Point (white flag), 2 points (orange flag) or Goal (green flag) for each score and pick the scorer.
4. Use Half-time, Start 2nd half and Full-time as the game goes on. Every step can be undone, and any score can be removed.

If the signal drops at the pitch, scores entered on the scorer's phone are kept and sent when it reconnects.
