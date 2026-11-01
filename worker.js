/**
 * WexaurChat push sender — Cloudflare Worker (free plan)
 *
 * Secrets / variables to add in Cloudflare (Settings → Variables and Secrets):
 *   SA_JSON           (secret)  full contents of the Firebase service-account JSON key
 *   FIREBASE_API_KEY            Firebase web apiKey (AIzaSy...)
 *   PROJECT_ID                  wexaurchat
 *   DB_URL                      https://wexaurchat-default-rtdb.asia-southeast1.firebasedatabase.app
 *   ALLOWED_ORIGIN              https://bizzmahendersingh.github.io
 *   APP_URL                     https://bizzmahendersingh.github.io/WexaurChat/
 *
 * The app calls this worker after a message is sent:
 *   POST  Authorization: Bearer <Firebase ID token>   body: { cid, title, body }
 * The worker checks the caller really belongs to that chat, then sends a data-only FCM push to the other members' devices.
 */
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = s => new TextEncoder().encode(s);
let cached = null;

async function accessToken(sa) {
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(enc(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  })));
  const pem = sa.private_key.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc(head + '.' + claim));
  const jwt = head + '.' + claim + '.' + b64url(sig);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('token exchange failed');
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

async function verifyUser(idToken, env) {
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + env.FIREBASE_API_KEY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.users && j.users[0] && j.users[0].localId) || null;
}

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };
    const out = (body, status = 200) => new Response(body, { status, headers: cors });
    if (req.method === 'OPTIONS') return out(null, 204);
    if (req.method !== 'POST') return out('WexaurChat push worker');
    try {
      const me = await verifyUser((req.headers.get('Authorization') || '').replace('Bearer ', ''), env);
      if (!me) return out('unauthorized', 401);
      const { cid, title, body } = await req.json();
      if (typeof cid !== 'string' || !/^[\w-]{3,120}$/.test(cid)) return out('bad cid', 400);
      const sa = JSON.parse(env.SA_JSON), at = await accessToken(sa);

      let members;
      if (cid.startsWith('dm_')) members = cid.slice(3).split('_');
      else {
        const r = await fetch(`${env.DB_URL}/groups/${cid}/members.json?access_token=${at}`);
        members = Object.keys((await r.json()) || {});
      }
      if (!members.includes(me)) return out('forbidden', 403);

      const fs = `https://firestore.googleapis.com/v1/projects/${env.PROJECT_ID}/databases/(default)/documents`;
      let sent = 0;
      for (const uid of members.filter(u => u !== me)) {
        const tr = await fetch(`${fs}/users/${uid}/tokens?pageSize=20`, { headers: { Authorization: 'Bearer ' + at } });
        const tj = await tr.json();
        for (const d of (tj.documents || [])) {
          const token = d.name.split('/').pop();
          const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.PROJECT_ID}/messages:send`, {
            method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: {
              token,
              data: { cid, tag: cid, title: String(title || 'WexaurChat').slice(0, 60), body: String(body || '').slice(0, 140) },
              webpush: { headers: { Urgency: 'high', TTL: '86400' }, fcm_options: { link: env.APP_URL } }
            } })
          });
          if (res.ok) sent++;
          else if (res.status === 404 || res.status === 400) // dead token: remove it
            await fetch(`${fs}/users/${uid}/tokens/${encodeURIComponent(token)}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + at } });
        }
      }
      return out(JSON.stringify({ sent }));
    } catch (e) {
      return out('error', 500);
    }
  }
};
