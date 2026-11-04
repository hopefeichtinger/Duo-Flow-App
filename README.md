# Duo Flow

See which studio classes your friends are taking and book the same one. Members approve who can see their schedule, and can hide it at any time.

This is a working web app (phone-friendly) with accounts, a database, and server-side privacy rules. It is a **companion app**: it does not connect to CorePower's systems. Class times are sample data for CorePower Chicago (Lakeview, Lincoln Park, Old Town).

## Run it

Needs [Node.js](https://nodejs.org) 22.13 or newer. No packages to install.

```
node server.js          # then open http://localhost:3000
node seed.js            # optional: demo friends. Sign in as demo@example.com / password123
node test.js            # privacy and booking tests
```

Run `seed.js` before or after starting the server, then sign in as `demo@example.com` to see friends already booked into classes. To try it with two real accounts, sign up twice in two browsers and add each other by email.

Data is stored in `data/duoflow.db` (SQLite). Back up that folder.

## Adding real classes

Open the **Me** tab and scroll to **Add your classes**:

- **Add one class** by date, time, class name, and studio location.
- **Import a file**: choose a calendar export (`.ics` from Google Calendar or Apple Calendar) or a CSV with the headers `date, time, class, location`. You get a preview and choose which rows to add, so non-class events stay out. Classes that match the sample studio schedule (same studio and time) book that class. Anything else becomes a class that only you and your friends can see.

Calendar events in UTC are converted to Chicago time, and events with another time zone are read as Chicago wall-clock time. Repeating events add only the next occurrence. All-day events are skipped.

## How privacy works

All rules are enforced on the server, never in the browser.

| Setting | A friend sees |
| --- | --- |
| Full schedule | Class, time and location of each class you booked |
| Busy only | That you are booked at that time, nothing else |
| Hidden (default for new friends) | Nothing |
| Hide from everyone | Nothing, for every friend, overriding the above |
| Private class | That one class is hidden, even from Full friends |

Sharing is per direction: you choosing to share with a friend does not show you their schedule.

## Putting it online

Host it somewhere that gives you a persistent disk and HTTPS (for example Fly.io, Render, or Railway) and set these:

- `SECRET`: a long random string used to sign login tokens
- `DATA_DIR`: a folder on the persistent disk
- `PORT`: provided by most hosts
- `NODE_VERSION`: 22.14.0 or newer on Render (the app needs Node 22.13+)
- `RESEND_API_KEY`, `MAIL_FROM`, `BASE_URL`: for email, see below

## Email: verification and password reset

- **Confirming an email.** After sign-up, members get a link (valid 24 hours). Until they tap it they can use the schedule, but they can't send friend requests and other members can't find them by email. This stops someone signing up with another person's address.
- **Forgot password.** A link valid for 1 hour, usable once. Using it signs out every other device and also confirms the email. The answer is the same whether or not the address has an account.
- Links carry their token after a `#`, so it never appears in server logs. Only a hash of each token is stored.
- **Limits.** One resend a minute per member, 4 emails an hour to any one address, and 60 an hour overall (`MAIL_HOURLY_CAP`), so the app can't be used to flood an inbox or burn your email quota.

Email goes out through [Resend](https://resend.com) (no extra packages). Set:

- `RESEND_API_KEY`: your API key. Setting it turns email verification on.
- `MAIL_FROM`: for example `Duo Flow <hello@yourdomain.com>`. **The address must be on a domain you have verified in Resend.** Resend's `onboarding@resend.dev` test sender only delivers to the email on your own Resend account, so friends won't receive anything from it.
- `BASE_URL`: the public address, such as `https://duo-flow.onrender.com`. Render sets `RENDER_EXTERNAL_URL` automatically, which is used if `BASE_URL` is not set.
- `REQUIRE_VERIFY`: `1` or `0` to override. The default is on when `RESEND_API_KEY` is set and off otherwise.

With no `RESEND_API_KEY`, emails are printed in the server log instead of sent (handy locally; on a host you can copy a link from the log). Resend's free plan allows 100 emails a day, 3,000 a month, at the time of writing.

## Notifications

A bell in the header shows an unread count. Members are told when:

- someone sends them a friend request,
- someone accepts their request (with a nudge to choose what that friend sees), and
- a friend books a class they are already booked into.

Notifications respect privacy every time the list loads, not just when the event happens. A "friend booked your class" alert only appears while that friend shares their **Full schedule** with you, hasn't hidden everything, hasn't made the class private, and hasn't cancelled. If any of that changes, the alert disappears. Cancelling a booking or removing a friend clears their alerts. These are in-app only; there are no push notifications or notification emails yet.

## Before real members use it

- **Studio schedule.** `ensureClasses()` in `server.js` still generates the sample CorePower schedule. Members can add and import their real classes, but a real schedule feed or a CSV from the studio would let everyone book from the same list.
- **Duplicate member classes.** Two friends who each add the same real class will have two separate copies (matched only when it fits the sample schedule). They still see each other as busy at that time.
- **Push notifications and notification emails** are not built. Alerts appear in the app when it is opened or refreshed (the bell checks every minute while the app is open).
- **Changing your password while signed in**, and **deleting an account**, are not built. Forgot password works as a way to change it.
- **Booking** here reserves a spot inside Duo Flow only. It does not book in the CorePower app.
- Login and email limits are in memory and reset on restart. Add a proper rate limiter behind a proxy when public. Behind a proxy all visitors share one address, so limits are keyed by email address, not by IP.
- Adding a friend by email tells the sender whether that email has an account. Fine for a small pilot; change it before wide launch.
- `node:sqlite` is marked experimental in Node 22. It works, but pin your Node version in production.
- Have a lawyer review the privacy policy and terms before launch.


## Studios (version 0.4)
- After creating an account, a member picks which studios they belong to (CorePower, Solid Core, Pure Barre; one, two or all three). They can change this any time from Me > My studios.
- Each studio has its own home page, class list and colors. Members with more than one studio switch from the studio chip at the top of the screen.
- Sign-in, sign-up and the studio picker use the pink theme from the Home Screen icon.
- The class schedules for Solid Core and Pure Barre are sample data like CorePower's. Replace `STUDIOS` in server.js with real schedules when you have a feed.
- Accounts that existed before 0.4 see the studio picker once at their next sign-in.
- Nearest location (optional): members can turn it on from Home or Me. The browser asks for permission, the position stays on the phone and is never sent to the server, and it only decides which location is shown first.
