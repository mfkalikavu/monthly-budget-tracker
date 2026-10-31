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
- Passwords are stored only as salted scrypt hashes. Sign-ins last 90 days on a device.
- The Dashboard greets you by name ("Hello, ..."), using the name you gave when creating the account.
- There is no password reset email yet. To reset one, delete that person's `bt:user:<email>` key in the Upstash console and have them sign up again (their data key `bt:data:<id>` is separate).
- Keep a backup file now and then (Settings, Backup, Save backup).

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
