# Monthly budget track (Vercel version)

A phone-friendly budget app: Dashboard, Income, Expenses, Debt and Yearly summary.
Your entries are saved in your own Redis database on Vercel (Upstash), behind a passcode,
so every phone or laptop you unlock sees the same data.

```
public/index.html      the app (no data inside)
api/data.js            the storage API (one record, protected by your passcode)
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
3. **Set your passcode.** In **Settings, Environment Variables**, add `APP_PASSCODE`
   with a long passcode only you know (for example four random words).
   Apply it to Production, Preview and Development.
4. **Redeploy** (Deployments, the latest one, Redeploy) so the variables take effect.
5. **Open your site**, enter the passcode, then go to
   **Settings, Backup, Restore backup** and choose `YOUR-DATA-backup.json`.
   Your spreadsheet data is now in the cloud.
6. **Install it on your phone:** open the site in Chrome or Safari and choose
   **Add to Home Screen**.

Do not upload `YOUR-DATA-backup.json` to GitHub or Vercel. It is only for step 5.

## How it behaves

- Changes save automatically a moment after you make them. The line under the title shows the status.
- Offline changes are kept on the device and uploaded when you're back online.
- If two devices edit at once, the one that saved first wins and the other loads the latest data.
- **Settings, Sign out** removes the passcode and the local copy from that device.
- Keep a backup file now and then (Settings, Backup, Save backup).

## Good to know

- The whole budget is one record, limited to roughly 900 KB (many thousands of entries).
- Changing the passcode: edit `APP_PASSCODE` in Vercel, redeploy, then sign in again on each device.
- To run locally: `npm i -g vercel`, add the same environment variables in a `.env` file,
  then `vercel dev`.
