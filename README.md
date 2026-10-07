# Glen fixtures & results

Fixtures, results and live scores for every Watty Graham's GAC Glen team.

- **Website files** are in `docs/` and are served by GitHub Pages (Settings > Pages > Deploy from a branch > `main` / `docs`).
- **Fixtures and results** live in `docs/fixtures.json`. A scheduled Claude task refreshes it every morning from Derry GAA.
- **Team calendars** (`docs/cal/*.ics`) are rebuilt from the fixtures with `python3 tools/build_calendars.py`. People subscribe to them from the Fixtures tab, and their calendar keeps itself up to date.
- **Live scores and team sheets** are stored in Firebase Realtime Database under `/live`. Anyone can read them; only the scorer accounts named in the database rules can change them. The Firebase settings go in `docs/firebase-config.js`.

## Scoring a game

1. Open the site, tap **Scorer sign-in** at the bottom, and sign in.
2. On the **Live** tab, pick the game, name the team, then tap **Set up live game**.
3. Tap **Throw-in** when the game starts, then tap Point (white flag), 2 points (orange flag) or Goal (green flag) for each score and pick the scorer.
4. Use Half-time, Start 2nd half and Full-time as the game goes on. Every step can be undone, and any score can be removed.

If the signal drops at the pitch, scores entered on the scorer's phone are kept and sent when it reconnects.
