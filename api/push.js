// ════════════════════════════════════════════════════════════════
// MoviApp Push — endpoint para enviar notificações push
// URL: /api/push
//
// Ações:
//   subscribe   → salva subscription do dispositivo
//   unsubscribe → remove subscription
//   send        → envia push para um cliente (admin/sistema)
//   send_all    → envia para todos os dispositivos de um ixc_id
// ════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const SUPA_URL = process.env.SUPABASE_URL || 'https://mgtetsmcswdtvsgewcen.supabase.co';
const SRV      = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const VAPID_PUB  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIV = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_MAIL = process.env.VAPID_EMAIL || 'mailto:contato@movion.com.br';

const srvH = { 'apikey': SRV, 'Authorization': `Bearer ${SRV}`, 'Content-Type': 'application/json' };

// ── VAPID helpers ───────────────────────────────────────────────
function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g,'+').replace(/_/g,'/'), 'base64');
}
function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function makeVapidHeaders(audience, vapidPub, vapidPriv, email) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 43200,
    sub: email,
  };
  const header  = b64urlEncode(JSON.stringify({ typ:'JWT', alg:'ES256' }));
  const body    = b64urlEncode(JSON.stringify(payload));
  const signing = `${header}.${body}`;

  // Assinar com ECDSA P-256
  const privKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420','hex'),
      b64urlDecode(vapidPriv),
      Buffer.from('a144034200','hex'),
      b64urlDecode(vapidPub),
    ]),
    format: 'der',
    type: 'pkcs8',
  });

  const sig = crypto.sign(null, Buffer.from(signing), { key: privKey, dsaEncoding: 'ieee-p1363' });
  const jwt = `${signing}.${b64urlEncode(sig)}`;

  return {
    Authorization: `vapid t=${jwt},k=${vapidPub}`,
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: '86400',
  };
}

// ── Criptografar payload para Web Push (AES-GCM) ───────────────
async function encryptPayload(subscription, payload) {
  const userPublicKey  = b64urlDecode(subscription.p256dh);
  const userAuth       = b64urlDecode(subscription.auth);
  const payloadBuf     = Buffer.from(JSON.stringify(payload));

  // Gerar chave efêmera
  const serverKeys = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const serverPublicRaw  = serverKeys.publicKey.slice(-65);
  const serverPrivateKey = crypto.createPrivateKey({ key: serverKeys.privateKey, format: 'der', type: 'pkcs8' });

  // ECDH shared secret
  const clientPublicKey = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200','hex'),
      userPublicKey,
    ]),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = crypto.diffieHellman({ privateKey: serverPrivateKey, publicKey: clientPublicKey });

  // HKDF
  const salt  = crypto.randomBytes(16);
  const prk   = await hkdf(userAuth, sharedSecret, Buffer.concat([Buffer.from('WebPush: info\0'), userPublicKey, serverPublicRaw]), 32);
  const cek   = await hkdf(salt, prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])]), 16);
  const nonce = await hkdf(salt, prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])]), 12);

  // Cifrar
  const cipher  = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const padded  = Buffer.concat([payloadBuf, Buffer.from([2])]);
  const enc     = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // Header AES128GCM
  const recSize = Buffer.alloc(4); recSize.writeUInt32BE(4096, 0);
  const header  = Buffer.concat([
    salt,
    recSize,
    Buffer.from([serverPublicRaw.length]),
    serverPublicRaw,
    enc,
  ]);

  return header;
}

async function hkdf(salt, ikm, info, len) {
  const key  = crypto.createHmac('sha256', salt).update(ikm).digest();
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(info);
  return hmac.digest().slice(0, len);
}

// ── Enviar push para uma subscription ──────────────────────────
async function sendPush(sub, notification) {
  const url      = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const headers  = makeVapidHeaders(audience, VAPID_PUB, VAPID_PRIV, VAPID_MAIL);

  const body = await encryptPayload(
    { p256dh: sub.p256dh, auth: sub.auth },
    {
      title: notification.title || 'MoviON',
      body:  notification.body  || '',
      icon:  notification.icon  || '/icon-192.png',
      badge: '/icon-72.png',
      data:  notification.data  || {},
      actions: notification.actions || [],
    }
  );

  const r = await fetch(sub.endpoint, { method: 'POST', headers, body });
  return r.status;
}

// ── Handler principal ───────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-target');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SRV)       return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY não configurada' });
  if (!VAPID_PUB) return res.status(500).json({ error: 'VAPID_PUBLIC_KEY não configurada' });

  const b      = req.body || {};
  const action = b.action || '';
  const jwt    = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  // ── subscribe ──────────────────────────────────────────────────
  if (action === 'subscribe') {
    if (!jwt) return res.status(401).json({ error: 'Token ausente' });
    let userId;
    try {
      const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
      userId  = p.sub;
    } catch(e) { return res.status(401).json({ error: 'Token inválido' }); }

    const { endpoint, p256dh, auth, user_agent } = b;
    if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'Dados de subscription incompletos' });

    // Buscar ixc_id e cliente_id
    let ixcId = null, clienteId = null;
    try {
      const r = await fetch(`${SUPA_URL}/rest/v1/clientes_app?id=eq.${userId}&select=cliente_id`, { headers: srvH });
      const d = await r.json();
      clienteId = d?.[0]?.cliente_id;
    } catch(e) {}

    if (clienteId) {
      try {
        const r = await fetch(`${SUPA_URL}/rest/v1/clientes?id=eq.${clienteId}&select=ixc_id`, { headers: srvH });
        const d = await r.json();
        ixcId = d?.[0]?.ixc_id;
      } catch(e) {}
    }

    // Upsert subscription
    const ri = await fetch(`${SUPA_URL}/rest/v1/push_subscriptions`, {
      method: 'POST',
      headers: { ...srvH, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: userId, cliente_id: clienteId, ixc_id: ixcId, endpoint, p256dh, auth, user_agent, updated_at: new Date().toISOString() })
    });

    if (!ri.ok) {
      const e = await ri.json();
      return res.status(ri.status).json({ error: 'Erro ao salvar subscription', detail: e });
    }

    return res.status(200).json({ ok: true, message: 'Notificações ativadas!' });
  }

  // ── unsubscribe ────────────────────────────────────────────────
  if (action === 'unsubscribe') {
    if (!jwt) return res.status(401).json({ error: 'Token ausente' });
    let userId;
    try { userId = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).sub; } catch(e) { return res.status(401).json({ error: 'Token inválido' }); }

    const { endpoint } = b;
    if (!endpoint) return res.status(400).json({ error: 'endpoint ausente' });

    await fetch(`${SUPA_URL}/rest/v1/push_subscriptions?user_id=eq.${userId}&endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE', headers: srvH });
    return res.status(200).json({ ok: true });
  }

  // ── vapid_public_key ───────────────────────────────────────────
  if (action === 'vapid_public_key') {
    return res.status(200).json({ ok: true, key: VAPID_PUB });
  }

  // ── send (admin/sistema → envia push para um ixc_id) ─────────
  if (action === 'send') {
    if (!SRV) return res.status(500).json({ error: 'SRV ausente' });

    const { ixc_id, title, body: notifBody, icon, data } = b;
    if (!ixc_id || !title) return res.status(400).json({ error: 'ixc_id e title obrigatórios' });

    // Buscar todas as subscriptions deste cliente
    const r = await fetch(`${SUPA_URL}/rest/v1/push_subscriptions?ixc_id=eq.${ixc_id}&select=endpoint,p256dh,auth`, { headers: srvH });
    const subs = await r.json();

    if (!subs?.length) return res.status(200).json({ ok: true, sent: 0, message: 'Nenhum dispositivo registrado' });

    const results = await Promise.allSettled(
      subs.map(sub => sendPush(sub, { title, body: notifBody, icon, data }))
    );

    const sent   = results.filter(r => r.status === 'fulfilled' && r.value < 400).length;
    const failed = results.length - sent;

    return res.status(200).json({ ok: true, sent, failed, total: results.length });
  }

  return res.status(400).json({ error: 'Ação desconhecida' });
};
