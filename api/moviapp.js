// ════════════════════════════════════════════════════════════════
// MoviApp API — endpoint isolado para o app do cliente
// URL: https://movicontrol.vercel.app/api/moviapp
//
// Totalmente separado do ixc-proxy.js (MoviControl) para que
// mudanças aqui nunca afetem o sistema administrativo.
//
// Rotas (header x-target):
//   • admin       → criar_cliente_app (libera acesso ao app)
//   • cliente     → get_faturas | get_pix | get_status | debug_ixc
//
// Env vars (compartilhadas com o projeto Vercel):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IXC_URL, IXC_TOKEN, IXC_USER
// ════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-target');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPA_URL  = process.env.SUPABASE_URL || 'https://mgtetsmcswdtvsgewcen.supabase.co';
  const SRV       = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const IXC_URL   = process.env.IXC_URL   || '';
  const IXC_TOKEN = process.env.IXC_TOKEN || '';
  const IXC_USER  = process.env.IXC_USER  || '';

  const target = (req.headers['x-target'] || '').toLowerCase();
  const b = req.body || {};
  const srvH = { 'apikey': SRV, 'Authorization': `Bearer ${SRV}`, 'Content-Type': 'application/json' };

  // ══════════════════════════════════════════════════════════════
  // ADMIN — criar acesso de cliente ao MoviApp
  // Acionado pelo MoviControl (botão "Liberar MoviApp")
  // ══════════════════════════════════════════════════════════════
  if (target === 'admin') {
    if (!SRV) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY nao configurada.' });

    if (b.action === 'criar_cliente_app') {
      // Valida que o solicitante é admin/operador
      const token = (b.access_token || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')) || '';
      if (!token) return res.status(401).json({ error: 'Token do solicitante ausente.' });

      let callerId = null;
      try {
        const rv = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { 'apikey': SRV, 'Authorization': `Bearer ${token}` } });
        if (!rv.ok) return res.status(401).json({ error: 'Sessao invalida.' });
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
        return res.status(403).json({ error: 'Apenas administradores podem liberar o MoviApp.' });
      }

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

      // Cria o user no Supabase Auth (server-side, não afeta sessão do admin)
      let userId = null;
      try {
        const ru = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
          method: 'POST', headers: srvH,
          body: JSON.stringify({ email, password: senha, email_confirm: true, user_metadata: { nome, cpf, whatsapp } })
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
          await fetch(`${SUPA_URL}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: srvH });
          return res.status(rc.status).json({ error: 'Login criado mas falhou ao vincular: ' + (dc.message || tc.slice(0, 200)) });
        }
        return res.status(200).json({
          ok: true, user_id: userId, cpf, senha_inicial: senha,
          mensagem: `Acesso criado. Senha inicial: ${senha} (ultimos 4 digitos do CPF).`
        });
      } catch (e) { return res.status(502).json({ error: 'Erro ao vincular cliente: ' + e.message }); }
    }

    return res.status(400).json({ error: 'Acao admin desconhecida.' });
  }

  // ══════════════════════════════════════════════════════════════
  // CLIENTE — dados do app (faturas, pix, status)
  // Valida JWT do cliente, busca ixc_id, chama IXC server-side
  // ══════════════════════════════════════════════════════════════
  if (target === 'cliente') {
    if (!SRV)       return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY nao configurada.' });
    if (!IXC_URL)   return res.status(500).json({ error: 'IXC_URL nao configurada.' });
    if (!IXC_TOKEN) return res.status(500).json({ error: 'IXC_TOKEN nao configurada.' });

    // 1) Decodificar JWT do cliente (sem chamada HTTP)
    const jwt = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return res.status(401).json({ error: 'Token ausente.' });

    let clienteUserId = null;
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
      clienteUserId = payload.sub;
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000))
        return res.status(401).json({ error: 'Sessao expirada.' });
    } catch (e) { return res.status(401).json({ error: 'Token invalido.' }); }
    if (!clienteUserId) return res.status(401).json({ error: 'Token sem identificador.' });

    // 2) Buscar cliente_id e ixc_id
    let clienteIdLocal = null;
    try {
      const r1 = await fetch(`${SUPA_URL}/rest/v1/clientes_app?id=eq.${clienteUserId}&select=cliente_id`, { headers: srvH });
      const d1 = await r1.json();
      clienteIdLocal = d1?.[0]?.cliente_id || null;
    } catch (e) {}
    if (!clienteIdLocal) return res.status(404).json({ error: 'Acesso nao configurado. Contate o suporte.' });

    let ixcId = null;
    try {
      const r2 = await fetch(`${SUPA_URL}/rest/v1/clientes?id=eq.${clienteIdLocal}&select=ixc_id`, { headers: srvH });
      const d2 = await r2.json();
      ixcId = d2?.[0]?.ixc_id || null;
    } catch (e) {}
    if (!ixcId) return res.status(404).json({ error: 'Cliente sem vinculo IXC.' });

    const action  = b.action || 'get_faturas';
    const ixcBase = IXC_URL.replace(/\/$/, '').replace(/\/adm\.php$/, '');
    const auth    = `Basic ${Buffer.from(`${IXC_USER}:${IXC_TOKEN}`).toString('base64')}`;
    const ixcH    = { 'Authorization': auth, 'Content-Type': 'application/json', 'ixcsoft': 'listar' };

    // Helper: campo desbloqueio_confianca do contrato tem 3 estados no IXC:
    // 'S' = Habilitado | 'N' = Desabilitado | 'P' (ou vazio) = Padrão (usa o parametro geral do sistema)
    // O parametro geral fica em Parametros > Contratos 2 > Desbloqueio de confianca,
    // e nao tem endpoint de leitura via webservice — por isso o valor default abaixo
    // precisa ser atualizado manualmente (env IXC_DESBLOQUEIO_CONFIANCA_PADRAO) se
    // o parametro geral do IXC for alterado.
    function _habilitadoConfianca(valorContrato) {
      const padraoGlobal = (process.env.IXC_DESBLOQUEIO_CONFIANCA_PADRAO || 'S').toUpperCase();
      const v = (valorContrato || '').toUpperCase();
      if (v === 'S') return true;
      if (v === 'N') return false;
      return padraoGlobal === 'S'; // 'P' ou vazio cai aqui
    }

    // Helper: acha o id (ixc) do contrato ATIVO do cliente, via Supabase (ja sincronizado)
    async function _buscarContratoAtivoIxcId() {
      const r = await fetch(
        `${SUPA_URL}/rest/v1/clientes_contratos?cliente_id=eq.${clienteIdLocal}&status_contrato=in.(A,Ativo,ativo)&select=ixc_id&order=updated_at.desc&limit=1`,
        { headers: srvH }
      );
      const d = await r.json();
      return d?.[0]?.ixc_id || null;
    }

    // Helper: busca o registro do contrato direto no IXC (campos de desbloqueio em confianca)
    async function _buscarContratoIXC(ixcContratoId) {
      const url = `${ixcBase}/webservice/v1/cliente_contrato`;
      const apiBody = JSON.stringify({
        qtype: 'cliente_contrato.id', query: String(ixcContratoId), oper: '=',
        page: '1', rp: '1', sortname: 'id', sortorder: 'desc',
      });
      const r = await fetch(url, { method: 'POST', headers: ixcH, body: apiBody });
      const txt = await r.text();
      if (txt.trim().startsWith('<')) throw new Error('IXC retornou HTML ao consultar contrato.');
      const d = JSON.parse(txt);
      return d?.registros?.[0] || null;
    }

    // ── get_faturas ──────────────────────────────────────────────
    if (action === 'get_faturas') {
      const url = `${ixcBase}/webservice/v1/fn_areceber`;
      const apiBody = JSON.stringify({
        qtype: 'fn_areceber.id_cliente', query: String(ixcId), oper: '=',
        page: '1', rp: '20', sortname: 'fn_areceber.data_vencimento', sortorder: 'desc',
      });
      try {
        const r = await fetch(url, { method: 'POST', headers: ixcH, body: apiBody });
        const txt = await r.text();
        if (txt.trim().startsWith('<')) return res.status(502).json({ error: 'IXC retornou HTML', preview: txt.slice(0,200) });
        let d;
        try { d = JSON.parse(txt); } catch(e) { return res.status(502).json({ error: 'JSON invalido', raw: txt.slice(0,300) }); }
        const registros = (d.registros || []).map(f => ({
          id:              f.id,
          valor:           f.valor,
          data_vencimento: f.data_vencimento,
          data_pagamento:  f.data_pagamento || f.data_recebimento,
          status:          (f.status === 'R' ? 'pago' : (f.status === 'C' ? 'cancelado' : 'aberto')),
          status_raw:      f.status,
          linha_digitavel: f.linha_digitavel,
          nosso_numero:    f.nosso_numero,
          documento:       f.documento,
          gateway_link:    f.gateway_link,
        }));
        return res.status(200).json({ ok: true, total: parseInt(d.total || registros.length), registros });
      } catch (e) { return res.status(502).json({ error: 'Erro IXC', message: e.message }); }
    }

    // ── get_pix ──────────────────────────────────────────────────
    if (action === 'get_pix') {
      const idAreceber = b.id_areceber || b.id;
      if (!idAreceber) return res.status(400).json({ error: 'Informe id_areceber.' });
      const auth2 = `Basic ${Buffer.from(`${IXC_USER}:${IXC_TOKEN}`).toString('base64')}`;
      const urls = [`${ixcBase}/webservice/v1/get_pix`, `${ixcBase}/adm.php/webservice/v1/get_pix`];
      const apiBody = JSON.stringify({ id_areceber: String(idAreceber) });
      const debug = [];
      for (const url of urls) {
        try {
          const r = await fetch(url, { method: 'POST', headers: { 'Authorization': auth2, 'Content-Type': 'application/json' }, body: apiBody });
          const txt = await r.text();
          if (txt.trim().startsWith('<')) { debug.push({ url, status: r.status, html: true }); continue; }
          let d;
          try { d = JSON.parse(txt); } catch(e) { debug.push({ url, raw: txt.slice(0,200) }); continue; }
          const pixCode = d.pix || d.qrCode || d.qrcode || d.emv || d.pix_copia_cola || d.payload || d.codigo_pix || null;
          if (pixCode) {
            return res.status(200).json({ ok: true, pix_copia_cola: pixCode, imagem_base64: d.imagem_base64 || d.qrcode_base64 || null, validade: d.validade || null });
          }
          debug.push({ url, status: r.status, resposta: d });
        } catch(e) { debug.push({ url, error: e.message }); }
      }
      return res.status(502).json({ error: 'Nao foi possivel gerar PIX', id_areceber: idAreceber, _debug: debug });
    }

    // ── get_status ───────────────────────────────────────────────
    if (action === 'get_status') {
      // Lê direto do Supabase (já sincronizado) — mais rápido que IXC
      try {
        const r = await fetch(`${SUPA_URL}/rest/v1/clientes_logins?cliente_id=eq.${clienteIdLocal}&ativo=eq.true&select=online,plano,velocidade_mbps`, { headers: srvH });
        const d = await r.json();
        const login = d?.[0];
        if (login) return res.status(200).json({ ok: true, online: login.online === true, plano: login.plano, velocidade_mbps: login.velocidade_mbps });
        return res.status(200).json({ ok: true, online: false });
      } catch(e) { return res.status(502).json({ error: 'Erro ao buscar status', message: e.message }); }
    }

    // ── status_desbloqueio_confianca ────────────────────────────
    // Consulta os campos de confianca do contrato ativo no IXC e
    // diz se o cliente esta elegivel a usar o recurso agora.
    // Só faz sentido quando o acesso está REALMENTE bloqueado
    // (status_internet diferente de Ativo/Aguardando assinatura).
    if (action === 'status_desbloqueio_confianca') {
      try {
        const ixcContratoId = await _buscarContratoAtivoIxcId();
        if (!ixcContratoId) return res.status(404).json({ error: 'Contrato ativo nao encontrado.' });

        const ctr = await _buscarContratoIXC(ixcContratoId);
        if (!ctr) return res.status(404).json({ error: 'Contrato nao encontrado no IXC.' });

        const statusInternet = (ctr.status_internet || ctr.status_acesso || '').toUpperCase();
        const bloqueado    = !['A', 'AA', ''].includes(statusInternet); // tudo que nao for Ativo/Ag.Assinatura conta como bloqueado
        const habilitado  = _habilitadoConfianca(ctr.desbloqueio_confianca);
        const jaAtivo     = ctr.desbloqueio_confianca_ativo === 'S';
        const restrito     = ctr.restricao_auto_desbloqueio === 'S';
        const elegivel     = bloqueado && habilitado && !jaAtivo && !restrito;

        return res.status(200).json({
          ok: true,
          bloqueado,
          elegivel,
          habilitado,
          ja_ativo: jaAtivo,
          restrito,
          motivo_restricao: ctr.motivo_restricao_auto_desbloq || null,
          ultimo_uso: ctr.dt_ult_des_bloq_conf || null,
        });
      } catch (e) { return res.status(502).json({ error: 'Erro ao consultar IXC', message: e.message }); }
    }

    // ── solicitar_desbloqueio_confianca ─────────────────────────
    // Re-checa elegibilidade ao vivo (evita corrida/dado velho) e,
    // se ok, ativa desbloqueio_confianca_ativo='S' no contrato.
    if (action === 'solicitar_desbloqueio_confianca') {
      let ixcContratoId = null;
      try {
        ixcContratoId = await _buscarContratoAtivoIxcId();
        if (!ixcContratoId) return res.status(404).json({ error: 'Contrato ativo nao encontrado.' });

        const ctr = await _buscarContratoIXC(ixcContratoId);
        if (!ctr) return res.status(404).json({ error: 'Contrato nao encontrado no IXC.' });

        const statusInternet = (ctr.status_internet || ctr.status_acesso || '').toUpperCase();
        const bloqueado   = !['A', 'AA', ''].includes(statusInternet);
        const habilitado = _habilitadoConfianca(ctr.desbloqueio_confianca);
        const jaAtivo    = ctr.desbloqueio_confianca_ativo === 'S';
        const restrito    = ctr.restricao_auto_desbloqueio === 'S';

        if (!bloqueado || !habilitado || jaAtivo || restrito) {
          // Loga tentativa negada para auditoria
          await fetch(`${SUPA_URL}/rest/v1/desbloqueios_confianca_log`, {
            method: 'POST', headers: srvH,
            body: JSON.stringify({
              cliente_id: clienteIdLocal, ixc_contrato_id: String(ixcContratoId),
              sucesso: false,
              motivo: !bloqueado ? 'Contrato nao esta bloqueado' : (restrito ? (ctr.motivo_restricao_auto_desbloq || 'Restrito pelo IXC') : (jaAtivo ? 'Ja ativo' : 'Recurso nao habilitado para este contrato')),
            }),
          }).catch(()=>{});
          return res.status(403).json({
            error: 'Nao elegivel para desbloqueio em confianca.',
            motivo_restricao: ctr.motivo_restricao_auto_desbloq || null,
            bloqueado, restrito, ja_ativo: jaAtivo, habilitado,
          });
        }

        // Ativa no IXC — o endpoint exige o registro completo (valida campos
        // obrigatorios mesmo em edicao), entao reenviamos tudo que veio no GET
        // e so sobrescrevemos o campo que queremos mudar.
        const payloadPut = { ...ctr, desbloqueio_confianca_ativo: 'S' };
        delete payloadPut.id; // id vai na URL, nao no corpo

        const urlPut = `${ixcBase}/webservice/v1/cliente_contrato/${ixcContratoId}`;
        const rPut = await fetch(urlPut, {
          method: 'PUT',
          headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'ixcsoft': 'editar' },
          body: JSON.stringify(payloadPut),
        });
        const txtPut = await rPut.text();
        const isHtml = txtPut.trim().startsWith('<');
        let dPut; try { dPut = JSON.parse(txtPut); } catch { dPut = { raw: txtPut.slice(0,300) }; }

        const sucesso = !isHtml && rPut.status >= 200 && rPut.status < 300 && dPut?.type !== 'error';

        await fetch(`${SUPA_URL}/rest/v1/desbloqueios_confianca_log`, {
          method: 'POST', headers: srvH,
          body: JSON.stringify({
            cliente_id: clienteIdLocal, ixc_contrato_id: String(ixcContratoId),
            sucesso, resposta_ixc: dPut, motivo: sucesso ? null : 'Falha no PUT ao IXC',
          }),
        }).catch(()=>{});

        if (!sucesso) return res.status(502).json({ error: dPut?.message || 'Falha ao ativar no IXC.', detalhe: dPut });
        return res.status(200).json({ ok: true, mensagem: 'Desbloqueio em confianca ativado. A liberacao do acesso pode levar alguns minutos.' });
      } catch (e) {
        await fetch(`${SUPA_URL}/rest/v1/desbloqueios_confianca_log`, {
          method: 'POST', headers: srvH,
          body: JSON.stringify({ cliente_id: clienteIdLocal, ixc_contrato_id: String(ixcContratoId||''), sucesso: false, motivo: e.message }),
        }).catch(()=>{});
        return res.status(502).json({ error: 'Erro ao processar desbloqueio.', message: e.message });
      }
    }

    // ── debug_ixc ────────────────────────────────────────────────
    if (action === 'debug_ixc') {
      const ep = b.endpoint || 'fn_areceber';
      const url = `${ixcBase}/webservice/v1/${ep}`;
      const apiBody = JSON.stringify({ qtype: `${ep}.id_cliente`, query: String(ixcId), oper: '=', page: '1', rp: '3', sortname: 'id', sortorder: 'desc' });
      try {
        const r = await fetch(url, { method: 'POST', headers: ixcH, body: apiBody });
        const txt = await r.text();
        if (txt.trim().startsWith('<')) return res.status(200).json({ endpoint: ep, html: true, preview: txt.slice(0,300) });
        const d = JSON.parse(txt);
        const sample = d.registros?.[0] || null;
        return res.status(200).json({ endpoint: ep, total: d.total, campos: sample ? Object.keys(sample) : [], sample });
      } catch(e) { return res.status(200).json({ endpoint: ep, error: e.message }); }
    }

    return res.status(400).json({ error: 'Acao desconhecida.' });
  }

  return res.status(400).json({ error: 'x-target invalido. Use admin ou cliente.' });
}
