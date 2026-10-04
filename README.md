# Group Draw Board

A football tournament group draw for a school: teams go in the pot, you tap one,
it spirals through the air and drops into Group A or Group B.

## Running it

No build step, no server needed. Double-click `index.html`, or drop the folder on
any static host (GitHub Pages, Netlify, a school web server) and open the URL.

```
index.html    page markup
styles.css    design tokens, layout, print stylesheet
app.js        state, persistence, the draw and its animation
```

## How it works

- **The pot** holds every team you enter. Tap one to draw it; tap a team on a
  board to send it back.
- **The draw is blind.** A team can land in either group until one board fills
  up, so the result is unknown while the ball is in the air. Nothing on screen
  gives it away: the ball flies in the pitch colour rather than a group colour,
  both boards show the same `?` slot, and the counts do not move until it lands.
  Each board holds at most half the teams, which is what keeps the two groups
  within one team of each other.
- **Make the draw** empties the pot one team at a time, one flight per team.
- **Shuffle** reorders the pot. **Undo** (or Ctrl/Cmd+Z) steps back through the
  last 40 changes.
- Group names, the tournament name and the boards are all editable in place.
- **Print** gives you a clean two-column sheet to pin on a wall; **Copy groups**
  puts the result on the clipboard as plain text.

## Where the data lives

Everything — teams, the draw in progress, group names, theme and sound settings —
is stored in `localStorage` under the key `group-draw-board.v1`. It survives
closing the tab and reopening the app later.

That storage is per browser, per device: a list entered on a laptop will not
appear on a phone. If the draw needs to be shared across devices, that needs a
server (or a hosted version with a shared database) rather than local storage.

Private windows and browsers with site data blocked will refuse to store it; the
app notices and says so in the footer rather than silently losing the list.

## Changing the number of groups

Groups are data-driven. `GROUPS` at the top of `app.js` lists the board letters,
`blank()` holds their default names, and `styles.css` maps each letter to an
accent colour (`.board[data-group="A"]`). Adding a Group C means adding to those
three places and nothing else — the balancing, the slot projection and the
fixture counts all read from the list.
