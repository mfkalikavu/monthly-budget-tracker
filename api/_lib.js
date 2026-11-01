// Shared helpers for the API functions (the leading underscore stops Vercel from exposing this file as a route).
const crypto = require('crypto');

const LEGACY_KEY = 'budget-tracker:v1';      // the old single-owner record
const SESSION_DAYS = 90;

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

async function redis(command) {
  const { url, token } = redisConfig();
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || 'Redis request failed (' + r.status + ')');
  return j.result;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// The signing secret lives in Redis (created once), so no extra environment variable is needed.
let cachedSecret = null;
async function getSecret() {
  if (cachedSecret) return cachedSecret;
  let s = await redis(['GET', 'bt:secret']);
  if (!s) {
    await redis(['SET', 'bt:secret', crypto.randomBytes(32).toString('hex'), 'NX']);
    s = await redis(['GET', 'bt:secret']);
  }
  cachedSecret = s;
  return s;
}

async function makeToken(uid) {
  const body = b64u(JSON.stringify({ uid, exp: Date.now() + SESSION_DAYS * 864e5 }));
  const sig = crypto.createHmac('sha256', await getSecret()).update(body).digest('base64url');
  return body + '.' + sig;
}

async function readToken(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [body, sig] = t.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', await getSecret()).update(body).digest();
  let got;
  try { got = Buffer.from(sig, 'base64url'); } catch (e) { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p && p.uid && p.exp > Date.now() ? p.uid : null;
  } catch (e) { return null; }
}

// Keyed hash used for one-time codes (so a stolen database row can't be reversed without the server secret).
async function hmac(text) {
  return crypto.createHmac('sha256', await getSecret()).update(String(text)).digest('hex');
}

// Sends a plain-text email through Brevo's HTTP API (free plan: 300 emails a day).
// Needs two environment variables in Vercel: BREVO_API_KEY and MAIL_FROM (an address verified in Brevo).
const mailConfigured = () => !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM);
async function sendMail(to, subject, text) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: process.env.MAIL_FROM_NAME || 'Monthly budget track', email: process.env.MAIL_FROM },
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
  });
  if (!r.ok) throw new Error('Mail provider error ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(password), salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))))
  );
}

const userKey = (email) => 'bt:user:' + email;
const dataKey = (uid) => 'bt:data:' + uid;

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b || {};
}

module.exports = { hmac, mailConfigured, sendMail, LEGACY_KEY, redisConfig, redis, makeToken, readToken, hashPassword, userKey, dataKey, parseBody, crypto };
