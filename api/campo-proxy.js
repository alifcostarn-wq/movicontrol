// ════════════════════════════════════════════════════════════════
// Campo API — proxy ISOLADO do app de campo (técnicos)
// URL: https://movicontrol.vercel.app/api/campo-proxy
//
// Totalmente separado do ixc-proxy.js (MoviControl), seguindo o mesmo
// princípio do moviapp.js: mudanças aqui NUNCA afetam o sistema
// administrativo, e vice-versa (isolamento por blast radius).
//
// Branches usados pelo campo.html (e SOMENTE estes):
//   • x-target: evotrix     → notificação WhatsApp ao cliente
//   • x-target: r2-upload    → upload de foto da OS no Cloudflare R2
//   • x-ixc-method: PUT      → limpar MAC do login (ixcsoft: 'editar')
//   • (default) GET/listar   → diagnóstico IXC (radusuarios etc.)
//
// Env vars (compartilhadas com o projeto Vercel — já existem):
//   EVOTRIX_API_KEY
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//   R2_BUCKET_NAME, R2_ENDPOINT
// ════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ixc-url, x-ixc-token, x-ixc-user, x-ixc-endpoint, x-ixc-secret, x-ixc-method, x-target');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ============================================================
  // EVOTRIX - envio de WhatsApp (texto livre, sem template)
  // Acionado pelo header x-target: evotrix
  // A chave fica SOMENTE no servidor (variavel de ambiente EVOTRIX_API_KEY)
  // ============================================================
  if ((req.headers['x-target'] || '').toLowerCase() === 'evotrix') {
    const apiKey = process.env.EVOTRIX_API_KEY || '';
    if (!apiKey) {
      return res.status(500).json({ error: 'EVOTRIX_API_KEY nao configurada no servidor (Vercel > Settings > Environment Variables).' });
    }
    const b = req.body || {};
    const payload = {
      channel:   b.channel   || '',
      recipient: b.recipient || '',
      body:      typeof b.body === 'string' ? b.body : '',
      campaign:  b.campaign  || 'os_notificacao',
    };
    if (!payload.channel || !payload.recipient || !payload.body) {
      return res.status(400).json({ error: 'Faltam campos: channel, recipient ou body.' });
    }
    // Endpoint e autenticacao confirmados em producao (Bearer)
    const evoUrl = 'https://api.evotrix.com.br/v1/services/whatsapp/notifications/text';
    try {
      const r = await fetch(evoUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
      console.log(`[evotrix] ${r.status} ${text.slice(0, 160)}`);
      if (r.status >= 200 && r.status < 300) {
        return res.status(200).json({ ok: true, evotrix: data });
      }
      return res.status(r.status).json({ ok: false, evotrix: data });
    } catch (e) {
      console.log(`[evotrix] ERRO ${e.message}`);
      return res.status(502).json({ error: 'Falha ao enviar pela Evotrix.', detail: e.message });
    }
  }

  // ============================================================
  // R2 UPLOAD - recebe foto do técnico e salva no Cloudflare R2
  // Acionado pelo header x-target: r2-upload
  // Espera body: { os_id, tecnico_id, foto_base64, extensao, access_token }
  // ============================================================
  if ((req.headers['x-target'] || '').toLowerCase() === 'r2-upload') {
    const R2_ACCOUNT  = process.env.R2_ACCOUNT_ID        || '';
    const R2_KEY      = process.env.R2_ACCESS_KEY_ID     || '';
    const R2_SECRET   = process.env.R2_SECRET_ACCESS_KEY || '';
    const R2_BUCKET   = process.env.R2_BUCKET_NAME       || 'movionfotos';
    const R2_ENDPOINT = process.env.R2_ENDPOINT          || `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`;

    if (!R2_KEY || !R2_SECRET) return res.status(500).json({ error: 'Credenciais R2 não configuradas no Vercel.' });

    const b = req.body || {};
    const { os_id, tecnico_id, foto_base64, extensao = 'jpg', access_token } = b;
    if (!os_id || !foto_base64) return res.status(400).json({ error: 'os_id e foto_base64 são obrigatórios.' });

    // Decodifica base64
    const base64Data = foto_base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const ext = (extensao || 'jpg').toLowerCase().replace(/[^a-z]/g, '');
    const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

    // Nome do arquivo: fotos/OS_{id}/{timestamp}_{random}.{ext}
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const key = `fotos/OS_${os_id}/${ts}_${rand}.${ext}`;

    // Assina a requisição com AWS Signature V4 (compatível com R2)
    const now = new Date();
    const dateStr  = now.toISOString().slice(0,10).replace(/-/g,'');   // YYYYMMDD
    const timeStr  = now.toISOString().replace(/[-:]/g,'').slice(0,15) + 'Z'; // YYYYMMDDTHHmmssZ
    const region   = 'auto';
    const service  = 's3';
    const host     = `${R2_ACCOUNT}.r2.cloudflarestorage.com`;
    const url      = `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

    // Função de hash/hmac via crypto (Node built-in)
    const crypto = await import('crypto');
    const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
    const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

    const payloadHash = hash(buffer);
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timeStr}\n`;
    const signedHeaders    = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = `PUT\n/${R2_BUCKET}/${key}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credScope = `${dateStr}/${region}/${service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${timeStr}\n${credScope}\n${hash(canonicalRequest)}`;
    const sigKey = hmac(hmac(hmac(hmac(`AWS4${R2_SECRET}`, dateStr), region), service), 'aws4_request');
    const signature = hmac(sigKey, stringToSign).toString('hex');
    const authHeader = `AWS4-HMAC-SHA256 Credential=${R2_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    try {
      const r2Res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type':          contentType,
          'x-amz-date':            timeStr,
          'x-amz-content-sha256':  payloadHash,
          'Authorization':         authHeader,
          'Content-Length':        String(buffer.length),
        },
        body: buffer,
      });

      if (!r2Res.ok) {
        const txt = await r2Res.text();
        return res.status(502).json({ error: 'Falha no upload R2', detail: txt.slice(0, 300) });
      }

      return res.status(200).json({ ok: true, key, url: `${R2_ENDPOINT}/${R2_BUCKET}/${key}` });
    } catch (e) {
      return res.status(500).json({ error: 'Erro ao enviar para R2: ' + e.message });
    }
  }

  // ============================================================
  // IXC — parsing de cabecalhos e descoberta de autenticacao
  // (usado pela EDICAO/PUT — limpar MAC — e pela LISTAGEM/GET — diagnostico)
  // ============================================================
  const ixcUrl    = req.headers['x-ixc-url'];
  const ixcToken  = req.headers['x-ixc-token'];
  const ixcUser   = req.headers['x-ixc-user'] || '';
  const ixcSecret = req.headers['x-ixc-secret'] || '';
  const endpoint  = req.headers['x-ixc-endpoint'];
  const ixcMethod = (req.headers['x-ixc-method'] || 'GET').toUpperCase();
  const params    = req.body?.params || {};
  const rp        = req.body?.rp || params.rp || '100';
  if (!ixcUrl || !ixcToken || !endpoint) {
    return res.status(400).json({ error: 'Missing required headers' });
  }
  const base = ixcUrl.replace(/\/$/, '').replace(/\/adm\.php$/, '');

  // ===== Autenticacao (mesma logica de descoberta, reutilizada por listagem e edicao) =====
  const authCandidates = [];
  if (ixcUser) authCandidates.push({ label: 'Basic user:token',   value: `Basic ${Buffer.from(`${ixcUser}:${ixcToken}`).toString('base64')}` });
  authCandidates.push({             label: 'Basic token:',        value: `Basic ${Buffer.from(`${ixcToken}:`).toString('base64')}` });
  if (ixcUser && ixcSecret) authCandidates.push({ label: 'Basic user:secret', value: `Basic ${Buffer.from(`${ixcUser}:${ixcSecret}`).toString('base64')}` });

  const urlCandidates = [
    `${base}/webservice/v1/${endpoint}`,
    `${base}/adm.php/webservice/v1/${endpoint}`,
  ];

  // ============================================================
  // EDICAO (PUT) - limpar MAC do login (ixcsoft: 'editar')
  // O endpoint ja vem com o id: ex "radusuarios/1234"
  // ============================================================
  if (ixcMethod === 'PUT') {
    const editBody = JSON.stringify(params); // payload completo do registro
    const results = [];
    for (const url of urlCandidates) {
      for (const { label, value } of authCandidates) {
        try {
          const response = await fetch(url, {
            method: 'PUT',
            headers: {
              'Authorization': value,
              'Content-Type': 'application/json',
              'ixcsoft': 'editar',
            },
            body: editBody,
          });
          const text   = await response.text();
          const isHtml = text.trim().startsWith('<');
          results.push({ url, auth: label, status: response.status, isHtml, preview: text.slice(0, 200) });
          if (!isHtml && response.status >= 200 && response.status < 400) {
            try {
              const data = JSON.parse(text);
              return res.status(200).json({ ...data, _workingUrl: url, _auth: label });
            } catch { /* not valid JSON */ }
          }
        } catch (e) {
          results.push({ url, auth: label, error: e.message });
        }
      }
    }
    const got401e = results.find(r => r.status === 401 && !r.isHtml);
    const hintE = got401e
      ? `Endpoint correto (${got401e.url}) mas credenciais invalidas. Verifique o token.`
      : results.find(r => !r.isHtml)?.preview || 'Nenhum endpoint respondeu como API.';
    return res.status(401).json({ error: 'Edicao IXC falhou.', hint: hintE, results });
  }

  // ============================================================
  // LISTAGEM (GET) - diagnostico IXC (ixcsoft: 'listar')
  // ============================================================
  const apiBody = JSON.stringify({
    qtype:     params.qtype     || '',
    query:     params.query     || '',
    oper:      params.oper      || '=',
    page:      params.page      || '1',
    rp:        String(rp),
    sortname:  params.sortname  || 'id',
    sortorder: params.sortorder || 'desc',
  });
  const results = [];
  for (const rawUrl of urlCandidates) {
    const url = rawUrl;
    for (const { label, value } of authCandidates) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': value,
            'Content-Type': 'application/json',
            'ixcsoft': 'listar',
          },
          body: apiBody,
        });
        const text   = await response.text();
        const isHtml = text.trim().startsWith('<');
        results.push({ url, auth: label, status: response.status, isHtml, preview: text.slice(0, 200) });
        if (!isHtml && response.status >= 200 && response.status < 400) {
          try {
            const data = JSON.parse(text);
            return res.status(200).json({ ...data, _workingUrl: url, _auth: label });
          } catch { /* not valid JSON */ }
        }
      } catch (e) {
        results.push({ url, auth: label, error: e.message });
      }
    }
  }
  const got401 = results.find(r => r.status === 401 && !r.isHtml);
  const hint = got401
    ? `Endpoint correto (${got401.url}) mas credenciais invalidas. Verifique o token.`
    : results.find(r => !r.isHtml)?.preview || 'Nenhum endpoint respondeu como API.';
  return res.status(401).json({ error: 'Autenticacao falhou.', hint, results });
}
