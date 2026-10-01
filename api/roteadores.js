// ============================================================================
// ROTEADORES (TR-069) — módulo do MoviOne
// ----------------------------------------------------------------------------
// O MoviOne enxerga e mexe no roteador/ONU de cada cliente pelo ACS (GenieACS)
// instalado no POP: online/offline, sinal da fibra, Wi-Fi, aparelhos, troca de
// senha do Wi-Fi, reinício e testes (ping, velocidade, rota). A conversa com o
// ACS mora em _acs.js; aqui ficam o login, a permissão e o registro.
//
// Quem entra: administrador, ou quem tiver "Roteadores" liberado na tela
// Usuários (perfis.roteadores — mesmo molde do MoviFiber). Técnico não entra
// (o painel dele é o campo.html). Visualizador liberado só olha.
//
// O equipamento de um cliente é achado pelo login PPPoE (clientes_logins, a
// cópia dos logins do IXC que o MoviOne já sincroniza) ou por um vínculo
// manual pelo número de série (roteador_vinculos).
// ============================================================================
import * as ACS from './_acs.js';

export const config = { maxDuration: 60 };

function env() {
  return {
    SUPA_URL: process.env.SUPABASE_URL || 'https://mgtetsmcswdtvsgewcen.supabase.co',
    SRV: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  };
}

async function sb(e, path, opts = {}) {
  const r = await fetch(`${e.SUPA_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: e.SRV, Authorization: `Bearer ${e.SRV}`, 'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

function erro(status, msg) { const err = new Error(msg); err.status = status; return err; }

export async function autenticar(e, req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw erro(401, 'Token ausente.');
  let userId;
  try {
    const r = await fetch(`${e.SUPA_URL}/auth/v1/user`, { headers: { apikey: e.SRV, Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error();
    userId = (await r.json()).id;
  } catch { throw erro(401, 'Sessão inválida ou expirada.'); }
  if (!/^[0-9a-f-]{36}$/i.test(String(userId || ''))) throw erro(401, 'Sessão inválida.');
  const p = (await sb(e, `perfis?id=eq.${userId}&select=id,nome,email,perfil,roteadores`))[0];
  if (!p || p.perfil === 'tecnico') throw erro(403, 'Sem acesso a este módulo.');
  const admin = p.perfil === 'admin';
  if (!admin && !p.roteadores) throw erro(403, 'Seu usuário não tem acesso aos Roteadores. Peça a um administrador (Usuários › Roteadores).');
  return { id: p.id, nome: p.nome || p.email, admin, podeAgir: admin || p.perfil !== 'visualizador' };
}

// ---------------------------------------------------------------- clientes
/* Logins PPPoE do cliente, da cópia do IXC que o MoviOne mantém. */
async function loginsDoCliente(e, ixcId) {
  const ls = await sb(e, `clientes_logins?ixc_cliente_id=eq.${encodeURIComponent(ixcId)}&select=login`);
  return [...new Set((ls || []).map(l => String(l.login || '').trim().toLowerCase()).filter(Boolean))];
}

/* Dono do equipamento: pelo login PPPoE gravado nele, ou pelo vínculo manual. */
async function clientesDoEquipamento(e, doc) {
  const login = String(ACS._val(ACS.achatar(doc), 'VirtualParameters.pppoe_login') || '').trim();
  const ids = new Set();
  if (login) {
    // ilike sem curinga = igual sem diferenciar maiúscula; "_" ainda é curinga
    // de um caractere no LIKE, por isso a conferência exata logo abaixo
    const ls = await sb(e, `clientes_logins?login=ilike.${encodeURIComponent(login.replace(/[%*]/g, ''))}&select=ixc_cliente_id,login`).catch(() => []);
    (ls || []).filter(l => String(l.login || '').trim().toLowerCase() === login.toLowerCase())
      .forEach(l => l.ixc_cliente_id && ids.add(String(l.ixc_cliente_id)));
  }
  const vs = await sb(e, `roteador_vinculos?device_id=eq.${encodeURIComponent(doc._id)}&select=cliente_ixc_id`).catch(() => []);
  const vinculados = new Set((vs || []).map(v => String(v.cliente_ixc_id)));
  vinculados.forEach(id => ids.add(id));
  if (!ids.size) return [];
  const cs = await sb(e, `clientes?ixc_id=in.(${[...ids].map(encodeURIComponent).join(',')})&select=ixc_id,nome,razao`).catch(() => []);
  const nome = Object.fromEntries((cs || []).map(c => [String(c.ixc_id), c.nome || c.razao || null]));
  return [...ids].map(id => ({ ixc_id: id, nome: nome[id] || null, vinculado: vinculados.has(id) }));
}

async function historico(e, filtro) {
  return (await sb(e, `roteador_acoes?${filtro}&select=criado_em,user_nome,cliente_ixc_id,acao,detalhe,resultado,erro`
    + '&order=criado_em.desc&limit=10').catch(() => [])) || [];
}

function registrar(e, user, ixcId, deviceId, acao, detalhe, resultado, falha) {
  // o registro é complemento: falhar aqui não pode desfazer a ação já feita
  return sb(e, 'roteador_acoes', { method: 'POST', prefer: 'return=minimal', body: {
    user_id: user.id, user_nome: user.nome || null,
    cliente_ixc_id: ixcId ? String(ixcId) : null, device_id: String(deviceId),
    acao, detalhe: detalhe || null, resultado: resultado || null, erro: falha ? String(falha).slice(0, 300) : null,
  } }).catch(() => {});
}

// ---------------------------------------------------------------- handler
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido' });
  const e = env();
  let user;
  try { user = await autenticar(e, req); }
  catch (err) { return res.status(err.status || 500).json({ ok: false, error: err.message }); }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const acao = String(body.acao || '');
  const cfg = ACS.acsConfig();
  if (!ACS.acsLigado(cfg)) return res.status(200).json({ ok: true, configurado: false });

  const mexe = ['vincular', 'wifi', 'reiniciar', 'diagnostico'].includes(acao);
  if (mexe && !user.podeAgir) return res.status(403).json({ ok: false, error: 'Perfil visualizador: só consulta.' });
  const ixcId = body.cliente_ixc_id == null || body.cliente_ixc_id === '' ? null : String(body.cliente_ixc_id).trim();

  try {
    switch (acao) {
      // Monitoramento: a base inteira. O nome do cliente é ligado no navegador,
      // que já tem os logins do IXC carregados.
      case 'lista': {
        const lista = await ACS.listar(cfg);
        return res.status(200).json({ ok: true, configurado: true, podeAgir: user.podeAgir,
          equipamentos: lista, lido_em: new Date().toISOString() });
      }

      // Os equipamentos de um cliente (aba "Equipamento" da ficha)
      case 'cliente': {
        if (!ixcId) return res.status(400).json({ ok: false, error: 'cliente_ixc_id obrigatório.' });
        const [logins, vinc] = await Promise.all([
          loginsDoCliente(e, ixcId),
          sb(e, `roteador_vinculos?cliente_ixc_id=eq.${encodeURIComponent(ixcId)}&select=device_id`).catch(() => []),
        ]);
        const docs = new Map(), origem = {};
        for (const [l, ds] of await Promise.all(logins.map(l => ACS.acharPorLogin(cfg, l).then(ds => [l, ds])))) {
          for (const d of ds) { docs.set(d._id, d); origem[d._id] = { por: 'login', login: l }; }
        }
        for (const v of (vinc || [])) {
          if (docs.has(v.device_id)) { origem[v.device_id].vinculado = true; continue; }
          const d = await ACS.acharPorId(cfg, v.device_id);
          if (d) { docs.set(d._id, d); origem[d._id] = { por: 'vinculo', vinculado: true }; }
        }
        return res.status(200).json({ ok: true, configurado: true, podeAgir: user.podeAgir, logins,
          equipamentos: [...docs.values()].map(d => ({ ...ACS.resumir(d), origem: origem[d._id] })),
          historico: await historico(e, `cliente_ixc_id=eq.${encodeURIComponent(ixcId)}`) });
      }

      // Procurar no ACS por serial ou login (para vincular)
      case 'buscar': {
        const termo = String(body.termo || '').trim();
        if (termo.length < 4) return res.status(400).json({ ok: false, error: 'Digite ao menos 4 caracteres do serial ou do login.' });
        const [a, b] = await Promise.all([ACS.acharPorSerial(cfg, termo), ACS.acharPorLogin(cfg, termo)]);
        const vistos = new Map();
        [...a, ...b].forEach(d => vistos.set(d._id, d));
        return res.status(200).json({ ok: true, achados: [...vistos.values()].slice(0, 10).map(d => {
          const r = ACS.resumir(d);
          return { id: r.id, fabricante: r.fabricante, modelo: r.modelo, serial: r.serial,
            login: r.conexao.login, online: r.online, ultimoContato: r.ultimoContato };
        }) });
      }
    }

    // daqui para baixo, tudo é sobre UM equipamento
    const deviceId = String(body.device_id || '').trim();
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id obrigatório.' });

    if (acao === 'vincular') {
      if (!ixcId) return res.status(400).json({ ok: false, error: 'cliente_ixc_id obrigatório.' });
      if (body.remover) {
        await sb(e, `roteador_vinculos?cliente_ixc_id=eq.${encodeURIComponent(ixcId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
          { method: 'DELETE', prefer: 'return=minimal' });
        await registrar(e, user, ixcId, deviceId, 'desvincular');
        return res.status(200).json({ ok: true });
      }
      if (!await ACS.acharPorId(cfg, deviceId)) return res.status(404).json({ ok: false, error: 'Equipamento não encontrado no ACS.' });
      await sb(e, 'roteador_vinculos?on_conflict=cliente_ixc_id,device_id', {
        method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal',
        body: { cliente_ixc_id: ixcId, device_id: deviceId, criado_por: user.id },
      });
      await registrar(e, user, ixcId, deviceId, 'vincular');
      return res.status(200).json({ ok: true });
    }

    const doc = await ACS.acharPorId(cfg, deviceId);
    if (!doc) return res.status(404).json({ ok: false, error: 'Equipamento não encontrado no ACS.' });
    const md = ACS.resumir(doc).modeloDados;

    switch (acao) {
      // Detalhe de um equipamento (clique na lista do monitoramento)
      case 'equipamento': {
        return res.status(200).json({ ok: true, podeAgir: user.podeAgir, equipamento: ACS.resumir(doc),
          clientes: await clientesDoEquipamento(e, doc),
          historico: await historico(e, `device_id=eq.${encodeURIComponent(deviceId)}`) });
      }

      // "Atualizar agora": faz o equipamento conversar; a provision renova tudo
      case 'atualizar': {
        const r = await ACS.atualizar(cfg, deviceId, md === 'TR-181' ? 'Device' : 'InternetGatewayDevice');
        const novo = r.aplicado ? await ACS.acharPorId(cfg, deviceId) : doc;
        return res.status(200).json({ ok: true, aplicado: r.aplicado, naFila: r.naFila, equipamento: ACS.resumir(novo || doc) });
      }

      case 'wifi': {
        const senha = body.senha == null ? '' : String(body.senha);
        const ssid = body.ssid == null ? '' : String(body.ssid).trim();
        let plano;
        try { plano = ACS.planoWifi(doc, { senha, ssid, bandas: body.bandas }); }
        catch (err) { return res.status(400).json({ ok: false, error: err.message }); }
        const detalhe = { redes: plano.redes, senha: !!senha, ssid: ssid || null };   // a senha em si, nunca
        let r;
        try { r = await ACS.aplicarWifi(cfg, deviceId, plano, doc); }
        catch (err) { await registrar(e, user, ixcId, deviceId, 'wifi', detalhe, 'erro', err.message); throw err; }
        await registrar(e, user, ixcId, deviceId, 'wifi', detalhe, r.aplicado ? 'aplicado' : 'na_fila');
        return res.status(200).json({ ok: true, aplicado: r.aplicado, naFila: r.naFila, redes: plano.redes });
      }

      case 'reiniciar': {
        let r;
        try { r = await ACS.reiniciar(cfg, deviceId); }
        catch (err) { await registrar(e, user, ixcId, deviceId, 'reiniciar', null, 'erro', err.message); throw err; }
        await registrar(e, user, ixcId, deviceId, 'reiniciar', null, r.aplicado ? 'aplicado' : 'na_fila');
        return res.status(200).json({ ok: true, aplicado: r.aplicado, naFila: r.naFila });
      }

      case 'diagnostico':
      case 'diagnostico_resultado': {
        const tipo = String(body.tipo || '');
        if (!ACS.TIPOS_DIAGNOSTICO.includes(tipo)) return res.status(400).json({ ok: false, error: 'Tipo de teste inválido.' });
        if (acao === 'diagnostico_resultado') {
          return res.status(200).json({ ok: true, resultado: ACS.lerDiagnostico(doc, tipo, Number(body.desde) || 0) });
        }
        let plano;
        try { plano = ACS.planoDiagnostico(doc, tipo, cfg); }
        catch (err) { return res.status(400).json({ ok: false, error: err.message }); }
        const desde = Date.now();
        let r;
        try { r = await ACS.iniciarDiagnostico(cfg, deviceId, plano, doc); }
        catch (err) { await registrar(e, user, ixcId, deviceId, 'diagnostico', { tipo }, 'erro', err.message); throw err; }
        await registrar(e, user, ixcId, deviceId, 'diagnostico', { tipo }, r.aplicado ? 'aplicado' : 'na_fila');
        return res.status(200).json({ ok: true, desde, aplicado: r.aplicado, naFila: r.naFila });
      }
    }
    return res.status(400).json({ ok: false, error: 'Ação desconhecida.' });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
}
