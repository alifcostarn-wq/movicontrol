export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ixc-url, x-ixc-token, x-ixc-user, x-ixc-endpoint, x-ixc-secret, x-ixc-method, x-target');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ============================================================
  // EVOTRIX - envio de WhatsApp via template (CLOUD API)
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
    // Tenta as URLs/autenticacoes mais provaveis. NAO para no primeiro 404
    // (pode ser apenas URL errada); coleta tudo e escolhe a melhor resposta.
    const evoUrls = [
      'https://api.evotrix.com.br/v1/whatsapp/notifications/text',
      'https://api.evotrix.com.br/whatsapp/notifications/text',
    ];
    const evoAuths = [
      { label: 'Bearer',        headers: { 'Authorization': `Bearer ${apiKey}` } },
      { label: 'Authorization', headers: { 'Authorization': apiKey } },
      { label: 'x-api-key',     headers: { 'x-api-key': apiKey } },
      { label: 'token',         headers: { 'token': apiKey } },
    ];
    const evoResults = [];
    // prioridade da resposta: quanto maior, melhor candidato a "resposta util"
    const prioridade = (st, hasMsg) => {
      if (st >= 200 && st < 300) return 100;
      if (st === 422) return 80;             // chegou no endpoint, parametro errado
      if (st === 404 && hasMsg) return 70;   // 404 de negocio (canal/template)
      if (st === 401) return 60;             // auth errada, mas endpoint existe
      if (st === 400) return 50;
      if (st === 404) return 20;             // 404 "puro" = provavel URL errada
      return 10;
    };
    let melhor = null;
    for (const url of evoUrls) {
      for (const a of evoAuths) {
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...a.headers },
            body: JSON.stringify(payload),
          });
          const text = await r.text();
          let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
          const hasMsg = !!(data && (data.message || data.error || data.mensagem));
          const cand = { url, auth: a.label, status: r.status, data, prio: prioridade(r.status, hasMsg) };
          evoResults.push({ url, auth: a.label, status: r.status, body: text.slice(0, 200) });
          // log para aparecer no Vercel runtime logs
          console.log(`[evotrix] ${a.label} ${url} -> ${r.status} ${text.slice(0,160)}`);
          if (r.status >= 200 && r.status < 300) {
            return res.status(200).json({ ok: true, evotrix: data, _url: url, _auth: a.label });
          }
          if (!melhor || cand.prio > melhor.prio) melhor = cand;
        } catch (e) {
          evoResults.push({ url, auth: a.label, error: e.message });
          console.log(`[evotrix] ${a.label} ${url} -> ERRO ${e.message}`);
        }
      }
    }
    // Retorna a resposta mais informativa que conseguimos
    if (melhor) {
      return res.status(melhor.status).json({ ok: false, evotrix: melhor.data, _url: melhor.url, _auth: melhor.auth, results: evoResults });
    }
    return res.status(502).json({ error: 'Falha ao enviar pela Evotrix.', results: evoResults });
  }

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
  // EDICAO (PUT) - ex: limpar MAC do login (ixcsoft: 'editar')
  // O endpoint ja vem com o id: ex "cliente_login/1234"
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
  // INCLUSAO (INSERT) - ex: enviar SMS (ixcsoft: 'incluir')
  // POST no endpoint da tabela com o corpo do registro
  // ============================================================
  if (ixcMethod === 'INSERT') {
    const insBody = JSON.stringify(params); // campos do novo registro
    const results = [];
    for (const url of urlCandidates) {
      for (const { label, value } of authCandidates) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': value,
              'Content-Type': 'application/json',
              'ixcsoft': 'incluir',
            },
            body: insBody,
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
    const got401i = results.find(r => r.status === 401 && !r.isHtml);
    const hintI = got401i
      ? `Endpoint correto (${got401i.url}) mas credenciais invalidas. Verifique o token.`
      : results.find(r => !r.isHtml)?.preview || 'Nenhum endpoint respondeu como API.';
    return res.status(401).json({ error: 'Inclusao IXC falhou.', hint: hintI, results });
  }

  // ============================================================
  // LISTAGEM (GET) - logica original, intacta
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
