// ============================================================================
// api/movifiber.js — PROXY ISOLADO DO MOVIFIBER (Vercel Serverless)
// ============================================================================
// Isolamento MoviOne: arquivo EXCLUSIVO do MoviFiber. Nada compartilhado com
// ixc-proxy.js, campo-proxy.js, moviapp.js ou push.js.
//
// DIRECAO CORRETA DAS FONTES:
//   MoviOne (Supabase)  ->  LOCALIZACAO (clientes.latitude/longitude)
//                           + VINCULO FTTH (ftth_cliente_instalacao:
//                             projeto, caixa/CTO, porta) preenchido no Campo.
//   IXC (isolado aqui)  ->  SOMENTE online/offline + potencia da ONU.
//
// ENV VARS (reutiliza as existentes; NAO crie novas):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IXC_URL, IXC_USER, IXC_TOKEN
//
// ACOES (POST /api/movifiber, body {acao:"..."}):
//   - "clientes-movione"   -> {projeto?}  Clientes do MoviOne com lat/lng +
//                             projeto/caixa/porta. (NAO consulta IXC.)
//   - "ixc-status"         -> {ixc_ids:[...]}  SO IXC: online + potencia ONU
//                             por cliente. Isolado do MoviOne.
//   - "salvar-instalacao"  -> {cliente_id, projeto, caixa_id, caixa_nome, porta}
//                             grava o vinculo (RPC ftth_upsert_instalacao).
//   - "debug-schema"       -> 1 registro cru de cada fonte (descobrir colunas).
// ============================================================================

const IXC_URL = (process.env.IXC_URL || 'https://netmaisconnect.com.br').replace(/\/$/, '').replace(/\/adm\.php$/, '');

// ==== AJUSTE FINO DE SCHEMA (confira com "debug-schema") =====================
// Supabase MoviOne
const SB_CLIENTES = 'clientes';
const SB_ID    = 'id';
const SB_NOME  = 'razao';
const SB_IXCID = 'ixc_id';
const SB_LOGIN = 'ixc_login';
const SB_LAT   = 'latitude';
const SB_LNG   = 'longitude';
const SB_INSTAL = 'ftth_cliente_instalacao';   // tabela criada pela migration
// IXC (SOMENTE online + potencia ONU)
const IXC_TB_RAD   = 'radusuarios';
const R_ID = 'id', R_CLIENTE = 'id_cliente', R_LOGIN = 'login', R_ONLINE = 'online', R_IP = 'ip';
const IXC_TB_FIBRA = 'radpop_radio_cliente_fibra';
const F_LOGIN = 'id_login';
// campos de potencia dentro da fibra (o proxy tenta varios nomes comuns):
const F_RX_CANDIDATOS = ['potencia_rx','sinal_rx','rx','potencia_recebida','signal_rx'];
const F_TX_CANDIDATOS = ['potencia_tx','sinal_tx','tx','potencia_transmitida','signal_tx'];
const F_ONU_CANDIDATOS = ['id_hardware','onu','serial_onu','id_onu'];
// ============================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });

  const b = req.body || {};
  const acao = b.acao || 'clientes-movione';
  try {
    // ---- quem esta chamando? ----
    // O login protege a tela, mas sem esta checagem qualquer um com a URL do proxy
    // leria clientes e projetos. Com MOVIFIBER_EXIGE_LOGIN=1 o acesso passa a exigir
    // o token do usuario; sem a variavel o comportamento antigo e mantido (para o
    // deploy nao quebrar antes de o front novo estar no ar).
    const exigeLogin = String(process.env.MOVIFIBER_EXIGE_LOGIN || '') === '1';
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || b.token || '';
    if (exigeLogin) {
      const quem = await validarUsuario(token);
      if (!quem.ok) return res.status(401).json({ erro: quem.motivo || 'nao autorizado' });
      b._usuario = quem.usuario;
    }
    if (acao === 'clientes-movione')  return res.status(200).json(await clientesMoviOne(b.projeto));
    if (acao === 'ixc-status')        return res.status(200).json(await ixcStatus(b.ixc_ids || []));
    if (acao === 'salvar-instalacao') return res.status(200).json(await salvarInstalacao(b));
    if (acao === 'debug-schema')      return res.status(200).json(await debugSchema());
    if (acao === 'proj-listar')       return res.status(200).json(await projListar());
    if (acao === 'proj-carregar')     return res.status(200).json(await projCarregar(b.id));
    if (acao === 'proj-salvar')       return res.status(200).json(await projSalvar(b.projeto, b.versao_base, b.forcar));
    if (acao === 'proj-excluir')      return res.status(200).json(await projExcluir(b.id));
    if (acao === 'cat-carregar')      return res.status(200).json(await catCarregar());
    if (acao === 'cat-salvar')        return res.status(200).json(await catSalvar(b.dados));
    return res.status(400).json({ erro: 'acao desconhecida: ' + acao });
  } catch (e) {
    console.error('[movifiber-proxy]', e);
    return res.status(500).json({ erro: e.message });
  }
}

// ─────────── MoviOne (Supabase): localizacao + vinculo FTTH ───────────
function sbHeaders() {
  return { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
}
// Busca paginada: o PostgREST do Supabase corta a resposta em 1000 linhas
// (db-max-rows), mesmo pedindo limit maior. Sem paginar, registros somem em silencio.
async function sbGetAll(baseUrl, pageSize = 1000) {
  const out = [];
  const sep = baseUrl.includes('?') ? '&' : '?';
  for (let off = 0; off <= 200000; off += pageSize) {
    const r = await fetch(`${baseUrl}${sep}limit=${pageSize}&offset=${off}`, { headers: sbHeaders() });
    if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
    const page = await r.json();
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}
async function clientesMoviOne(projeto) {
  // Consulta a partir do VINCULO (poucas linhas) embutindo o cliente.
  // Antes partia de "clientes" (1900+ linhas) e o corte de 1000 do PostgREST
  // escondia quem estivesse depois dessa posicao (ex.: cliente na linha 1058).
  const base = `${process.env.SUPABASE_URL}/rest/v1/${SB_INSTAL}` +
    `?select=projeto_ftth,caixa_id,caixa_nome,porta,` +
    `${SB_CLIENTES}!${SB_INSTAL}_cliente_id_fkey(${SB_ID},${SB_NOME},${SB_IXCID},${SB_LOGIN},${SB_LAT},${SB_LNG})` +
    `&order=id.asc`;
  const rows = await sbGetAll(base);
  let semCoord = 0;
  const out = [];
  for (const x of rows) {
    const c = Array.isArray(x[SB_CLIENTES]) ? x[SB_CLIENTES][0] : x[SB_CLIENTES];
    if (!c) continue;
    const lat = c[SB_LAT], lng = c[SB_LNG];
    if (lat == null || lng == null) semCoord++;
    out.push({
      id_cliente: c[SB_ID],
      nome: c[SB_NOME],
      ixc_id: c[SB_IXCID],
      login: c[SB_LOGIN],
      latitude: lat == null ? null : +lat,
      longitude: lng == null ? null : +lng,
      projeto: x.projeto_ftth,
      caixa_id: x.caixa_id,
      caixa: x.caixa_nome,
      porta: x.porta
    });
  }
  const filtrados = projeto ? out.filter(c => String(c.projeto) === String(projeto)) : out;
  return {
    clientes: filtrados,
    total: filtrados.length,
    sem_coordenada: filtrados.filter(c => c.latitude == null || c.longitude == null).length,
    projetos: projetosDistintos(out)
  };
}
function projetosDistintos(lista) {
  const set = new Map();
  for (const c of lista) if (c.projeto) set.set(String(c.projeto), c.projeto);
  return [...set.values()].map(p => ({ id: p, nome: String(p) }));
}
async function salvarInstalacao(b) {
  if (b.cliente_id == null) throw new Error('cliente_id obrigatorio');
  const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/ftth_upsert_instalacao`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_cliente_id: b.cliente_id, p_projeto: b.projeto ?? null,
      p_caixa_id: b.caixa_id ?? null, p_caixa_nome: b.caixa_nome ?? null,
      p_porta: b.porta ?? null
    })
  });
  if (!r.ok) throw new Error('Supabase RPC HTTP ' + r.status + ' — rodou a migration ftth_cliente_instalacao?');
  return { ok: true, instalacao: await r.json() };
}

// ---------------------- PROJETOS MOVIFIBER (nuvem) --------------------------
const SB_PROJ = 'movifiber_projetos';
const SB_CAT  = 'movifiber_catalogos';

async function projListar() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SB_PROJ}` +
    `?select=id,nome,centro_lat,centro_lng,qtd_elementos,qtd_cabos,atualizado_em&order=atualizado_em.desc`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
  return { projetos: await r.json() };
}
/* Confere o token do usuario no Supabase Auth e a liberacao no modulo.
   O resultado fica em cache curto para nao consultar a cada chamada. */
const _cacheUsuarios = new Map();   // token -> { exp, dado }
async function validarUsuario(token) {
  if (!token) return { ok: false, motivo: 'sem credencial: faca login no MoviFiber' };
  const agora = Date.now();
  const emCache = _cacheUsuarios.get(token);
  if (emCache && emCache.exp > agora) return emCache.dado;

  const anon = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
  let dado;
  try {
    // 1) o token e valido?
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` }
    });
    if (!r.ok) {
      dado = { ok: false, motivo: 'sessao expirada: entre novamente' };
    } else {
      const u = await r.json();
      // 2) esse usuario tem o MoviFiber liberado?
      const rp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/tem_movifiber`, {
        method: 'POST',
        headers: { ...sbHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_id: u.id })
      });
      const liberado = rp.ok ? await rp.json() : false;
      dado = liberado === true
        ? { ok: true, usuario: { id: u.id, email: u.email } }
        : { ok: false, motivo: 'usuario sem acesso liberado ao MoviFiber' };
    }
  } catch (e) {
    dado = { ok: false, motivo: 'falha ao validar credencial' };
  }
  // cache de 60s (positivo) / 10s (negativo), com teto de entradas
  _cacheUsuarios.set(token, { exp: agora + (dado.ok ? 60000 : 10000), dado });
  if (_cacheUsuarios.size > 500) _cacheUsuarios.clear();
  return dado;
}
async function projCarregar(id) {
  if (!id) throw new Error('id obrigatorio');
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SB_PROJ}?id=eq.${encodeURIComponent(id)}&select=*`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
  const rows = await r.json();
  return { projeto: rows[0] || null };
}
/* Salva o projeto com trava por versao.
   O front envia a versao que carregou (base). Se no banco houver algo mais novo,
   outra pessoa gravou nesse meio tempo: a gravacao e recusada em vez de apagar
   o trabalho do outro em silencio. */
async function projSalvar(p, versaoBase, forcar) {
  if (!p || !p.id) throw new Error('projeto invalido');

  // versao atual no banco
  const urlAtual = `${process.env.SUPABASE_URL}/rest/v1/${SB_PROJ}`
    + `?id=eq.${encodeURIComponent(p.id)}&select=atualizado_em,atualizado_por`;
  const rAtual = await fetch(urlAtual, { headers: sbHeaders() });
  const atuais = rAtual.ok ? await rAtual.json() : [];
  const noBanco = atuais[0] || null;

  if (noBanco && !forcar && versaoBase) {
    const vBanco = new Date(noBanco.atualizado_em).getTime();
    const vBase = new Date(versaoBase).getTime();
    // tolerancia de 1s: o carimbo do banco pode ter precisao diferente
    if (isFinite(vBanco) && isFinite(vBase) && vBanco - vBase > 1000) {
      return {
        ok: false, conflito: true, id: p.id,
        versao_banco: noBanco.atualizado_em,
        versao_base: versaoBase,
        alterado_por: noBanco.atualizado_por || null
      };
    }
  }

  const centro = Array.isArray(p.centro) ? p.centro : [null, null];
  const agora = new Date().toISOString();
  const row = {
    id: p.id, nome: p.nome || 'Projeto',
    centro_lat: centro[0], centro_lng: centro[1],
    dados: p,
    qtd_elementos: (p.elementos || []).length,
    qtd_cabos: (p.cabos || []).length,
    atualizado_em: agora
  };
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SB_PROJ}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row)
  });
  if (!r.ok) throw new Error('Supabase salvar HTTP ' + r.status + ' ' + (await r.text()).slice(0,200));
  return { ok: true, id: p.id, versao: agora };
}
async function projExcluir(id) {
  if (!id) throw new Error('id obrigatorio');
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SB_PROJ}?id=eq.${encodeURIComponent(id)}`;
  const r = await fetch(url, { method: 'DELETE', headers: { ...sbHeaders(), Prefer: 'return=minimal' } });
  if (!r.ok) throw new Error('Supabase excluir HTTP ' + r.status);
  return { ok: true };
}
async function catCarregar() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SB_CAT}?id=eq.global&select=dados`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
  const rows = await r.json();
  return { dados: rows[0] ? rows[0].dados : null };
}
async function catSalvar(dados) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SB_CAT}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: 'global', dados, atualizado_em: new Date().toISOString() })
  });
  if (!r.ok) throw new Error('Supabase cat HTTP ' + r.status);
  return { ok: true };
}

// ─────────── IXC (isolado): SO online + potencia ONU ───────────
function ixcHeaders() {
  const user = process.env.IXC_USER || '';
  const token = process.env.IXC_TOKEN || '';
  return {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64'),
    ixcsoft: 'listar'
  };
}
async function ixcListarTudo(tabela, body) {
  const out = []; let page = 1;
  while (true) {
    const r = await fetch(`${IXC_URL}/webservice/v1/${tabela}`, {
      method: 'POST', headers: ixcHeaders(),
      body: JSON.stringify({ ...body, page: String(page), rp: '1000' })
    });
    if (!r.ok) throw new Error(`IXC ${tabela} HTTP ` + r.status);
    const d = await r.json();
    const regs = d.registros || [];
    out.push(...regs);
    if (out.length >= parseInt(d.total || '0', 10) || regs.length === 0) break;
    if (++page > 60) break;
  }
  return out;
}
function primeiroCampo(reg, candidatos) {
  for (const k of candidatos) if (reg[k] != null && reg[k] !== '') return reg[k];
  return null;
}
async function ixcStatus(ixcIds) {
  const ids = [...new Set((ixcIds || []).map(String).filter(Boolean))];
  if (!ids.length) return { status: {}, total: 0 };
  // 1) radusuarios por id_cliente -> online + login id
  const rad = [];
  for (let i = 0; i < ids.length; i += 400) {
    const lote = ids.slice(i, i + 400).join(',');
    const regs = await ixcListarTudo(IXC_TB_RAD, {
      qtype: `${IXC_TB_RAD}.${R_CLIENTE}`, query: lote, oper: 'IN',
      sortname: `${IXC_TB_RAD}.${R_ID}`, sortorder: 'asc'
    }).catch(() => []);
    rad.push(...regs);
  }
  // 2) potencia ONU por id_login
  const loginIds = [...new Set(rad.map(u => u[R_ID]).filter(Boolean))].map(String);
  const potMap = new Map();
  for (let i = 0; i < loginIds.length; i += 400) {
    const lote = loginIds.slice(i, i + 400).join(',');
    const regs = await ixcListarTudo(IXC_TB_FIBRA, {
      qtype: `${IXC_TB_FIBRA}.${F_LOGIN}`, query: lote, oper: 'IN',
      sortname: `${IXC_TB_FIBRA}.id`, sortorder: 'asc'
    }).catch(() => []);
    for (const f of regs) {
      potMap.set(String(f[F_LOGIN]), {
        rx: numOrNull(primeiroCampo(f, F_RX_CANDIDATOS)),
        tx: numOrNull(primeiroCampo(f, F_TX_CANDIDATOS)),
        onu: primeiroCampo(f, F_ONU_CANDIDATOS)
      });
    }
  }
  // 3) monta por id_cliente IXC
  const status = {};
  for (const u of rad) {
    const cid = String(u[R_CLIENTE]);
    const pot = potMap.get(String(u[R_ID])) || {};
    const anterior = status[cid];
    const cand = { online: u[R_ONLINE], login: u[R_LOGIN], ip: u[R_IP], rx: pot.rx ?? null, tx: pot.tx ?? null, onu: pot.onu ?? null };
    // prioriza login online
    if (!anterior || (cand.online === 'S' && anterior.online !== 'S')) status[cid] = cand;
  }
  return { status, total: Object.keys(status).length };
}
function numOrNull(v) { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; }

// ─────────── DEBUG ───────────
async function debugSchema() {
  const out = {};
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${SB_CLIENTES}?select=*,${SB_INSTAL}(*)&limit=1`, { headers: sbHeaders() });
    out.supabase_clientes = (await r.json())[0] || '(vazio)';
  } catch (e) { out.supabase_clientes = 'ERRO: ' + e.message; }
  try {
    const r = await fetch(`${IXC_URL}/webservice/v1/${IXC_TB_FIBRA}`, {
      method: 'POST', headers: ixcHeaders(),
      body: JSON.stringify({ qtype: `${IXC_TB_FIBRA}.id`, query: '0', oper: '>', page: '1', rp: '1' })
    });
    out.ixc_fibra = ((await r.json()).registros || [])[0] || '(sem registros)';
  } catch (e) { out.ixc_fibra = 'ERRO: ' + e.message; }
  try {
    const r = await fetch(`${IXC_URL}/webservice/v1/${IXC_TB_RAD}`, {
      method: 'POST', headers: ixcHeaders(),
      body: JSON.stringify({ qtype: `${IXC_TB_RAD}.id`, query: '0', oper: '>', page: '1', rp: '1' })
    });
    out.ixc_radusuarios = ((await r.json()).registros || [])[0] || '(sem registros)';
  } catch (e) { out.ixc_radusuarios = 'ERRO: ' + e.message; }
  out.dica = 'Confira nomes de potencia da ONU em ixc_fibra e ajuste F_RX_CANDIDATOS/F_TX_CANDIDATOS. Localizacao/vinculo saem de supabase_clientes.';
  return out;
}
