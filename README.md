# Monthly budget track (Vercel version)

A phone-friendly budget app: Dashboard, Income, Expenses, Debt and Yearly summary.
Everyone creates their own account (name, email, password). Each account has its own private space in your
Redis database on Vercel (Upstash), so people can share one link but never see each other's entries.
Sign in on any phone or laptop and you see your own data, kept in sync.

```
public/index.html      the app (no data inside)
public/docgen.js       makes the invoice and receipt PDFs (no external library)
public/docs/           fonts, QR code, receipt header art and signature used by those PDFs
api/auth.js            create account / sign in
api/data.js            the storage API (one private record per signed-in person)
api/_lib.js            shared helpers (password hashing, sign-in tokens, Redis)
vercel.json            serves /public and asks search engines not to index it
```

## Deploy (about 10 minutes)

1. **Put the folder on Vercel.** Either:
   - push this folder to a new GitHub repo, then on vercel.com choose **Add New, Project** and import it, or
   - run `npx vercel` inside this folder and follow the prompts.
   Leave the framework as **Other** and don't set a build command.
2. **Add the database.** In your Vercel project open **Storage**, then **Create Database**,
   choose **Upstash for Redis** (free plan is fine) and **Connect to Project**.
   Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
3. **(Only if you already used the old passcode version.)** Keep the `APP_PASSCODE` environment variable as it is.
   It is now used only once, to move your existing data into your new account. New setups can skip this step.
4. **Redeploy** (Deployments, the latest one, Redeploy) so the changes take effect.
5. **Open your site and choose Create account.** If you used the app before, open
   **I used this app before with a passcode** and enter your old passcode: your existing data moves into your account
   (this works for one account only, the first to claim it). Otherwise use
   **Settings, Backup, Restore backup** and choose `YOUR-DATA-backup.json`.
6. **Install it on your phone:** open the site in Chrome or Safari and choose
   **Add to Home Screen**.

Do not upload `YOUR-DATA-backup.json` to GitHub or Vercel. It is only for step 5.

## How it behaves

- Changes save automatically a moment after you make them. The line under the title shows the status.
- Offline changes are kept on the device and uploaded when you're back online.
- If two devices edit at once, the one that saved first wins and the other loads the latest data.
- **Settings, Sign out** removes your sign-in and the local copy from that device. Your data stays in the cloud.
- Passwords can be any 4 or more characters. They are stored only as salted scrypt hashes. Sign-ins last 90 days on a device.
- **Forgot password:** on the sign-in screen, tap Forgot password, enter your email, and a 6-digit code (valid 15 minutes) is emailed to you. This needs the two email settings below.
- **Change password:** Settings, Change password.
- **Face ID / fingerprint lock:** Settings, App lock. It works per device, uses the phone's own face or fingerprint check, and locks again after a minute away. It needs the https link (your Vercel address) and a phone or laptop with Face ID, fingerprint or Windows Hello.
- **Sounds and haptics:** the app uses two sounds rebuilt from recordings of other apps. A soft two-note chime (low B, then the B above it) plays when you sign in, when Face ID accepts you, and when data is saved. A short "pop" (a tiny tick followed by a brief low pop) plays on Add income, Add expense, the debt buttons and the Settings icon. Section tabs and other buttons give a light haptic-style tap; a low triple tap means something was not accepted; pulling down to refresh plays a soft whoosh. Phones that support it also vibrate (iPhone Safari 17.4 or newer, and Android). The sounds are generated in the browser, so there are no audio files. Turn them off in Settings, Sounds & haptics. On iPhone the sound follows the ring/silent switch, but the haptic does not.
- **Refresh:** pull the page down on a phone to fetch changes made on another device. The app also checks quietly every 20 seconds while it is open.
- The Dashboard greets you by name ("Hi, ..."), using the name you gave when creating the account.
- **Settings, Change password** lets a signed-in person change their password (needs the current one).
- There is no "forgot password" email yet. If someone forgets it, they can't get back in on their own; deleting their `bt:user:<email>` key in Upstash would let them sign up again, but as a new, empty account (the old data stays under its old id).
- Keep a backup file now and then (Settings, Backup, Save backup).

## Email for forgot-password (one-time setup, free)

Codes are sent through Brevo (free plan, 300 emails a day).

1. Create a free account at brevo.com.
2. Open **Senders, Domains & Dedicated IPs, Senders, Add a sender**. Enter your name and the email address the codes should come from, then confirm it with the code Brevo emails you.
3. Open **SMTP & API, API Keys, Generate a new API key** and copy it.
4. In Vercel open your project, **Settings, Environment Variables**, and add:
   - `BREVO_API_KEY` = the key you copied
   - `MAIL_FROM` = the sender email you confirmed in step 2
   - `MAIL_FROM_NAME` (optional) = the name people see, for example `Monthly budget track`
5. **Redeploy** the project.

If Brevo answers "unrecognised IP", open **Security, Authorized IPs** in Brevo and deactivate blocking, because Vercel's addresses change.
If the app says "Sending email is not set up yet", the two variables are missing or the project has not been redeployed.

## Good to know

- The whole budget is one record, limited to roughly 900 KB (many thousands of entries).
- To run locally: `npm i -g vercel`, add the same environment variables in a `.env` file,
  then `vercel dev`.

## Graphic invoice and receipt

**Settings, Graphic invoice** has two buttons, **Invoice** and **Receipt**. Each opens a form; **Download PDF** makes a real PDF
(A4 portrait for the invoice, 1280 x 853 for the receipt) from what you typed.

- Invoice and receipt details are remembered on that device only (browser storage). They are not part of your budget data or backups.
- The invoice total is worked out from the items (price x quantity). Long product text shrinks to fit its line.
- The QR code on the invoice is the original one for the UPI ID `fahiskalikavu@okhdfcbank`. If you change any payment detail it is
  left out automatically, so an old QR can never be printed next to a different account. Upload a new QR, or choose
  "Original QR, I confirm it applies", from the QR code menu.
- Everything the PDFs need (fonts, QR, receipt header art, signature) is embedded inside `public/docgen.js`, so it works even if the `public/docs` folder is not deployed. The originals stay in `public/docs`; to change the signature or QR, replace the file there and ask for the embedded copy to be rebuilt.
- Fonts are Inter and Inter Display (the originals, Degular Display and Metropolis, are not available as full font files).
  Layout constants and font choices are at the top of `public/docgen.js`.
