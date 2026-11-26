# Artfolio

**Live: [myartfolio.art](https://myartfolio.art)**
**See mine: [myartfolio.art/u/ninamclark](https://myartfolio.art/u/ninamclark)**

Artfolio is a portfolio builder for artists. You make an account, drop in your photos, add a title and description for each piece, pick a layout and a color palette, and you get a link to share. Your page lives at `myartfolio.art/u/yourname`.

## Why I made it

A lot of my friends are artists, and they all need somewhere to send people when they apply for jobs or want to show their work. Instagram doesn't really work as a portfolio. Even the "easy" site builders like Wix take a while to set up, with templates, menus, pages and publishing. So a lot of my friends end up putting their work in a Google Slides deck.

I wanted something in between. Artfolio is as bare-bones as I could make it: there are no pages to design and nothing to configure. You add your work and everything lives in one place at one link, but it still looks much more polished than a slide deck.

My rule while building it was that if an artist has to stop and figure something out, it gets cut.

## What it does

- **One editing page with a live preview.** Your photos, layout and colors sit next to the real portfolio, and it updates the moment you change something.
- **6 layouts and 4 color palettes.** A dot slider picks each one. Two of the layouts are animated: a 3D carousel and a full-screen spotlight.
- **Easy uploads.** Drag in several photos at once. They're resized in the browser so pages load fast.
- **Organizing your work.** Multiple images per piece, drag to reorder, and collections that give visitors filter buttons.
- **Draft or published.** New sites start private, and one switch makes them public.
- **Password reset by email**, so nobody gets locked out.

## How I built it

I built this almost entirely with AI coding tools, and I wanted to use them in a way I could trust. I made the decisions about what to build and what counted as good, and I used the AI to do the typing and to check its own work.

I used the idea behind Google's [Elephant-Goldfish Model](https://opensource.googleblog.com/2026/10/introducing-elephant-goldfish-model-plugin.html), applied by hand. One long session held the whole design and every decision I'd made. Then I had separate fresh sessions review the code, because they hadn't seen it being written and couldn't share its blind spots.

How it went:

1. **I set the direction.** The user was a non-technical artist, I wanted real accounts and not a mockup, and I wanted no dependencies so it stays easy to run and check. Everything else came from there: switchable templates, the single editing page with the two sliders, and which two layouts got the animations.
2. **I rejected a lot of the first drafts.** The first color palettes (especially the loud one) and the first fonts looked amateur, so they were redone. It now uses four calmer palettes and the Inter and Fraunces fonts.
3. **I had the AI attack its own work.** I asked it to audit the app as harshly as it could. It found real problems in its own code, like weak rate limiting, photo metadata leaking location data, and look-alike usernames.
4. **A fresh reviewer tried to break it.** It wrote small exploit scripts and confirmed 44 issues, including some the tests had missed. All of them were fixed with new tests, and the exploits were re-run to confirm they no longer worked. That review is also why password reset now goes through email and not a recovery key you could lose.
5. **I checked it by actually using it.** Besides the tests, I drove the real app in a browser and uploaded real photos to make sure the metadata was removed and the images looked the same.

The main thing I took away is that AI code looks finished well before it's correct. What helped was being specific about what I wanted, making the model try to break its own work, asking for proof instead of reassurance, and being honest about what's left.

## Under the hood

- Node.js with no npm dependencies: just the built-in `http`, `crypto` and `node:sqlite`, with plain HTML, CSS and JavaScript on the front end
- SQLite for the database, with automatic migrations
- 46 automated tests (`npm test`)
- Hosted on a single AWS EC2 server behind Caddy, which handles HTTPS

## Security

I spent a lot of the time on this. Passwords are hashed with scrypt, and logins and signups are rate limited. Password reset codes are one-time and expire after 20 minutes. Uploaded photos are rebuilt so that location and camera data is removed, and drafts and hidden pieces are not served to anyone but the owner. The CSP forbids inline scripts, and all user text is escaped.

Limits I know about:
- `node:sqlite` is still marked experimental by Node.
- Image cleaning works on the file bytes rather than re-encoding, so the picture itself is kept exactly as uploaded.
- There is no breached-password check.

## Running it yourself

You need Node 22.5 or newer. Run `npm start` and open `http://localhost:3000`. For a real deployment, set `NODE_ENV=production`, `PUBLIC_ORIGIN`, `TRUST_PROXY`, `DATA_DIR`, and `SMTP_URL` and `MAIL_FROM` for email. Without email settings, emails are saved to `data/outbox/` instead of sent.

## What I'd add next

Custom domains for artists, two-factor sign-in, choosing a cover image per piece, and visitor analytics.
