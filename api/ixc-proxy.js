export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ixc-url, x-ixc-token, x-ixc-user, x-ixc-endpoint, x-ixc-secret, x-ixc-method, x-target');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ============================================================
  // SUPABASE ADMIN - cria o tecnico INTEIRAMENTE no servidor.
  // Nenhum signUp roda no navegador => a sessao do admin nunca e afetada.
  // Acionado pelo header x-target: supabase-admin
  // Requer a variavel de ambiente SUPABASE_SERVICE_ROLE_KEY (Vercel).
  // ============================================================
  if ((req.headers['x-target'] || '').toLowerCase() === 'supabase-admin') {
    const SUPA_URL = process.env.SUPABASE_URL || 'https://mgtetsmcswdtvsgewcen.supabase.co';
    const SRV = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!SRV) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY nao configurada no servidor (Vercel > Settings > Environment Variables).' });
    const b = req.body || {};
    const srvH = { 'apikey': SRV, 'Authorization': `Bearer ${SRV}`, 'Content-Type': 'application/json' };

    // 1) Valida que o solicitante e admin/operador (protege o endpoint)
    const token = (b.access_token || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')) || '';
    if (!token) return res.status(401).json({ error: 'Token do solicitante ausente.' });
    let callerId = null;
    try {
      const rv = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { 'apikey': SRV, 'Authorization': `Bearer ${token}` } });
      if (!rv.ok) return res.status(401).json({ error: 'Sessao do solicitante invalida.' });
      const vu = await rv.json();
      callerId = vu.id;
    } catch (e) { return res.status(401).json({ error: 'Falha ao validar solicitante.' }); }
    let callerPerfil = null;
    try {
      const rp = await fetch(`${SUPA_URL}/rest/v1/perfis?id=eq.${callerId}&select=perfil`, { headers: srvH });
      const pj = await rp.json();
      callerPerfil = Array.isArray(pj) && pj[0] ? pj[0].perfil : null;
    } catch (e) {}
    if (!['admin', 'operador'].includes(callerPerfil)) {
      return res.status(403).json({ error: 'Apenas administradores podem cadastrar tecnicos.' });
    }

    if (b.action === 'criar_tecnico') {
      const email = (b.email || '').trim().toLowerCase();
      const senha = b.senha || '';
      const nome  = (b.nome || '').trim();
      const telefone = b.telefone || null;
      const status = b.status || 'ativo';
      if (!email || !senha || !nome) return res.status(400).json({ error: 'Informe nome, e-mail e senha.' });
      if (senha.length < 6) return res.status(400).json({ error: 'A senha precisa ter ao menos 6 caracteres.' });

      // 2) Cria o login via Admin API (no servidor — nao mexe em sessao alguma)
      let userId = null;
      try {
        const ru = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
          method: 'POST', headers: srvH,
          body: JSON.stringify({ email, password: senha, email_confirm: true, user_metadata: { nome } })
        });
        const tu = await ru.text(); let du; try { du = JSON.parse(tu); } catch { du = {}; }
        if (!ru.ok) {
          const msg = du.msg || du.message || du.error_description || tu.slice(0, 200);
          if (/already|exist|registered|duplicate/i.test(msg)) {
            return res.status(409).json({ error: 'Este e-mail ja esta cadastrado. Use outro e-mail.' });
          }
          return res.status(ru.status).json({ error: 'Falha ao criar login: ' + msg });
        }
        userId = du.id || (du.user && du.user.id);
      } catch (e) { return res.status(502).json({ error: 'Erro ao criar login: ' + e.message }); }
      if (!userId) return res.status(502).json({ error: 'Login criado sem ID retornado.' });

      // 3) Perfil = tecnico (upsert; o gatilho ja cria perfil='user')
      try {
        await fetch(`${SUPA_URL}/rest/v1/perfis?on_conflict=id`, {
          method: 'POST', headers: { ...srvH, 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({ id: userId, nome, perfil: 'tecnico', email })
        });
      } catch (e) {}

      // 4) Registro em campo_tecnicos
      try {
        const rt = await fetch(`${SUPA_URL}/rest/v1/campo_tecnicos`, {
          method: 'POST', headers: { ...srvH, 'Prefer': 'return=representation' },
          body: JSON.stringify({ nome, telefone, status, user_id: userId })
        });
        const tt = await rt.text(); let dt; try { dt = JSON.parse(tt); } catch { dt = {}; }
        if (!rt.ok) return res.status(rt.status).json({ error: 'Login criado, mas falhou em campo_tecnicos: ' + (dt.message || tt.slice(0, 200)) });
        return res.status(200).json({ ok: true, user_id: userId, tecnico: Array.isArray(dt) ? dt[0] : dt });
      } catch (e) { return res.status(502).json({ error: 'Erro ao registrar tecnico: ' + e.message }); }
    }

    return res.status(400).json({ error: 'Acao desconhecida.' });
  }

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
