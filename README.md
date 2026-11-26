# Artfolio

**The fastest way for an artist to get a real portfolio online.** Sign up, drop in your photos, add a few words, pick a look, and share one link. One editing page with a live preview: change the layout or colors and the real portfolio updates instantly.

**Live site: <!-- TODO: add your deployed URL -->**

<!-- TODO: add 2-3 screenshots or a short GIF here (the layout slider with the live preview is the best shot) -->

## Why I built it
A lot of my friends are artists, and they all hit the same problem: they need a place to send people for jobs, applications and commissions. Instagram is not a portfolio, and even the "easy" site builders like Wix take real time to set up: templates, menus, pages, settings, publishing. So many of them end up doing what a surprising number of artists do, which is putting their work in a Google Slides deck.

Artfolio is the gap between those two. It is deliberately as bare-bones as possible: no pages to design, no menus to configure. You add photos and descriptions, choose one of six layouts and one of four color palettes, and everything lives in one place at one link. It is still far more polished than a slide deck, with real layouts, a lightbox, collections, and a site that works on a phone.

The design rule behind every decision was: *if an artist has to stop and figure something out, cut it.*

## How it was built: AI-assisted engineering, with verification
Artfolio is a full-stack app (accounts, uploads, image processing, email, database migrations) with **zero runtime dependencies**: Node's built-in `http`, `crypto` and `node:sqlite`, plus plain HTML/CSS/JS on the front end. It was built almost entirely by directing AI coding tools. I did not treat the AI as an oracle. I treated it as a fast, capable junior engineer and kept the judgment for myself: what to build, what good looks like, and what counts as done.

**1. Design first, with the human in charge.** I defined the user (non-technical artists), the scope (real accounts, not a mockup) and the hard constraint (no dependencies, so it is easy to run and to audit). The product evolved through my decisions: toggleable templates, then a single editing page with a dot slider for layouts and a second for colors, a live preview, and which two layouts deserved to be the animated "premium" ones.

**2. A long-context builder and fresh-context critics.** The workflow follows the idea behind Google's [Elephant-Goldfish Model](https://opensource.googleblog.com/2026/10/introducing-elephant-goldfish-model-plugin.html) (EGM) for AI-assisted development: keep one long, context-rich session that holds the design intent and project history (the "elephant"), and use stateless, zero-context sessions to critique the work, because they share none of its blind spots (the "goldfish"). My build session carried the product vision and every decision. The reviews ran in separate sessions that had never seen the code being written and could only judge what was in front of them. I applied the pattern by hand rather than through Google's plugin, which targets Antigravity.

**3. Adversarial self-review.** I asked the model to audit its own work as harshly as it could: how data is stored, how passwords are protected, whether duplicate names are blocked. It found real gaps in its own code (weak rate limiting, image metadata leaks, look-alike usernames, password hashing that could block the server), and each fix shipped with a test.

**4. Independent review with proof-of-concept exploits.** A fresh reviewer read every file, ran the test suite and wrote exploit scripts against a throwaway copy of the server. It confirmed 44 findings, including several the tests had missed: parallel requests skipping rate limits, an attacker locking a real user out of their account, overlapping uploads leaking disk space, and gaps in the image cleaner. All 44 were fixed, each with a new test, and the exploit scripts were re-run to confirm the attacks now fail. The review also changed a product decision: one-time recovery keys (which a user can lose) were replaced with email-based password reset.

**5. Taste is a human job.** I rejected the first color palettes (especially the loud "Bold" one) and the first fonts as unprofessional. Each rejection led to a concrete redesign: four calm palettes (Chalk, Ink, Sage, Midnight), then self-hosted Inter and Fraunces so the site looks the same on every device.

**6. Verification over trust.** Tests do not replace looking. The app was also driven in headless Chrome through the real UI (signup, email confirmation, upload, logout and login, reset link), and real image files were round-tripped to confirm the pixels survive while the metadata does not.

**What this process taught me.** AI-generated code looks finished long before it is correct. The valuable skills are specifying clearly, forcing the model to attack its own output, demanding evidence (reproduced bugs, failing-then-passing tests) instead of assurances, and being honest about what remains. Those limits are listed below.

### By the numbers
- 46 automated integration tests (`npm test`)
- About 3,800 lines across server, libraries, front end and tests, with no npm dependencies
- 44 independently confirmed review findings, all fixed and re-tested
- 6 layouts and 4 palettes, switchable live

## Features
- **Live editor.** Photos, layout and colors sit beside the real portfolio, which updates the moment you change anything. A 6-dot slider picks the layout and a 4-dot slider picks the color palette (click, drag or use arrow keys)
- **6 layouts:** Gallery, Grid, Editorial, Studio, plus two animated ones: **3D Carousel** (cover-flow you drag, swipe or arrow through) and **Spotlight** (full-screen pieces with a slow reveal, parallax and a side dot-nav). Reduced-motion preferences are respected
- **4 palettes:** Chalk, Ink, Sage, Midnight
- **Easy uploads.** Drag-and-drop multi-photo upload (JPG, PNG, WebP, GIF). Photos are resized in the browser before upload (2400px full, 720px thumbnail), transparency is kept, and formats like HEIC and AVIF are converted
- **Organization.** Multiple images per piece, autosaving titles and descriptions, drag-to-reorder (with buttons for keyboard and touch), collections that give visitors filter buttons, and per-piece hide
- **Draft or published.** New sites start private; one switch makes them public
- **Accounts.** Sign in with username or email. Forgot your password? A one-time code arrives by email, with a link that fills it in
- **Accessible lightbox.** Arrow keys, Esc, swipe, focus trap
- **Server-rendered public page** with Open Graph tags (so links preview nicely when shared) and a strict Content-Security-Policy

## Security design
- **Passwords:** scrypt (N=2^15), per-user salt, Unicode-normalized; old hashes upgrade on next login. Minimum 10 characters; common passwords and ones containing the username are refused. Changing or resetting a password signs out every other device and emails a notice.
- **Rate limits** are applied before any slow work, so parallel requests cannot slip past them. They count failures only, per IP (IPv6 grouped by /64), per account and per account+IP, plus signup, reset-email and code-guess limits.
- **Lockout protection:** a browser that has signed in to an account before is recognized with a device cookie, so someone hammering your account from elsewhere cannot lock you out. A new browser can always use the email reset.
- **No account enumeration:** logins for unknown names skip the password hash (so floods of made-up names cannot clog the server) and are padded to the same response time. Password-hashing work is capped per client.
- **Password reset:** 8-character one-time codes, stored hashed, valid 20 minutes, dead after 5 wrong tries or one use. Only confirmed addresses get them, and the "send me a code" answer is identical whether or not the address has an account.
- **Uploads:** identified by content and rewritten from an allowlist (only what is needed to draw the picture, plus the color profile and JPEG orientation). EXIF/GPS, XMP, comments, embedded thumbnails and vendor data are dropped. Canvas, every frame and every bitstream are size-checked, and animations are capped. Stored under random names with mode 600, per-user quota, at most 2 uploads at once per user, and files no database row points to are swept hourly.
- **Privacy:** sites start as drafts. Drafts and hidden works (and their image files) return 404 to everyone but the owner. Public images are served with `no-cache` and an ETag, so hiding or deleting takes effect on the next view.
- **Names:** usernames and display names are checked against confusable look-alikes (e.g. rn/m, Cyrillic a), reserved words, invisible or blank characters and mixed scripts.
- **Web basics:** HttpOnly, SameSite=Lax cookies (`__Host-` and Secure in production), CSRF protection with a custom header, a CSP that forbids inline scripts, HTML-escaped output, parameterized SQL, strictly validated emails (nothing can be smuggled into mail headers or `mailto:` links).
- **Visibility:** the Account tab shows recent activity (last 100 events, kept 90 days, repeated failed sign-ins grouped), storage use, and can sign out other devices.

### Honest limits
- `node:sqlite` is still marked experimental by Node.
- Rate limits live in memory in one process: a restart clears them and multiple instances do not share them.
- Lose access to both your email and your password and the account cannot be recovered. There is no breached-password (HIBP) lookup.
- In-app limits slow attackers but cannot stop a large distributed attack; a CDN or WAF in front handles that.
- Image cleaning is byte-level, not a re-encode, so pixel data is kept as uploaded.
- Email sending was tested against a fake mail server, not a live provider.
- Backups are not automatic: schedule `npm run backup` and copy them off the machine.

## Deployment configuration
The app is a single Node 22.5+ process with a SQLite file and an uploads folder. Settings are environment variables:
- `PUBLIC_ORIGIN`: the site's public address, e.g. `https://artfolio.example.com`. Used for links in emails and share previews
- `NODE_ENV=production`: Secure `__Host-` cookies, and (with `TRUST_PROXY`) redirect from HTTP to HTTPS
- `TRUST_PROXY=N`: number of reverse proxies in front of the app (0 = none). Needed so rate limits see real client IPs. Set it wrong and IPs can be spoofed (too high) or everyone shares one IP (too low)
- `DATA_DIR`: where the database and uploads live (put this on a persistent disk; created private, mode 700/600)
- **Email:** `SMTP_URL` and `MAIL_FROM`. The server refuses to start in production without `SMTP_URL`. Examples: `smtps://USER:PASS@smtp.example.com:465` or `smtp://USER:PASS@smtp.example.com:587` (STARTTLS). URL-encode special characters in the password. Any SMTP provider works. Set up SPF/DKIM for the sending domain so resets do not land in spam
- Optional: `PORT`, `USER_QUOTA_MB` (default 500), `MAX_SIGNUPS_PER_HOUR` (default 100), `HASH_CONCURRENCY` (default 4), `MAX_PARALLEL_UPLOADS` (default 24), `HSTS_INCLUDE_SUBDOMAINS=1`
- Database upgrades run automatically on start, in one transaction

## Fonts
Inter (UI and body text) and Fraunces (display headings on the Sage and Midnight looks) are self-hosted from `public/fonts/`, so no request goes to Google. Both are SIL Open Font License; the license text is included.

## Ideas for next steps
Custom domains, two-factor sign-in, per-piece cover selection, AI-assisted titles and alt text, visitor analytics.
