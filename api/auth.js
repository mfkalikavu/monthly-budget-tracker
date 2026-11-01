// Accounts: create an account, sign in, and look up who is signed in.
// Every account gets its own private budget record (see data.js).
const { hmac, mailConfigured, sendMail, LEGACY_KEY, redisConfig, redis, makeToken, readToken, hashPassword, userKey, dataKey, parseBody, crypto } = require('./_lib');

const MIN_PASSWORD = 4;
const RESET_MINUTES = 15;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function sameSecret(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!redisConfig()) {
      return res.status(503).json({
        error: 'not_configured',
        message: 'Cloud storage is not set up: connect an Upstash Redis database to this Vercel project and redeploy.',
      });
    }

    // Who am I? (used to check a saved sign-in is still valid)
    if (req.method === 'GET') {
      const uid = await readToken(req);
      if (!uid) return res.status(401).json({ error: 'signed_out' });
      const u = await redis(['GET', 'bt:uid:' + uid]);
      if (!u) return res.status(401).json({ error: 'signed_out' });
      const user = JSON.parse(u);
      return res.status(200).json({ user: { id: uid, name: user.name, email: user.email } });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const b = parseBody(req);
    if (b.action === 'ping') return res.status(200).json({ ok: true }); // lets the app check that storage is set up
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');

    if (b.action === 'signup') {
      const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: 'bad_name', message: 'Please enter your name.' });
      if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: 'bad_email', message: 'Please enter a valid email address.' });
      if (password.length < MIN_PASSWORD || password.length > 200) return res.status(400).json({ error: 'bad_password', message: 'Choose a password of at least ' + MIN_PASSWORD + ' characters.' });

      const uid = crypto.randomBytes(12).toString('hex');
      const salt = crypto.randomBytes(16).toString('hex');
      const user = { id: uid, name, email, salt, hash: await hashPassword(password, salt), createdAt: Date.now() };
      // NX = only if nobody has this email yet (safe even if two people sign up at the same moment)
      const created = await redis(['SET', userKey(email), JSON.stringify(user), 'NX']);
      if (created !== 'OK') return res.status(409).json({ error: 'email_taken', message: 'An account with this email already exists. Sign in instead.' });
      await redis(['SET', 'bt:uid:' + uid, JSON.stringify({ name, email })]);

      // Optional: the original owner brings the old single-passcode data into their new account (works once).
      let imported = false;
      const old = String(b.legacyPasscode || '');
      if (old && process.env.APP_PASSCODE && sameSecret(old, process.env.APP_PASSCODE)) {
        const claim = await redis(['SET', 'bt:legacy-claimed', uid, 'NX']);
        if (claim === 'OK') {
          const rec = await redis(['GET', LEGACY_KEY]);
          if (rec) { await redis(['SET', dataKey(uid), rec]); imported = true; }
        }
      }
      return res.status(200).json({ token: await makeToken(uid), user: { id: uid, name, email }, imported });
    }

    if (b.action === 'password') {
      const uid = await readToken(req);
      if (!uid) return res.status(401).json({ error: 'signed_out', message: 'Please sign in again.' });
      const next = String(b.newPassword || '');
      if (next.length < MIN_PASSWORD || next.length > 200) return res.status(400).json({ error: 'bad_password', message: 'Choose a new password of at least ' + MIN_PASSWORD + ' characters.' });
      const info = await redis(['GET', 'bt:uid:' + uid]);
      const raw = info ? await redis(['GET', userKey(JSON.parse(info).email)]) : null;
      const user = raw ? JSON.parse(raw) : null;
      if (!user) return res.status(401).json({ error: 'signed_out', message: 'Please sign in again.' });
      const attempt = await hashPassword(String(b.currentPassword || ''), user.salt);
      if (!sameSecret(attempt, user.hash)) {
        await wait(600);
        return res.status(403).json({ error: 'bad_current', message: 'Your current password is not right.' });
      }
      user.salt = crypto.randomBytes(16).toString('hex');
      user.hash = await hashPassword(next, user.salt);
      await redis(['SET', userKey(user.email), JSON.stringify(user)]);
      return res.status(200).json({ ok: true });
    }

    // Forgot password, step 1: email a 6-digit code (valid for 15 minutes).
    if (b.action === 'forgot') {
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'bad_email', message: 'Please enter a valid email address.' });
      if (!mailConfigured()) {
        return res.status(503).json({ error: 'mail_not_configured', message: 'Sending email is not set up yet. Add BREVO_API_KEY and MAIL_FROM in Vercel (see the setup guide).' });
      }
      const raw = await redis(['GET', userKey(email)]);
      if (raw) {
        const key = 'bt:reset:' + email;
        const prevRaw = await redis(['GET', key]);
        const prev = prevRaw ? JSON.parse(prevRaw) : null;
        if (!prev || Date.now() - prev.at > 60000) { // at most one email a minute per address
          const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
          const rec = { h: await hmac(email + ':' + code), at: Date.now(), exp: Date.now() + RESET_MINUTES * 60000, tries: 0 };
          await redis(['SET', key, JSON.stringify(rec), 'EX', RESET_MINUTES * 60]);
          try {
            await sendMail(email, 'Your Monthly budget track code: ' + code,
              'Your password reset code is ' + code + '\n\nIt works for ' + RESET_MINUTES + ' minutes. If you did not ask for it, you can ignore this email and your password stays the same.');
          } catch (e) {
            console.error(e);
            await redis(['DEL', key]);
            return res.status(502).json({ error: 'mail_failed', message: 'Could not send the email right now. Please try again in a few minutes.' });
          }
        }
      }
      // Same answer whether or not the email has an account, so nobody can use this to find out who is registered.
      return res.status(200).json({ ok: true, message: 'If that email has an account, a 6-digit code is on its way. Check your spam folder too.' });
    }

    // Forgot password, step 2: check the code, set the new password and sign in.
    if (b.action === 'reset') {
      const next = String(b.newPassword || '');
      const code = String(b.code || '').replace(/\s+/g, '');
      if (next.length < MIN_PASSWORD || next.length > 200) return res.status(400).json({ error: 'bad_password', message: 'Choose a new password of at least ' + MIN_PASSWORD + ' characters.' });
      const key = 'bt:reset:' + email;
      const recRaw = email ? await redis(['GET', key]) : null;
      const rec = recRaw ? JSON.parse(recRaw) : null;
      if (!rec || rec.exp < Date.now()) return res.status(400).json({ error: 'bad_code', message: 'That code has expired or was not requested. Ask for a new code.' });
      if (rec.tries >= 5) { await redis(['DEL', key]); return res.status(429).json({ error: 'too_many', message: 'Too many wrong codes. Ask for a new code.' }); }
      if (!sameSecret(await hmac(email + ':' + code), rec.h)) {
        rec.tries += 1;
        await redis(['SET', key, JSON.stringify(rec), 'EX', Math.max(1, Math.ceil((rec.exp - Date.now()) / 1000))]);
        await wait(600);
        return res.status(400).json({ error: 'bad_code', message: 'That code is not right.' });
      }
      const raw = await redis(['GET', userKey(email)]);
      const user = raw ? JSON.parse(raw) : null;
      if (!user) return res.status(400).json({ error: 'bad_code', message: 'That code has expired or was not requested. Ask for a new code.' });
      user.salt = crypto.randomBytes(16).toString('hex');
      user.hash = await hashPassword(next, user.salt);
      await redis(['SET', userKey(email), JSON.stringify(user)]);
      await redis(['DEL', key]);
      return res.status(200).json({ token: await makeToken(user.id), user: { id: user.id, name: user.name, email: user.email } });
    }

    if (b.action === 'login') {
      const raw = email ? await redis(['GET', userKey(email)]) : null;
      const user = raw ? JSON.parse(raw) : null;
      // Hash even when the account doesn't exist, so timing doesn't reveal which emails are registered.
      const attempt = await hashPassword(password, user ? user.salt : 'x'.repeat(32));
      const ok = user && sameSecret(attempt, user.hash);
      if (!ok) {
        await wait(600);
        return res.status(401).json({ error: 'bad_login', message: 'That email or password is not right.' });
      }
      return res.status(200).json({ token: await makeToken(user.id), user: { id: user.id, name: user.name, email: user.email } });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong on the server.' });
  }
};
