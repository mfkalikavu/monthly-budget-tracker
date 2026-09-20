// Vercel serverless function: stores your whole budget as one record in Upstash Redis.
// Every request must carry your passcode (APP_PASSCODE) as a Bearer token.
const crypto = require('crypto');

const KEY = 'budget-tracker:v1';
const MAX_BYTES = 900 * 1024; // stay under Upstash's 1 MB request limit

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

function sameSecret(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

async function readRecord() {
  const raw = await redis(['GET', KEY]);
  return raw ? JSON.parse(raw) : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const passcode = process.env.APP_PASSCODE;
    if (!passcode || !redisConfig()) {
      return res.status(503).json({
        error: 'not_configured',
        message: !passcode
          ? 'Cloud storage is not set up: add the APP_PASSCODE environment variable in Vercel and redeploy.'
          : 'Cloud storage is not set up: connect an Upstash Redis database to this Vercel project and redeploy.',
      });
    }

    const header = req.headers.authorization || '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!supplied) return res.status(401).json({ error: 'passcode_required' });
    if (!sameSecret(supplied, passcode)) {
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing
      return res.status(401).json({ error: 'bad_passcode' });
    }

    if (req.method === 'GET') {
      return res.status(200).json({ record: await readRecord() });
    }

    if (req.method === 'PUT') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      const data = body && body.data;
      if (!data || !Array.isArray(data.income) || !Array.isArray(data.expenses)) {
        return res.status(400).json({ error: 'bad_data', message: 'Expected income and expenses lists.' });
      }
      const base = Number(body.baseUpdatedAt) || 0;
      const current = await readRecord();
      if (current && current.updatedAt !== base) {
        // Another device saved since this one last synced: hand back the latest copy.
        return res.status(409).json({ error: 'conflict', record: current });
      }
      const record = { updatedAt: Math.max(Date.now(), ((current && current.updatedAt) || 0) + 1), data };
      const text = JSON.stringify(record);
      if (Buffer.byteLength(text) > MAX_BYTES) {
        return res.status(413).json({ error: 'too_large', message: 'Your data has outgrown a single record.' });
      }
      await redis(['SET', KEY, text]);
      return res.status(200).json({ updatedAt: record.updatedAt });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong on the server.' });
  }
};
