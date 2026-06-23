// api/ixc-proxy.js — Proxy Vercel para a API do IXC Soft
// Suporta GET (listagem) e PUT/DELETE via header x-ixc-method

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ixc-url, x-ixc-token, x-ixc-user, x-ixc-endpoint, x-ixc-method');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const ixcBase     = req.headers['x-ixc-url']      || '';
  const ixcToken    = req.headers['x-ixc-token']    || '';
  const ixcUser     = req.headers['x-ixc-user']     || '';
  const ixcEndpoint = req.headers['x-ixc-endpoint'] || '';
  // Método que o proxy deve usar ao chamar o IXC (padrão GET)
  const ixcMethod   = (req.headers['x-ixc-method']  || 'GET').toUpperCase();

  if (!ixcBase || !ixcToken || !ixcEndpoint) {
    return res.status(400).json({ error: 'Headers x-ixc-url, x-ixc-token e x-ixc-endpoint são obrigatórios.' });
  }

  const { params = {}, rp = '500' } = req.body || {};

  // Monta a URL e o auth
  const base = ixcBase.replace(/\/$/, '');
  const auth = ixcToken.startsWith('Basic ') ? ixcToken : `Basic ${ixcToken}`;

  // === GET / listagem ===
  if (ixcMethod === 'GET') {
    const url = `${base}/webservice/v1/${ixcEndpoint}`;
    const body = JSON.stringify({
      token: ixcToken,
      ...(ixcUser ? { usuario: ixcUser } : {}),
      ...params,
      rp: String(rp),
    });
    try {
      const r = await fetch(url, {
        method: 'POST',    // IXC usa POST para listagem
        headers: { 'Content-Type': 'application/json', 'Authorization': auth },
        body,
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return res.status(r.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // === PUT / DELETE — operações sobre um registro específico ===
  // Endpoint já vem com o ID: ex: "cliente_login/1234"
  const url = `${base}/webservice/v1/${ixcEndpoint}`;
  try {
    const r = await fetch(url, {
      method: ixcMethod,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
      },
      body: ixcMethod !== 'DELETE' ? JSON.stringify(params) : undefined,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
