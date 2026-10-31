// Vercel serverless function: stores each signed-in person's budget as their own record in Upstash Redis.
// Every request must carry the sign-in token from /api/auth. The token decides whose record is read or written,
// so one person can never see or change another person's data.
const { redisConfig, redis, readToken, dataKey, parseBody } = require('./_lib');

const MAX_BYTES = 900 * 1024; // stay under Upstash's 1 MB request limit

async function readRecord(key) {
  const raw = await redis(['GET', key]);
  return raw ? JSON.parse(raw) : null;
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

    const uid = await readToken(req);
    if (!uid) return res.status(401).json({ error: 'signed_out' });
    const key = dataKey(uid);

    if (req.method === 'GET') {
      return res.status(200).json({ record: await readRecord(key) });
    }

    if (req.method === 'PUT') {
      const body = parseBody(req);
      const data = body.data;
      if (!data || !Array.isArray(data.income) || !Array.isArray(data.expenses)) {
        return res.status(400).json({ error: 'bad_data', message: 'Expected income and expenses lists.' });
      }
      const base = Number(body.baseUpdatedAt) || 0;
      const current = await readRecord(key);
      if (current && current.updatedAt !== base) {
        // Another device of the same person saved since this one last synced: hand back the latest copy.
        return res.status(409).json({ error: 'conflict', record: current });
      }
      const record = { updatedAt: Math.max(Date.now(), ((current && current.updatedAt) || 0) + 1), data };
      const text = JSON.stringify(record);
      if (Buffer.byteLength(text) > MAX_BYTES) {
        return res.status(413).json({ error: 'too_large', message: 'Your data has outgrown a single record.' });
      }
      await redis(['SET', key, text]);
      return res.status(200).json({ updatedAt: record.updatedAt });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong on the server.' });
  }
};
