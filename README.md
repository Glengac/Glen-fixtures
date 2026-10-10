# An Gleann fixtures & results

Fixtures, results and live scores for every Watty Graham's GAC An Gleann team.

- **Website files** are in `docs/` and are served by GitHub Pages (Settings > Pages > Deploy from a branch > `main` / `docs`).
- **Fixtures and results** live in `docs/fixtures.json`. A scheduled Claude task refreshes it every two hours (8am to midnight) from Derry GAA and Ulster LGFA.
- **Team calendars** (`docs/cal/*.ics`) are rebuilt from the fixtures with `python3 tools/build_calendars.py`. People subscribe to them from the Fixtures tab, and their calendar keeps itself up to date.
- **Live scores, team sheets, club-added games and venues set for TBC games** are stored in Firebase Realtime Database under `/live`. Anyone can read them; only admins and the logins listed under `/scorers` can change them. Several games can be live at once (`/live/matches`). The Firebase settings go in `docs/firebase-config.js`.
- **Scorers** are managed on the site: an admin signs in and taps **Manage scorers** at the bottom to create a login, send a password reset or remove someone.
- **Admins** are the main club admin (fixed in the rules and in `docs/app.js`) plus anyone set to `true` under `/admins`. Only the main club admin can make or remove admins, with **Make admin** / **Remove admin** on the Manage scorers screen. Removing an admin sets them to `false`, so they aren't re-added.

Database rules (Firebase, Realtime Database, Rules):

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "live": {
      ".read": true,
      ".write": "auth != null && (auth.uid === 'huUQRRNXqbQIk0spwd1xrh2rDi43' || root.child('admins').child(auth.uid).val() === true || root.child('scorers').child(auth.uid).exists())"
    },
    "scorers": {
      ".read": "auth != null && (auth.uid === 'huUQRRNXqbQIk0spwd1xrh2rDi43' || root.child('admins').child(auth.uid).val() === true)",
      ".write": "auth != null && (auth.uid === 'huUQRRNXqbQIk0spwd1xrh2rDi43' || root.child('admins').child(auth.uid).val() === true)",
      "$uid": { ".read": "auth != null && auth.uid === $uid" }
    },
    "admins": {
      ".read": "auth != null && (auth.uid === 'huUQRRNXqbQIk0spwd1xrh2rDi43' || root.child('admins').child(auth.uid).val() === true)",
      ".write": "auth != null && auth.uid === 'huUQRRNXqbQIk0spwd1xrh2rDi43'",
      "$uid": { ".read": "auth != null && auth.uid === $uid", ".validate": "newData.isBoolean()" }
    }
  }
}
```

## Scoring a game

1. Open the site, tap **Scorer sign-in** at the bottom, and sign in.
2. On the **Live** tab, pick the game, name the team, then tap **Set up live game**. To run another game at the same time, tap **Start another live game**; each game gets its own tab.
3. Tap **Throw-in** when the game starts, then tap Point (white flag), 2 points (orange flag) or Goal (green flag) for each score and pick the scorer.
   For a substitution, tap **Make a sub**, then who's coming off and who's going on. Subs show in the scores list and on the pitch, and are stored under each game's `subs` (separate from `events`, so they never count towards the score).
4. Use Half-time, Start 2nd half and Full-time as the game goes on. Every step can be undone, and any score or sub can be removed (tap its ✕ twice).
5. At full-time the score goes to Results and a copy of the game (timeline, subs, team sheet) is saved under `/live/reports/<key>`, listed in `/live/reportKeys`. On the Results tab that game gets a **Match centre** link; every result can make a square **Result graphic** for sharing.

If the signal drops at the pitch, scores entered on the scorer's phone are kept and sent when it reconnects.
