// ============================================================================
// api/acessos.js — REGISTRO DE ACESSOS AOS SISTEMAS (Vercel Serverless)
// ============================================================================
// Quem entrou em qual sistema, quando e de onde. O IP e o local vêm dos
// cabeçalhos que a Vercel coloca em toda requisição (x-real-ip,
// x-vercel-ip-city, -country-region, -country, -latitude, -longitude): o
// navegador não informa nada disso, então o local não pode ser forjado por
// quem está do outro lado. É um local aproximado, pelo IP: no celular com
// dados móveis costuma aparecer a cidade da operadora.
//
// Isolamento: arquivo próprio, nada compartilhado com os outros proxies.
//
// ENV VARS (as existentes; NÃO crie novas):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// AÇÕES (POST /api/acessos, Authorization: Bearer <token do Supabase>):
//   - "registrar" -> {sistema, evento}  grava o acesso de quem está logado.
//                    sistema: movione | movitalk | movifiber | movitec
//                    evento:  login (entrou com senha) | sessao (abriu já
//                             conectado) | saida | inatividade
//   - "listar"    -> {dias?, usuario_id?, sistema?, evento?, limite?}
//                    só administrador; devolve os acessos e as pessoas.
// ============================================================================

export const SISTEMAS = ['movione', 'movitalk', 'movifiber', 'movitec'];
export const EVENTOS = ['login', 'sessao', 'saida', 'inatividade'];
// "abriu já conectado" repetido (várias abas, F5): um por pessoa, sistema e IP a cada 30 min
const SESSAO_REPETIDA_MS = 30 * 60 * 1000;

function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }

function ambiente() {
  const SUPA_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SRV = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPA_URL || !SRV) throw erro(500, 'Servidor sem a configuração do banco.');
  return { SUPA_URL, SRV };
}

async function sb(e, caminho, opcoes = {}) {
  const r = await fetch(`${e.SUPA_URL}/rest/v1/${caminho}`, {
    ...opcoes,
    headers: { apikey: e.SRV, Authorization: `Bearer ${e.SRV}`, 'Content-Type': 'application/json', ...(opcoes.headers || {}) },
  });
  const txt = await r.text();
  if (!r.ok) throw erro(502, `Banco respondeu ${r.status}: ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : null;
}

// quem está chamando: o token do Supabase decide, nunca o que vem no corpo
export async function quemEsta(e, req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw erro(401, 'Faça login.');
  let u = null;
  try {
    const r = await fetch(`${e.SUPA_URL}/auth/v1/user`, { headers: { apikey: e.SRV, Authorization: `Bearer ${token}` } });
    if (r.ok) u = await r.json();
  } catch { /* cai no erro abaixo */ }
  if (!u || !u.id) throw erro(401, 'Sessão inválida ou expirada.');
  const p = (await sb(e, `perfis?id=eq.${encodeURIComponent(u.id)}&select=nome,email,perfil`))?.[0] || null;
  return { id: u.id, email: u.email || p?.email || null, nome: p?.nome || u.email || null, perfil: p?.perfil || null };
}

const cab = (req, nome) => { const v = req.headers[nome]; return String((Array.isArray(v) ? v[0] : v) || ''); };
const decod = s => { try { return decodeURIComponent(s); } catch { return s; } };
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// IP e local aproximado, pelos cabeçalhos da Vercel (a cidade vem codificada na RFC 3986)
export function localDaRequisicao(req) {
  const ip = cab(req, 'x-real-ip') || cab(req, 'x-forwarded-for').split(',')[0].trim()
    || cab(req, 'x-vercel-forwarded-for').split(',')[0].trim();
  return {
    ip: ip ? ip.slice(0, 64) : null,
    cidade: decod(cab(req, 'x-vercel-ip-city')).slice(0, 80) || null,
    uf: cab(req, 'x-vercel-ip-country-region').slice(0, 10) || null,
    pais: cab(req, 'x-vercel-ip-country').slice(0, 4) || null,
    latitude: num(cab(req, 'x-vercel-ip-latitude')),
    longitude: num(cab(req, 'x-vercel-ip-longitude')),
  };
}

// navegador, sistema e tipo de aparelho, pelo user-agent (só para leitura humana)
export function lerAparelho(ua) {
  ua = String(ua || '');
  const aparelho = /iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? 'tablet'
    : /Mobi|iPhone|iPod|Android/i.test(ua) ? 'celular' : 'computador';
  let so = 'Outro', m;
  if ((m = ua.match(/Windows NT ([\d.]+)/))) so = 'Windows' + ({ '10.0': ' 10/11', '6.3': ' 8.1', '6.2': ' 8', '6.1': ' 7' }[m[1]] || '');
  else if ((m = ua.match(/Android (\d+)/))) so = 'Android ' + m[1];
  else if ((m = ua.match(/(?:iPhone|CPU) OS (\d+)[_.](\d+)/))) so = (/iPad/.test(ua) ? 'iPadOS ' : 'iOS ') + m[1] + '.' + m[2];
  else if (/Mac OS X/.test(ua)) so = 'macOS';
  else if (/CrOS/.test(ua)) so = 'ChromeOS';
  else if (/Linux/.test(ua)) so = 'Linux';
  let navegador = 'Outro';
  if ((m = ua.match(/Edg(?:A|iOS)?\/(\d+)/))) navegador = 'Edge ' + m[1];
  else if ((m = ua.match(/OPR\/(\d+)/))) navegador = 'Opera ' + m[1];
  else if ((m = ua.match(/SamsungBrowser\/(\d+)/))) navegador = 'Samsung Internet ' + m[1];
  else if ((m = ua.match(/(?:Chrome|CriOS)\/(\d+)/))) navegador = 'Chrome ' + m[1];
  else if ((m = ua.match(/(?:Firefox|FxiOS)\/(\d+)/))) navegador = 'Firefox ' + m[1];
  else if ((m = ua.match(/Version\/(\d+)[\d.]* .*Safari/))) navegador = 'Safari ' + m[1];
  return { aparelho, so, navegador };
}

async function registrar(e, req, b) {
  const sistema = String(b.sistema || ''), evento = String(b.evento || '');
  if (!SISTEMAS.includes(sistema)) throw erro(400, 'Sistema inválido.');
  if (!EVENTOS.includes(evento)) throw erro(400, 'Evento inválido.');
  const quem = await quemEsta(e, req);
  const local = localDaRequisicao(req);
  if (evento === 'sessao') {
    const desde = new Date(Date.now() - SESSAO_REPETIDA_MS).toISOString();
    const ip = local.ip ? `ip=eq.${encodeURIComponent(local.ip)}` : 'ip=is.null';
    const ja = await sb(e, `acessos_log?select=id&usuario_id=eq.${quem.id}&sistema=eq.${sistema}&evento=in.(login,sessao)&${ip}&criado_em=gte.${encodeURIComponent(desde)}&limit=1`);
    if (ja && ja.length) return { ok: true, repetido: true };
  }
  const ua = cab(req, 'user-agent');
  const linha = {
    usuario_id: quem.id, usuario_nome: quem.nome, usuario_email: quem.email, perfil: quem.perfil,
    sistema, evento, ...local, ...lerAparelho(ua), user_agent: ua.slice(0, 400) || null,
  };
  await sb(e, 'acessos_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(linha) });
  return { ok: true };
}

async function listar(e, req, b) {
  const quem = await quemEsta(e, req);
  if (quem.perfil !== 'admin') throw erro(403, 'Só administradores veem o registro de acessos.');
  const dias = Math.min(Math.max(parseInt(b.dias, 10) || 7, 1), 365);
  const limite = Math.min(Math.max(parseInt(b.limite, 10) || 500, 1), 2000);
  const desde = new Date(Date.now() - dias * 864e5).toISOString();
  let q = 'acessos_log?select=id,criado_em,usuario_id,usuario_nome,usuario_email,perfil,sistema,evento,ip,cidade,uf,pais,latitude,longitude,navegador,so,aparelho,user_agent'
    + `&criado_em=gte.${encodeURIComponent(desde)}&order=criado_em.desc&limit=${limite}`;
  if (b.usuario_id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(b.usuario_id))) throw erro(400, 'Pessoa inválida.');
    q += `&usuario_id=eq.${b.usuario_id}`;
  }
  if (b.sistema) { if (!SISTEMAS.includes(b.sistema)) throw erro(400, 'Sistema inválido.'); q += `&sistema=eq.${b.sistema}`; }
  if (b.evento) { if (!EVENTOS.includes(b.evento)) throw erro(400, 'Evento inválido.'); q += `&evento=eq.${b.evento}`; }
  const [acessos, pessoas] = await Promise.all([sb(e, q), sb(e, 'perfis?select=id,nome,email,perfil&order=nome.asc')]);
  return { ok: true, acessos: acessos || [], pessoas: pessoas || [], dias, limite };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, erro: 'use POST' });

  let b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch { b = {}; } }
  try {
    const e = ambiente();
    if (b.acao === 'registrar') return res.status(200).json(await registrar(e, req, b));
    if (b.acao === 'listar') return res.status(200).json(await listar(e, req, b));
    return res.status(400).json({ ok: false, erro: 'Ação desconhecida.' });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, erro: err.message || 'Falha no registro de acessos.' });
  }
}
