// ============================================================================
// api/movifiber.js — PROXY ISOLADO DO MOVIFIBER (Vercel Serverless)
// ============================================================================
// Padrão MoviOne de isolamento: este arquivo é EXCLUSIVO do MoviFiber.
// Nada aqui é compartilhado com ixc-proxy.js, campo-proxy.js, moviapp.js ou
// push.js — alterações no MoviFiber jamais afetam os outros sistemas.
//
// FUNÇÃO: entregar ao mapa do MoviFiber os clientes com:
//   • localização (lat/lng)  → Supabase MoviOne (tabela `clientes`)
//   • login + online S/N     → IXC /webservice/v1/radusuarios
//   • sinal de fibra RX/TX   → IXC /webservice/v1/radpop_radio_cliente_fibra
//
// ENV VARS necessárias no projeto Vercel (as mesmas já usadas nos outros
// proxies — não crie duplicadas, apenas reutilize):
//   SUPABASE_URL          ex: https://mgtetsmcswdtvsgewcen.supabase.co
//   SUPABASE_SERVICE_KEY  service role (somente server-side, nunca no front)
//   IXC_TOKEN             token do webservice IXC (formato id:hash)
//
// CHAMADA DO FRONT:
//   POST /api/movifiber   body: { "acao": "clientes-full" }
//   → { clientes:[{ id_cliente, nome, latitude, longitude, login, online,
//                   sinal_rx, sinal_tx }], total, fontes:{...} }
//
// Também aceita acao:"clientes-mapa" (só Supabase) e acao:"status-logins"
// (só IXC), para depuração isolada de cada fonte.
// ============================================================================

const IXC_HOST = 'https://netmaisconnect.com.br';

// ---- AJUSTE FINO DE SCHEMA (confira com o seu banco) -----------------------
// Colunas da tabela `clientes` no Supabase (MoviOne):
const SB_TABELA   = 'clientes';
const SB_COL_ID   = 'id';          // id do cliente = id no IXC (sync MoviOne)
const SB_COL_NOME = 'razao';       // ou 'nome' conforme seu schema
const SB_COL_LAT  = 'latitude';
const SB_COL_LNG  = 'longitude';
// Campos do IXC radusuarios usados:
const IXC_RAD_CAMPOS = ['id', 'id_cliente', 'login', 'online', 'ip'];
// Tabela de fibra do IXC (RX/TX por login). Se o seu IXC não usa esta tabela,
// defina INCLUIR_FIBRA = false que o proxy pula essa etapa sem erro.
const INCLUIR_FIBRA = true;
const IXC_FIBRA_TABELA = 'radpop_radio_cliente_fibra';
// ---------------------------------------------------------------------------

// Cache em memória da instância (evita marretar o IXC em navegações rápidas)
let _cache = { quando: 0, dados: null };
const CACHE_MS = 60 * 1000;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });

  const acao = (req.body && req.body.acao) || 'clientes-full';

  try {
    if (acao === 'clientes-mapa') {
      const locs = await clientesSupabase();
      return res.status(200).json({ clientes: locs, total: locs.length, fontes: { supabase: true } });
    }
    if (acao === 'status-logins') {
      const logins = await radusuariosIXC();
      return res.status(200).json({ logins, total: logins.length, fontes: { ixc: true } });
    }
    if (acao === 'clientes-full') {
      if (_cache.dados && Date.now() - _cache.quando < CACHE_MS) {
        return res.status(200).json({ ..._cache.dados, cache: true });
      }
      const [locs, logins, fibra] = await Promise.all([
        clientesSupabase(),
        radusuariosIXC(),
        INCLUIR_FIBRA ? fibraIXC().catch(() => new Map()) : Promise.resolve(new Map())
      ]);
      // índice: id_cliente IXC -> login/online
      const porCliente = new Map();
      for (const l of logins) {
        // um cliente pode ter mais de um login; prioriza o que estiver online
        const atual = porCliente.get(String(l.id_cliente));
        if (!atual || (l.online === 'S' && atual.online !== 'S')) {
          porCliente.set(String(l.id_cliente), l);
        }
      }
      const clientes = locs
        .filter(c => c.latitude != null && c.longitude != null)
        .map(c => {
          const rad = porCliente.get(String(c.id_cliente)) || null;
          const f = rad ? (fibra.get(String(rad.id)) || null) : null;
          return {
            id_cliente: c.id_cliente,
            nome: c.nome,
            latitude: +c.latitude,
            longitude: +c.longitude,
            login: rad ? rad.login : null,
            online: rad ? rad.online : null,          // 'S' | 'N' | null
            ip: rad ? rad.ip : null,
            sinal_rx: f ? f.sinal_rx : null,
            sinal_tx: f ? f.sinal_tx : null
          };
        });
      const payload = {
        clientes,
        total: clientes.length,
        fontes: { supabase: true, ixc: true, fibra: INCLUIR_FIBRA }
      };
      _cache = { quando: Date.now(), dados: payload };
      return res.status(200).json(payload);
    }
    return res.status(400).json({ erro: 'acao desconhecida: ' + acao });
  } catch (e) {
    console.error('[movifiber-proxy]', e);
    return res.status(500).json({ erro: e.message });
  }
}

// ---------------------------------------------------------------------------
// SUPABASE (MoviOne) — localização dos clientes
// Respeita coord_fixada implicitamente: lemos o que está na tabela, que é a
// fonte de verdade do MoviOne (o trigger trg_proteger_coord já garante isso).
// ---------------------------------------------------------------------------
async function clientesSupabase() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SB_TABELA}` +
    `?select=${SB_COL_ID},${SB_COL_NOME},${SB_COL_LAT},${SB_COL_LNG}` +
    `&${SB_COL_LAT}=not.is.null&${SB_COL_LNG}=not.is.null&limit=20000`;
  const r = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
  const rows = await r.json();
  return rows.map(x => ({
    id_cliente: x[SB_COL_ID],
    nome: x[SB_COL_NOME],
    latitude: x[SB_COL_LAT],
    longitude: x[SB_COL_LNG]
  }));
}

// ---------------------------------------------------------------------------
// IXC — helpers no padrão MoviOne (Basic token, header ixcsoft:listar,
// paginação rp=1000 igual ao buscarTudoIXC)
// ---------------------------------------------------------------------------
function ixcHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + Buffer.from(process.env.IXC_TOKEN).toString('base64'),
    ixcsoft: 'listar'
  };
}

async function ixcListarTudo(tabela, body) {
  const out = [];
  let page = 1;
  while (true) {
    const r = await fetch(`${IXC_HOST}/webservice/v1/${tabela}`, {
      method: 'POST',
      headers: ixcHeaders(),
      body: JSON.stringify({ ...body, page: String(page), rp: '1000' })
    });
    if (!r.ok) throw new Error(`IXC ${tabela} HTTP ` + r.status);
    const d = await r.json();
    const regs = d.registros || [];
    out.push(...regs);
    const total = parseInt(d.total || '0', 10);
    if (out.length >= total || regs.length === 0) break;
    page++;
    if (page > 60) break; // trava de segurança (60k registros)
  }
  return out;
}

async function radusuariosIXC() {
  const regs = await ixcListarTudo('radusuarios', {
    qtype: 'radusuarios.id',
    query: '0',
    oper: '>',
    sortname: 'radusuarios.id',
    sortorder: 'asc'
  });
  return regs.map(r => {
    const o = {};
    for (const c of IXC_RAD_CAMPOS) o[c] = r[c];
    return o;
  });
}

// Sinal de fibra por login (id do radusuarios → sinal_rx/sinal_tx)
async function fibraIXC() {
  const regs = await ixcListarTudo(IXC_FIBRA_TABELA, {
    qtype: IXC_FIBRA_TABELA + '.id',
    query: '0',
    oper: '>',
    sortname: IXC_FIBRA_TABELA + '.id',
    sortorder: 'asc'
  });
  const mapa = new Map();
  for (const r of regs) {
    // campo de vínculo com o login: normalmente id_login / id_radusuario —
    // ajuste aqui se o seu IXC usar outro nome:
    const idLogin = r.id_login || r.id_radusuario || r.id_contrato;
    if (idLogin != null) {
      mapa.set(String(idLogin), {
        sinal_rx: r.sinal_rx != null ? parseFloat(r.sinal_rx) : null,
        sinal_tx: r.sinal_tx != null ? parseFloat(r.sinal_tx) : null
      });
    }
  }
  return mapa;
}
