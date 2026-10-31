// ============================================================================
// SINCRONIZAÇÃO AUTOMÁTICA COM O IXC  (MoviOne › Clientes › IXC)
// ----------------------------------------------------------------------------
// A cópia do IXC que o MoviOne guarda (clientes, contratos e logins) só andava
// quando alguém abria a aba Clientes: o navegador baixava tudo e gravava. Aqui
// a mesma cópia roda no servidor, sozinha, no intervalo escolhido na tela —
// sem ninguém precisar estar com o MoviOne aberto.
//
// Quem bate aqui:
//   "rodar"  -> o agendador do banco (pg_cron, a cada 5 min) com o
//               x-sync-token da tabela ixc_sync_config. Só roda se a opção
//               estiver ligada e o intervalo tiver vencido.
//   "status" -> configuração (sem o token) e o resultado da última rodada
//   "salvar" -> {ativo, intervalo_min}                (administrador)
//   "agora"  -> roda já, sem esperar o intervalo       (administrador)
//
// A cópia em si (o que lê, o que compara, o que grava) está em
// _ixc_espelho.js, com o mesmo mapeamento do navegador.
// ============================================================================
import crypto from 'crypto';
import { sincronizarTudoDoIxc, sincronizarApoioDoIxc } from './_ixc_espelho.js';

export const config = { maxDuration: 60 };

const INTERVALOS = [15, 30, 60, 120, 360, 720, 1440];   // minutos (o mesmo check da tabela)
const TRAVA_MS = 3 * 60e3;       // rodada mais velha que isso morreu (a função vive 60 s)
const FOLGA_MS = 2 * 60e3;       // o agendador bate a cada 5 min: 30 min não pode virar 35
const PRAZO_IXC_MS = 40e3;       // para ler o IXC; o resto dos 60 s é para gravar
const APOIO_CADA_MS = 6 * 3600e3;

const IXC_URL = (process.env.IXC_URL || 'https://netmaisconnect.com.br').replace(/\/$/, '').replace(/\/adm\.php$/, '');
const sbUrl = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const sbKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function sb(caminho, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${sbUrl()}/rest/v1/${caminho}`, {
    method,
    headers: {
      apikey: sbKey(), Authorization: `Bearer ${sbKey()}`, 'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${txt.slice(0, 300)}`);
  try { return txt ? JSON.parse(txt) : null; } catch { return null; }
}

async function sbTudo(caminho) {
  const out = [];
  for (let off = 0; off < 200000; off += 1000) {
    const pag = await sb(`${caminho}&limit=1000&offset=${off}`);
    if (!Array.isArray(pag)) break;
    out.push(...pag);
    if (pag.length < 1000) break;
  }
  return out;
}

// upsert em lotes; com `retornar`, devolve id e ixc_id do que foi gravado
async function sbUpsert(tabela, linhas, { retornar = false, conflito = 'ixc_id' } = {}) {
  const volta = [];
  for (let i = 0; i < linhas.length; i += 500) {
    const r = await sb(`${tabela}?on_conflict=${conflito}${retornar ? '&select=id,ixc_id' : ''}`, {
      method: 'POST', body: linhas.slice(i, i + 500),
      prefer: `resolution=merge-duplicates,return=${retornar ? 'representation' : 'minimal'}`,
    });
    if (retornar && Array.isArray(r)) volta.push(...r);
  }
  return volta;
}

/* Lê uma tabela inteira do IXC (id > 0), página a página, até o total que o
   próprio IXC informa — e não pelo tamanho da página: um IXC que limita a
   página a 500 quando pedimos 1000 faria a leitura parar na primeira. */
async function ixcTudo(tabela, prazo) {
  const auth = 'Basic ' + Buffer.from(`${process.env.IXC_USER || ''}:${process.env.IXC_TOKEN || ''}`).toString('base64');
  const porId = new Map();
  let total = null, primeiroAnterior = null;
  for (let pagina = 1; pagina <= 40; pagina++) {
    const resta = prazo - Date.now();
    if (resta <= 0) throw new Error(`o IXC demorou demais para entregar ${tabela}`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), resta);
    let r;
    try {
      r = await fetch(`${IXC_URL}/webservice/v1/${tabela}`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: auth, ixcsoft: 'listar' },
        body: JSON.stringify({ qtype: `${tabela}.id`, query: '0', oper: '>', page: String(pagina), rp: '1000',
          sortname: `${tabela}.id`, sortorder: 'asc' }),
      });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? `o IXC demorou demais para entregar ${tabela}` : `IXC ${tabela}: ${err.message}`);
    } finally { clearTimeout(timer); }
    if (!r.ok) throw new Error(`IXC ${tabela} HTTP ${r.status}`);
    const d = await r.json().catch(() => null);
    if (!d) throw new Error(`IXC ${tabela}: resposta que não é JSON`);
    if (d.type === 'error') throw new Error(`IXC ${tabela}: ${String(d.message || 'recusado').slice(0, 160)}`);
    const regs = d.registros || [];
    if (total == null) total = parseInt(d.total || '0', 10) || 0;
    // IXC que ignora a página devolveria a mesma lista para sempre
    const primeiro = regs[0] ? String(regs[0].id) : null;
    if (primeiro && primeiro === primeiroAnterior) break;
    primeiroAnterior = primeiro;
    for (const reg of regs) porId.set(String(reg.id), reg);
    if (!regs.length || (total && porId.size >= total)) break;
  }
  // parou antes do total que o próprio IXC informou (página que falhou,
  // IXC que ignora a página): lista pela metade não serve para comparar.
  // A folga cobre registro criado ou apagado durante a leitura.
  if (total && porId.size < total - Math.max(2, Math.floor(total * 0.01))) {
    throw new Error(`IXC ${tabela}: veio ${porId.size} de ${total}`);
  }
  return [...porId.values()];
}

async function lerConfig() {
  const r = await sb('ixc_sync_config?id=eq.1&select=*');
  return (r && r[0]) || null;
}

function tokenConfere(recebido, esperado) {
  const a = Buffer.from(String(recebido || ''));     // compara em bytes: acento muda o tamanho
  const b = Buffer.from(String(esperado || ''));
  return a.length >= 20 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// quem está chamando, pela sessão do MoviOne
async function quemChama(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const r = await fetch(`${sbUrl()}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY || sbKey(), Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  if (!u || !u.id) return null;
  const p = await sb(`perfis?id=eq.${encodeURIComponent(u.id)}&select=nome,perfil`);
  if (!p || !p[0]) return null;
  return { id: u.id, nome: p[0].nome || u.email || 'usuário', perfil: p[0].perfil };
}

async function rodar(cfg, { manual = null } = {}) {
  const agora = Date.now();
  if (!manual && !cfg.ativo) return { ok: true, desligado: true };
  // reserva a rodada: ninguém rodando (ou a anterior morreu) e, no
  // agendador, o intervalo vencido. Quem não conseguir mudar a linha não roda.
  const conds = [`or(rodando_desde.is.null,rodando_desde.lt.${new Date(agora - TRAVA_MS).toISOString()})`];
  if (!manual) conds.push(`or(ultima_execucao.is.null,ultima_execucao.lt.${new Date(agora - cfg.intervalo_min * 60e3 + FOLGA_MS).toISOString()})`);
  const pego = await sb(`ixc_sync_config?id=eq.1&and=(${conds.join(',')})`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { rodando_desde: new Date(agora).toISOString(), ultima_execucao: new Date(agora).toISOString() },
  });
  if (!Array.isArray(pego) || !pego.length) {
    return { ok: true, pulado: manual ? 'já tem uma sincronização em andamento' : 'ainda não deu o intervalo ou já está rodando' };
  }

  let resultado, apoioEm = null;
  try {
    if (!process.env.IXC_USER || !process.env.IXC_TOKEN) throw new Error('IXC não configurado no servidor (IXC_USER / IXC_TOKEN na Vercel)');
    const prazo = agora + PRAZO_IXC_MS;
    const io = { ixcTudo: t => ixcTudo(t, prazo), sbTudo, sbUpsert, sbRpc: (nome, corpo) => sb(`rpc/${nome}`, { method: 'POST', body: corpo }) };
    resultado = { ok: true, ...(await sincronizarTudoDoIxc(io)) };
    // grupos de velocidade e carteiras (Termo de Adesão): mudam pouco
    const apoioVelho = !cfg.apoio_em || agora - new Date(cfg.apoio_em).getTime() > APOIO_CADA_MS;
    if (apoioVelho && Date.now() - agora < 35e3) {
      try {
        resultado.apoio = await sincronizarApoioDoIxc({ ...io, ixcTudo: t => ixcTudo(t, Date.now() + 8e3) });
        apoioEm = new Date().toISOString();
      } catch (err) { resultado.avisos.push('grupos/carteiras: ' + String(err.message || err).slice(0, 160)); }
    }
  } catch (err) {
    resultado = { ok: false, erro: String(err.message || err).slice(0, 300) };
  }
  resultado.em = new Date(agora).toISOString();
  resultado.origem = manual ? `manual por ${manual}` : 'automática';
  await sb('ixc_sync_config?id=eq.1', {
    method: 'PATCH', prefer: 'return=minimal',
    body: { rodando_desde: null, ultimo_resultado: resultado, ...(apoioEm ? { apoio_em: apoioEm } : {}) },
  }).catch(err => console.error('[ixc-sync] gravar resultado:', err.message));
  if (!resultado.ok) console.error('[ixc-sync]', resultado.erro);
  return resultado;
}

function statusDe(cfg, quem) {
  const { token, ...resto } = cfg;                                   // o token nunca sai daqui
  const rodando = !!cfg.rodando_desde && Date.now() - new Date(cfg.rodando_desde).getTime() < TRAVA_MS;
  let proxima = null;
  if (cfg.ativo) {
    const base = cfg.ultima_execucao ? new Date(cfg.ultima_execucao).getTime() + cfg.intervalo_min * 60e3 : Date.now();
    proxima = new Date(Math.max(base, Date.now()) + (cfg.ultima_execucao ? 0 : 5 * 60e3)).toISOString();
  }
  return { ok: true, config: { ...resto, rodando }, proxima, intervalos: INTERVALOS, admin: quem.perfil === 'admin' };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });
  const b = req.body || {};
  const acao = String(b.acao || '');
  try {
    // ---- o agendador do banco: sem pessoa, com o token da tabela ----
    if (acao === 'rodar') {
      let cfg = null;
      try { cfg = await lerConfig(); } catch { cfg = null; }
      if (!cfg || !tokenConfere(req.headers['x-sync-token'], cfg.token)) return res.status(401).json({ erro: 'token do agendador inválido' });
      return res.status(200).json(await rodar(cfg));
    }

    // ---- a tela do MoviOne ----
    const quem = await quemChama(req);
    if (!quem) return res.status(401).json({ erro: 'sessão expirada: entre de novo no MoviOne' });
    if (!['admin', 'operador'].includes(quem.perfil)) return res.status(403).json({ erro: 'sem acesso à integração com o IXC' });
    const cfg = await lerConfig();
    if (!cfg) return res.status(500).json({ erro: 'falta criar a tabela ixc_sync_config no banco' });
    if (acao === 'status') return res.status(200).json(statusDe(cfg, quem));
    if (quem.perfil !== 'admin') return res.status(403).json({ erro: 'só o administrador muda a sincronização automática' });

    if (acao === 'salvar') {
      const intervalo = Number(b.intervalo_min);
      if (!INTERVALOS.includes(intervalo)) return res.status(400).json({ erro: 'intervalo inválido' });
      const novo = await sb('ixc_sync_config?id=eq.1', {
        method: 'PATCH', prefer: 'return=representation',
        body: { ativo: b.ativo === true, intervalo_min: intervalo, atualizado_em: new Date().toISOString(), atualizado_por: quem.nome },
      });
      return res.status(200).json(statusDe((novo && novo[0]) || cfg, quem));
    }
    if (acao === 'agora') {
      const r = await rodar(cfg, { manual: quem.nome });
      const depois = await lerConfig().catch(() => null);
      return res.status(200).json({ ...r, status: depois ? statusDe(depois, quem) : null });
    }
    return res.status(400).json({ erro: 'ação desconhecida' });
  } catch (err) {
    console.error('[ixc-sync]', err);
    return res.status(500).json({ erro: String(err.message || err).slice(0, 300) });
  }
}
