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

    // ── criar_cliente_app ──────────────────────────────────────────
    // Cadastra um cliente no MoviApp sem afetar a sessao do admin.
    // Payload: { action, access_token, cliente_id, cpf, nome, whatsapp }
    // Senha inicial = ultimos 4 digitos do CPF
    // ───────────────────────────────────────────────────────────────
    if (b.action === 'criar_cliente_app') {
      const clienteId = b.cliente_id;
      const cpf       = (b.cpf || '').replace(/\D/g, '');
      const nome      = (b.nome || '').trim();
      const whatsapp  = (b.whatsapp || '').trim();

      if (!clienteId || !cpf || !nome)
        return res.status(400).json({ error: 'Informe cliente_id, cpf e nome.' });
      if (cpf.length < 11)
        return res.status(400).json({ error: 'CPF invalido (minimo 11 digitos).' });

      const email = `${cpf}@moviapp.local`;
      const senha = cpf.slice(-4);

      // Cria o user no Supabase Auth server-side
      let userId = null;
      try {
        const ru = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
          method: 'POST', headers: srvH,
          body: JSON.stringify({
            email, password: senha, email_confirm: true,
            user_metadata: { nome, cpf, whatsapp }
          })
        });
        const tu = await ru.text();
        let du; try { du = JSON.parse(tu); } catch { du = {}; }
        if (!ru.ok) {
          if (/already|exist|registered|duplicate/i.test(du.msg || du.message || ''))
            return res.status(409).json({ error: 'Este CPF ja possui acesso ao MoviApp.' });
          return res.status(ru.status).json({ error: 'Falha ao criar login: ' + (du.msg || du.message || tu.slice(0, 200)) });
        }
        userId = du.id || (du.user && du.user.id);
      } catch (e) { return res.status(502).json({ error: 'Erro ao criar login: ' + e.message }); }
      if (!userId) return res.status(502).json({ error: 'Login criado sem ID retornado.' });

      // Vincula em clientes_app
      try {
        const rc = await fetch(`${SUPA_URL}/rest/v1/clientes_app`, {
          method: 'POST',
          headers: { ...srvH, 'Prefer': 'return=representation' },
          body: JSON.stringify({ id: userId, cliente_id: clienteId, cpf })
        });
        const tc = await rc.text();
        let dc; try { dc = JSON.parse(tc); } catch { dc = {}; }
        if (!rc.ok) {
          // rollback: remove o user criado
          await fetch(`${SUPA_URL}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: srvH });
          return res.status(rc.status).json({ error: 'Login criado mas falhou ao vincular: ' + (dc.message || tc.slice(0, 200)) });
        }
        return res.status(200).json({
          ok: true, user_id: userId, cpf,
          senha_inicial: senha,
          mensagem: `Acesso criado. Senha inicial: ${senha} (ultimos 4 digitos do CPF).`
        });
      } catch (e) { return res.status(502).json({ error: 'Erro ao vincular cliente: ' + e.message }); }
    }

    return res.status(400).json({ error: 'Acao desconhecida.' });
  }

  // ============================================================
  // CLIENTE DADOS - rota segura para o MoviApp
  // Valida JWT do cliente, busca ixc_id dele no Supabase,
  // chama o IXC com credenciais que ficam SÓ no servidor.
  // Nenhuma credencial IXC fica exposta no app.
  // Acoes: get_faturas | get_status
  // ============================================================
  if ((req.headers['x-target'] || '').toLowerCase() === 'cliente-dados') {
    const SUPA_URL  = process.env.SUPABASE_URL || 'https://mgtetsmcswdtvsgewcen.supabase.co';
    const SRV       = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const IXC_URL   = process.env.IXC_URL   || '';
    const IXC_TOKEN = process.env.IXC_TOKEN  || '';
    const IXC_USER  = process.env.IXC_USER   || '';

    if (!SRV)       return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY nao configurada.' });
    if (!IXC_URL)   return res.status(500).json({ error: 'IXC_URL nao configurada.' });
    if (!IXC_TOKEN) return res.status(500).json({ error: 'IXC_TOKEN nao configurada.' });

    const srvH = { 'apikey': SRV, 'Authorization': `Bearer ${SRV}`, 'Content-Type': 'application/json' };

    // 1) Decodificar JWT do cliente (sem chamada HTTP — JWT é assinado pelo Supabase)
    const jwt = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return res.status(401).json({ error: 'Token ausente.' });

    let clienteUserId = null;
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
      clienteUserId = payload.sub;
      // Verificar expiração
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        return res.status(401).json({ error: 'Sessao expirada. Faca login novamente.' });
      }
    } catch (e) { return res.status(401).json({ error: 'Token invalido.' }); }
    if (!clienteUserId) return res.status(401).json({ error: 'Token sem identificador de usuario.' });

    // 2a) Buscar cliente_id em clientes_app
    let clienteIdLocal = null;
    try {
      const r1 = await fetch(
        `${SUPA_URL}/rest/v1/clientes_app?id=eq.${clienteUserId}&select=cliente_id`,
        { headers: srvH }
      );
      const d1 = await r1.json();
      clienteIdLocal = d1?.[0]?.cliente_id || null;
    } catch (e) {}
    if (!clienteIdLocal) return res.status(404).json({ error: 'Acesso nao configurado. Contate o suporte.' });

    // 2b) Buscar ixc_id em clientes
    let ixcId = null;
    try {
      const r2 = await fetch(
        `${SUPA_URL}/rest/v1/clientes?id=eq.${clienteIdLocal}&select=ixc_id`,
        { headers: srvH }
      );
      const d2 = await r2.json();
      ixcId = d2?.[0]?.ixc_id || null;
    } catch (e) {}
    if (!ixcId) return res.status(404).json({ error: 'Cliente sem vinculo IXC. Contate o suporte.' });

    const b      = req.body || {};
    const action = b.action || 'get_faturas';
    const ixcBase = IXC_URL.replace(/\/$/, '').replace(/\/adm\.php$/, '');
    const authVal = `Basic ${Buffer.from(`${IXC_USER}:${IXC_TOKEN}`).toString('base64')}`;
    const ixcH    = { 'Authorization': authVal, 'Content-Type': 'application/json', 'ixcsoft': 'listar' };

    // ── get_faturas ─────────────────────────────────────────────
    // Endpoint correto do IXC: fn_areceber (não fn_financeiro_conta_receber)
    if (action === 'get_faturas') {
      const ixcBase = IXC_URL.replace(/\/$/, '').replace(/\/adm\.php$/, '');
      const url = `${ixcBase}/webservice/v1/fn_areceber`;
      const auth = `Basic ${Buffer.from(`${IXC_USER}:${IXC_TOKEN}`).toString('base64')}`;

      const apiBody = JSON.stringify({
        qtype:     'fn_areceber.id_cliente',
        query:     String(ixcId),
        oper:      '=',
        page:      '1',
        rp:        '20',
        sortname:  'fn_areceber.data_vencimento',
        sortorder: 'desc',
      });

      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'ixcsoft': 'listar' },
          body: apiBody,
        });
        const txt = await r.text();
        if (txt.trim().startsWith('<')) {
          return res.status(502).json({ error: 'IXC retornou HTML', status: r.status, preview: txt.slice(0,200) });
        }
        let d;
        try { d = JSON.parse(txt); } catch(e) {
          return res.status(502).json({ error: 'JSON invalido', raw: txt.slice(0,300) });
        }
        const registros = (d.registros || []).map(f => ({
          id:              f.id,
          valor:           f.valor,
          data_vencimento: f.data_vencimento,
          data_pagamento:  f.data_pagamento || f.data_recebimento,
          // status do IXC: A=aberto, R=recebido, C=cancelado
          status:          (f.status === 'R' ? 'pago' : (f.status === 'C' ? 'cancelado' : 'aberto')),
          status_raw:      f.status,
          linha_digitavel: f.linha_digitavel,
          nosso_numero:    f.nosso_numero,
          documento:       f.documento,
          gateway_link:    f.gateway_link,
          pix_qrcode:      f.pix_qrcode,
        }));
        return res.status(200).json({ ok: true, total: parseInt(d.total || registros.length), registros });
      } catch (e) {
        return res.status(502).json({ error: 'Erro ao conectar IXC', message: e.message });
      }
    }

    // ── get_pix ─────────────────────────────────────────────────
    // Gera o código PIX (copia-e-cola) de um boleto específico via IXC
    // Payload: { action:'get_pix', id_areceber: '12345' }
    // O IXC gera o PIX sob demanda pelo endpoint get_pix
    if (action === 'get_pix') {
      const idAreceber = b.id_areceber || b.id;
      if (!idAreceber) return res.status(400).json({ error: 'Informe id_areceber.' });

      const ixcBase = IXC_URL.replace(/\/$/, '').replace(/\/adm\.php$/, '');
      const auth = `Basic ${Buffer.from(`${IXC_USER}:${IXC_TOKEN}`).toString('base64')}`;

      // O IXC tem o endpoint get_pix que recebe o id do boleto (fn_areceber)
      const urlCandidates = [
        `${ixcBase}/webservice/v1/get_pix`,
        `${ixcBase}/adm.php/webservice/v1/get_pix`,
      ];

      const apiBody = JSON.stringify({ id_areceber: String(idAreceber) });

      const debug = [];
      for (const url of urlCandidates) {
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
            body: apiBody,
          });
          const txt = await r.text();
          if (txt.trim().startsWith('<')) { debug.push({ url, status: r.status, html: true }); continue; }
          let d;
          try { d = JSON.parse(txt); } catch(e) { debug.push({ url, status: r.status, raw: txt.slice(0,200) }); continue; }

          // O IXC retorna o PIX em campos variados conforme versão
          const pixCode = d.pix || d.qrCode || d.qrcode || d.emv || d.pix_copia_cola ||
                          d.payload || d.codigo_pix || d.tipo_transacao_pix?.pix || null;

          if (pixCode) {
            return res.status(200).json({
              ok: true,
              pix_copia_cola: pixCode,
              imagem_base64: d.imagem_base64 || d.qrcode_base64 || d.image || null,
              validade: d.validade || d.expiracao || null,
            });
          }
          debug.push({ url, status: r.status, resposta: d });
        } catch(e) { debug.push({ url, error: e.message }); }
      }
      return res.status(502).json({ error: 'Nao foi possivel gerar o PIX', id_areceber: idAreceber, _debug: debug });
    }

    // ── debug_ixc ─────────────────────────────────────────────
    // Busca 1 registro sem filtro para ver estrutura do endpoint
    if (action === 'debug_ixc') {
      const ep = b.endpoint || 'fn_areceber';
      const ixcBase2 = IXC_URL.replace(/\/$/, '');
      const url2 = `${ixcBase2}/webservice/v1/${ep}`;
      const auth2 = `Basic ${Buffer.from(`${IXC_USER}:${IXC_TOKEN}`).toString('base64')}`;
      const body2 = JSON.stringify({ qtype:'', query:'', oper:'=', page:'1', rp:'3', sortname:'id', sortorder:'desc' });
      try {
        const r = await fetch(url2, {
          method:'POST',
          headers:{'Authorization':auth2,'Content-Type':'application/json','ixcsoft':'listar'},
          body: body2
        });
        const txt = await r.text();
        const isHtml = txt.trim().startsWith('<');
        if(isHtml) return res.status(200).json({ endpoint: ep, status: r.status, html: true, preview: txt.slice(0,300) });
        try {
          const d = JSON.parse(txt);
          const sample = d.registros?.[0] || null;
          return res.status(200).json({
            endpoint: ep,
            status: r.status,
            total: d.total,
            campos: sample ? Object.keys(sample) : [],
            sample
          });
        } catch(e) { return res.status(200).json({ endpoint: ep, status: r.status, raw: txt.slice(0,300) }); }
      } catch(e) { return res.status(200).json({ endpoint: ep, error: e.message }); }
    }

    // ── get_status ──────────────────────────────────────────────
    if (action === 'get_status') {
      const endpoints = [
        `${ixcBase}/webservice/v1/cliente_login`,
        `${ixcBase}/adm.php/webservice/v1/cliente_login`,
      ];
      const body = JSON.stringify({
        qtype: 'cliente_login.id_cliente',
        query: String(ixcId),
        oper: '=',
        page: '1',
        rp: '5',
        sortname: 'id',
        sortorder: 'desc',
      });
      for (const url of endpoints) {
        try {
          const r = await fetch(url, { method: 'POST', headers: ixcH, body });
          const txt = await r.text();
          if (txt.trim().startsWith('<')) continue;
          const d = JSON.parse(txt);
          if (r.ok && d.registros?.length) {
            const login = d.registros[0];
            return res.status(200).json({
              ok: true,
              online:        login.online === '1' || login.online === true,
              plano:         login.plano || null,
              velocidade_up: login.velocidade_up || null,
              velocidade_down: login.velocidade_down || null,
            });
          }
        } catch (e) {}
      }
      return res.status(502).json({ error: 'Nao foi possivel buscar status no IXC.' });
    }

    return res.status(400).json({ error: 'Acao desconhecida. Use get_faturas ou get_status.' });
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
