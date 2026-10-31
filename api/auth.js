// Accounts: create an account, sign in, and look up who is signed in.
// Every account gets its own private budget record (see data.js).
const { LEGACY_KEY, redisConfig, redis, makeToken, readToken, hashPassword, userKey, dataKey, parseBody, crypto } = require('./_lib');

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
      if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'bad_password', message: 'Choose a password of at least 8 characters.' });

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
