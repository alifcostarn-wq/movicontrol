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
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, IXC_TOKEN
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

const IXC_HOST = 'https://netmaisconnect.com.br';

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });

  const b = req.body || {};
  const acao = b.acao || 'clientes-movione';
  try {
    if (acao === 'clientes-movione')  return res.status(200).json(await clientesMoviOne(b.projeto));
    if (acao === 'ixc-status')        return res.status(200).json(await ixcStatus(b.ixc_ids || []));
    if (acao === 'salvar-instalacao') return res.status(200).json(await salvarInstalacao(b));
    if (acao === 'debug-schema')      return res.status(200).json(await debugSchema());
    return res.status(400).json({ erro: 'acao desconhecida: ' + acao });
  } catch (e) {
    console.error('[movifiber-proxy]', e);
    return res.status(500).json({ erro: e.message });
  }
}

// ─────────── MoviOne (Supabase): localizacao + vinculo FTTH ───────────
function sbHeaders() {
  return { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
}
async function clientesMoviOne(projeto) {
  // embute a instalacao (FK cliente_id -> clientes) via PostgREST
  let url = `${process.env.SUPABASE_URL}/rest/v1/${SB_CLIENTES}` +
    `?select=${SB_ID},${SB_NOME},${SB_IXCID},${SB_LOGIN},${SB_LAT},${SB_LNG},` +
    `${SB_INSTAL}(projeto_ftth,caixa_id,caixa_nome,porta)` +
    `&${SB_LAT}=not.is.null&${SB_LNG}=not.is.null&limit=20000`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
  let rows = await r.json();
  const out = rows.map(x => {
    const inst = Array.isArray(x[SB_INSTAL]) ? x[SB_INSTAL][0] : x[SB_INSTAL];
    return {
      id_cliente: x[SB_ID],
      nome: x[SB_NOME],
      ixc_id: x[SB_IXCID],
      login: x[SB_LOGIN],
      latitude: +x[SB_LAT],
      longitude: +x[SB_LNG],
      projeto: inst ? inst.projeto_ftth : null,
      caixa_id: inst ? inst.caixa_id : null,
      caixa: inst ? inst.caixa_nome : null,
      porta: inst ? inst.porta : null
    };
  });
  const filtrados = projeto ? out.filter(c => String(c.projeto) === String(projeto)) : out;
  return { clientes: filtrados, total: filtrados.length, projetos: projetosDistintos(out) };
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

// ─────────── IXC (isolado): SO online + potencia ONU ───────────
function ixcHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + Buffer.from(process.env.IXC_TOKEN).toString('base64'),
    ixcsoft: 'listar'
  };
}
async function ixcListarTudo(tabela, body) {
  const out = []; let page = 1;
  while (true) {
    const r = await fetch(`${IXC_HOST}/webservice/v1/${tabela}`, {
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
    const r = await fetch(`${IXC_HOST}/webservice/v1/${IXC_TB_FIBRA}`, {
      method: 'POST', headers: ixcHeaders(),
      body: JSON.stringify({ qtype: `${IXC_TB_FIBRA}.id`, query: '0', oper: '>', page: '1', rp: '1' })
    });
    out.ixc_fibra = ((await r.json()).registros || [])[0] || '(sem registros)';
  } catch (e) { out.ixc_fibra = 'ERRO: ' + e.message; }
  try {
    const r = await fetch(`${IXC_HOST}/webservice/v1/${IXC_TB_RAD}`, {
      method: 'POST', headers: ixcHeaders(),
      body: JSON.stringify({ qtype: `${IXC_TB_RAD}.id`, query: '0', oper: '>', page: '1', rp: '1' })
    });
    out.ixc_radusuarios = ((await r.json()).registros || [])[0] || '(sem registros)';
  } catch (e) { out.ixc_radusuarios = 'ERRO: ' + e.message; }
  out.dica = 'Confira nomes de potencia da ONU em ixc_fibra e ajuste F_RX_CANDIDATOS/F_TX_CANDIDATOS. Localizacao/vinculo saem de supabase_clientes.';
  return out;
}
