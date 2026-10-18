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
//   - "campo-publicar"     -> {projetos:[ids], caixas:[...]}  publica o resumo
//                             das caixas em movifiber_caixas (lido pelo app do
//                             tecnico). Substitui o que existia dos projetos
//                             enviados: caixa apagada no projeto some do campo.
//   - "campo-retorno"      -> {projetos:[ids]}  medicoes e divergencias que os
//                             tecnicos registraram na rua.
//   - "inc-listar"         -> instabilidades (incidentes) do MoviFiber.
//   - "inc-previa"         -> quantos clientes um escopo atinge, antes de ativar.
//   - "inc-salvar"         -> cria/edita a instabilidade e resolve os afetados.
//   - "inc-resolver" / "inc-reabrir" / "inc-excluir" / "inc-avisos".
//     O MoviTalk le esses incidentes e responde sozinho quem reclamar.
//   - "debug-schema"       -> 1 registro cru de cada fonte (descobrir colunas).
//   - "monitor-cto"        -> MONITOR DE CTO (chamado pelo pg_cron do Supabase a
//                             cada 3 min, com o token de monitor_cto_config).
//   - "monitor-status" / "monitor-salvar" / "monitor-testar" / "monitor-verificar"
//                             -> tela do monitor no MoviFiber (usuario logado).
//     O monitor usa tambem EVOLUTION_URL / EVOLUTION_APIKEY / EVOLUTION_INSTANCE
//     (as mesmas do MoviTalk) para mandar o alerta no WhatsApp.
// ============================================================================
import crypto from 'crypto';

// o monitor de CTO le todos os logins do IXC e pode tentar o WhatsApp 3 vezes:
// 60s evita que a verificacao seja cortada no meio quando algum dos dois demora
export const config = { maxDuration: 60 };

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
    // ---- monitor de CTO: quem chama e o agendador do banco, nao uma pessoa ----
    if (acao === 'monitor-cto') {
      if (!(await monitorTokenConfere(req))) return res.status(401).json({ erro: 'token do monitor invalido' });
      return res.status(200).json(await monitorCto({}));
    }
    // ---- quem esta chamando? ----
    // O login protege a tela, mas sem esta checagem qualquer um com a URL do proxy
    // leria clientes e projetos. Com MOVIFIBER_EXIGE_LOGIN=1 o acesso passa a exigir
    // o token do usuario; sem a variavel o comportamento antigo e mantido (para o
    // deploy nao quebrar antes de o front novo estar no ar).
    const exigeLogin = String(process.env.MOVIFIBER_EXIGE_LOGIN || '') === '1';
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || b.token || '';
    // o token e sempre conferido quando presente (para registrar a autoria);
    // MOVIFIBER_EXIGE_LOGIN apenas torna a credencial obrigatoria
    const quem = token ? await validarUsuario(token) : { ok: false, motivo: 'sem credencial: faca login no MoviFiber' };
    if (exigeLogin && !quem.ok) return res.status(401).json({ erro: quem.motivo || 'nao autorizado' });
    if (quem.ok) b._usuario = quem.usuario;
    if (acao === 'clientes-movione')  return res.status(200).json(await clientesMoviOne(b.projeto));
    if (acao === 'ixc-status')        return res.status(200).json(await ixcStatus(b.ixc_ids || []));
    if (acao === 'salvar-instalacao') return res.status(200).json(await salvarInstalacao(b));
    if (acao === 'debug-schema')      return res.status(200).json(await debugSchema());
    if (acao === 'proj-listar')       return res.status(200).json(await projListar());
    if (acao === 'proj-carregar')     return res.status(200).json(await projCarregar(b.id));
    if (acao === 'proj-salvar')       return res.status(200).json(await projSalvar(b.projeto, b.versao_base, b.forcar, b._usuario));
    if (acao === 'hist-listar')       return res.status(200).json(await histListar(b.projeto_id));
    if (acao === 'hist-carregar')     return res.status(200).json(await histCarregar(b.id));
    if (acao === 'proj-excluir')      return res.status(200).json(await projExcluir(b.id));
    if (acao === 'campo-publicar')    return res.status(200).json(await campoPublicar(b.projetos || [], b.caixas || [], b._usuario));
    if (acao === 'campo-retorno')     return res.status(200).json(await campoRetorno(b.projetos || []));
    if (acao === 'cat-carregar')      return res.status(200).json(await catCarregar());
    if (acao === 'cat-salvar')        return res.status(200).json(await catSalvar(b.dados));

    // ---- tela do monitor de CTO (sempre com usuario identificado) ----
    if (['monitor-status', 'monitor-salvar', 'monitor-testar', 'monitor-verificar'].includes(acao)) {
      if (!quem.ok) return res.status(401).json({ erro: quem.motivo || 'faca login no MoviFiber' });
      if (acao === 'monitor-status')    return res.status(200).json(await monitorStatus());
      if (acao === 'monitor-verificar') return res.status(200).json(await monitorCto({ simular: true }));
      const admin = await monitorEhAdmin(quem.usuario);
      if (!admin) return res.status(403).json({ erro: 'so administrador muda o monitor de CTO' });
      if (acao === 'monitor-salvar')    return res.status(200).json(await monitorSalvar(b.config || {}, quem.usuario));
      if (acao === 'monitor-testar')    return res.status(200).json(await monitorTestar(quem.usuario));
    }

    // ---- instabilidades (o que o MoviTalk responde sozinho ao cliente) ----
    // Leitura segue a regra geral do proxy; ESCRITA exige usuario identificado
    // mesmo com MOVIFIBER_EXIGE_LOGIN desligado: marcar uma regiao como fora do
    // ar muda o que o bot fala com o cliente, entao tem de ter dono.
    if (acao === 'inc-listar')        return res.status(200).json(await incListar(b));
    if (acao === 'inc-previa')        return res.status(200).json(await incPrevia(b));
    if (acao === 'inc-avisos')        return res.status(200).json(await incAvisos(b.id));
    if (['inc-salvar', 'inc-resolver', 'inc-reabrir', 'inc-excluir'].includes(acao)) {
      if (!quem.ok) return res.status(401).json({ erro: quem.motivo || 'faca login no MoviFiber para marcar instabilidade' });
      if (acao === 'inc-salvar')      return res.status(200).json(await incSalvar(b.incidente, quem.usuario));
      if (acao === 'inc-resolver')    return res.status(200).json(await incResolverIncidente(b.id, quem.usuario));
      if (acao === 'inc-reabrir')     return res.status(200).json(await incReabrir(b.id));
      if (acao === 'inc-excluir')     return res.status(200).json(await incExcluir(b.id));
    }
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

// ------------------------- CAMPO (app do tecnico) ---------------------------
const SB_CAMPO_CX  = 'movifiber_caixas';
const SB_CAMPO_MED = 'movifiber_medicoes_campo';
const SB_CAMPO_PEN = 'movifiber_pendencias_campo';

// Publica o resumo por caixa. Regravar tudo do projeto (delete + insert) e mais
// simples e seguro que diffs: o volume e pequeno (centenas de linhas) e garante
// que caixa removida no projeto desapareca do app do tecnico.
async function campoPublicar(projetos, caixas, usuario) {
  if (!Array.isArray(caixas) || !caixas.length) throw new Error('nada a publicar');
  const ids = [...new Set([...(projetos || []), ...caixas.map(c => c.projeto_id)].filter(Boolean).map(String))];
  if (!ids.length) throw new Error('projeto nao identificado');

  const emLista = ids.map(i => `"${String(i).replace(/"/g, '')}"`).join(',');
  const del = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/${SB_CAMPO_CX}?projeto_id=in.(${emLista})`,
    { method: 'DELETE', headers: sbHeaders() });
  if (!del.ok && del.status !== 404) throw new Error('Supabase DELETE HTTP ' + del.status);

  const quando = new Date().toISOString();
  const quem = usuario ? (usuario.nome || usuario.email || null) : null;

  // PostgREST exige que TODAS as linhas do lote tenham o mesmo conjunto de chaves
  // (PGRST102 "All object keys must match"). CTO com sinal traz campos que CEO/POP
  // nao tem, entao normalizamos: uniao das chaves, faltantes viram null.
  const COLUNAS = [
    'projeto_id','projeto_nome','caixa_id','nome','tipo','status','lat','lng','endereco','splitter',
    'portas_total','portas_inativas','pot_entrada_dbm','pot_saida_dbm','rx_previsto_dbm','tx_real',
    'olt_nome','pon','cabo_nome','fibra','perda_total_db','perda_fibra_db','perda_splitter_db',
    'perda_conector_db','observacao'
  ];
  const linhas = caixas.map(c => {
    const linha = {};
    for (const k of COLUNAS) linha[k] = (c[k] === undefined ? null : c[k]);
    linha.portas_inativas = Array.isArray(c.portas_inativas) ? c.portas_inativas : [];
    linha.portas_total = c.portas_total == null ? 0 : c.portas_total;
    linha.tx_real = c.tx_real === true;
    linha.atualizado_em = quando;
    linha.atualizado_por = quem;
    return linha;
  }).filter(l => l.projeto_id && l.caixa_id && l.nome && l.lat != null && l.lng != null);

  if (!linhas.length) throw new Error('nenhuma caixa valida (falta id, nome ou coordenada)');

  let gravadas = 0;
  for (let i = 0; i < linhas.length; i += 500) {
    const lote = linhas.slice(i, i + 500);
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${SB_CAMPO_CX}`, {
      method: 'POST',
      headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(lote)
    });
    if (!r.ok) throw new Error('Supabase INSERT HTTP ' + r.status + ': ' + (await r.text()).slice(0, 300));
    gravadas += lote.length;
  }
  return { ok: true, gravadas, projetos: ids, em: quando };
}

// Medicoes e divergencias que vieram da rua (para o painel do MoviFiber)
async function campoRetorno(projetos) {
  const ids = (projetos || []).filter(Boolean).map(String);
  const filtro = ids.length ? `&projeto_id=in.(${ids.map(i => `"${i}"`).join(',')})` : '';
  const [med, pen] = await Promise.all([
    fetch(`${process.env.SUPABASE_URL}/rest/v1/${SB_CAMPO_MED}?select=*${filtro}&order=criado_em.desc&limit=100`,
      { headers: sbHeaders() }).then(r => r.ok ? r.json() : []),
    fetch(`${process.env.SUPABASE_URL}/rest/v1/${SB_CAMPO_PEN}?select=*${filtro}&order=criado_em.desc&limit=60`,
      { headers: sbHeaders() }).then(r => r.ok ? r.json() : []),
  ]);
  return { medicoes: med || [], pendencias: pen || [] };
}

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

  // O /auth/v1/user exige um apikey do projeto — QUALQUER um serve, porque quem
  // identifica a pessoa e o token dela no Authorization. Antes so a anon key
  // valia, e ela e uma variavel separada que ninguem sabia ser necessaria: sem
  // ela na Vercel, TODA marcacao de instabilidade voltava 401 dizendo "faca
  // login", com o operador ja logado. A service_role, que o proxy sempre tem,
  // resolve a chamada igual e nunca sai do servidor.
  const anon = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  let dado;
  try {
    // 1) o token e valido?
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` }
    });
    if (!r.ok) {
      // 401 aqui e sessao vencida; 4xx/5xx com apikey ruim e problema DO SERVIDOR,
      // e mandar o operador "entrar de novo" so faz ele repetir o login a toa
      dado = { ok: false, motivo: r.status === 401 || r.status === 403
        ? 'sessao expirada: saia e entre novamente no MoviFiber'
        : 'o servidor nao conseguiu conferir a sessao (Supabase HTTP ' + r.status + ')' };
    } else {
      const u = await r.json();
      // 2) esse usuario tem o MoviFiber liberado?
      const rp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/tem_movifiber`, {
        method: 'POST',
        headers: { ...sbHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_id: u.id })
      });
      if (!rp.ok) {
        dado = { ok: false, motivo: 'nao consegui conferir a permissao do MoviFiber (Supabase HTTP ' + rp.status + ')' };
      } else if (await rp.json() === true) {
        // busca o nome do cadastro para o historico ficar legivel
        let nome = null;
        try {
          const rn = await fetch(`${process.env.SUPABASE_URL}/rest/v1/perfis?id=eq.${u.id}&select=nome`,
                                 { headers: sbHeaders() });
          if (rn.ok) nome = ((await rn.json())[0] || {}).nome || null;
        } catch (e) {}
        dado = { ok: true, usuario: { id: u.id, email: u.email, nome } };
      } else {
        dado = { ok: false, motivo: 'seu usuario nao tem o MoviFiber liberado — peca a um admin para marcar "MoviFiber" no cadastro de usuarios do MoviOne' };
      }
    }
  } catch (e) {
    dado = { ok: false, motivo: 'falha ao falar com o Supabase: ' + (e.message || e) };
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
async function projSalvar(p, versaoBase, forcar, autor) {
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
  // registra no historico (nunca deixa o salvamento falhar por causa disso)
  try { await registrarHistorico(p, agora, autor); } catch (e) { console.warn('[historico]', e.message); }
  return { ok: true, id: p.id, versao: agora };
}

/* ---- Historico de alteracoes ---- */
const SB_HIST = 'movifiber_historico';
function _resumoMudancas(antes, depois) {
  if (!antes) return 'Projeto criado';
  const partes = [];
  const nomes = (arr) => new Map((arr || []).map(x => [x.id, x.nome || x.id]));
  const cmp = (rotuloS, rotuloP, ant, dep) => {
    const a = nomes(ant), d = nomes(dep);
    const novos = [...d.keys()].filter(k => !a.has(k));
    const saiu  = [...a.keys()].filter(k => !d.has(k));
    const mudou = [...d.keys()].filter(k => a.has(k) && a.get(k) !== d.get(k));
    if (novos.length) partes.push(`+${novos.length} ${novos.length > 1 ? rotuloP : rotuloS}` +
      (novos.length <= 3 ? ' (' + novos.map(k => d.get(k)).join(', ') + ')' : ''));
    if (saiu.length) partes.push(`−${saiu.length} ${saiu.length > 1 ? rotuloP : rotuloS}` +
      (saiu.length <= 3 ? ' (' + saiu.map(k => a.get(k)).join(', ') + ')' : ''));
    if (mudou.length) partes.push(`${mudou.length} ${mudou.length > 1 ? rotuloP : rotuloS} renomeado(s)`);
  };
  cmp('elemento', 'elementos', antes.elementos, depois.elementos);
  cmp('cabo', 'cabos', antes.cabos, depois.cabos);
  // fusoes
  const nFus = (o) => Object.values(o && o.fusoes || {}).reduce((s, f) => s + ((f && f.fusoes || []).length), 0);
  const df = nFus(depois) - nFus(antes);
  if (df > 0) partes.push(`+${df} fusão(ões)`);
  if (df < 0) partes.push(`−${-df} fusão(ões)`);
  // clientes
  const dc = (depois.clientes || []).length - (antes.clientes || []).length;
  if (dc > 0) partes.push(`+${dc} cliente(s)`);
  if (dc < 0) partes.push(`−${-dc} cliente(s)`);
  return partes.length ? partes.join(' · ') : 'Ajustes no projeto';
}
async function registrarHistorico(p, versao, autor) {
  // ultimo retrato para comparar
  const urlUlt = `${process.env.SUPABASE_URL}/rest/v1/${SB_HIST}`
    + `?projeto_id=eq.${encodeURIComponent(p.id)}&select=dados&order=versao.desc&limit=1`;
  const rU = await fetch(urlUlt, { headers: sbHeaders() });
  const ult = rU.ok ? (await rU.json())[0] : null;
  const resumo = _resumoMudancas(ult && ult.dados, p);

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/${SB_HIST}`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      projeto_id: p.id, projeto_nome: p.nome || null, versao,
      autor_id: (autor && autor.id) || null,
      autor_nome: (autor && (autor.nome || autor.email)) || null,
      resumo,
      qtd_elementos: (p.elementos || []).length,
      qtd_cabos: (p.cabos || []).length,
      dados: p
    })
  });
  // mantem o historico enxuto
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/movifiber_podar_historico`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_projeto: p.id, p_manter: 40 })
  });
}
async function histListar(projetoId) {
  if (!projetoId) throw new Error('projeto obrigatorio');
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SB_HIST}`
    + `?projeto_id=eq.${encodeURIComponent(projetoId)}`
    + `&select=id,versao,autor_nome,resumo,qtd_elementos,qtd_cabos&order=versao.desc&limit=40`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
  return { versoes: await r.json() };
}
async function histCarregar(histId) {
  if (!histId) throw new Error('id obrigatorio');
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SB_HIST}?id=eq.${encodeURIComponent(histId)}&select=*`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
  return { versao: (await r.json())[0] || null };
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

// ============================================================================
// INSTABILIDADES (INCIDENTES DE REDE)  —  MoviFiber ➜ MoviTalk
// ----------------------------------------------------------------------------
// O operador marca no MoviFiber que um projeto, uma area ou um conjunto de
// caixas esta fora do ar. Este proxy resolve QUEM sao os clientes atingidos e
// guarda o incidente. O MoviTalk (api/atendimento.js) le os incidentes ativos e,
// quando um cliente atingido escreve reclamando, responde sozinho com o aviso.
//
// Nada aqui dispara mensagem em massa: o aviso e sempre uma RESPOSTA a quem
// procurou o atendimento. Isso e proposital — evita transformar um engano de
// marcacao em centenas de mensagens indevidas.
//
// MIGRATION (rode uma vez no SQL Editor do Supabase):
//
//   create table if not exists movifiber_incidentes (
//     id            uuid primary key default gen_random_uuid(),
//     protocolo     text unique,
//     titulo        text not null,
//     tipo          text not null default 'queda',      -- queda|lentidao|manutencao|rompimento
//     escopo        text not null default 'projeto',    -- projeto|area|caixas
//     projeto_id    text,
//     projeto_nome  text,
//     area_nome     text,
//     poligono      jsonb  not null default '[]'::jsonb, -- [[lat,lng],...]
//     caixas        jsonb  not null default '[]'::jsonb, -- [{id,nome}]
//     mensagem      text not null,
//     gatilho       text not null default 'reclamacao', -- reclamacao|qualquer
//     encerrar      boolean not null default false,
//     previsao      timestamptz,
//     status        text not null default 'ativo',      -- ativo|resolvido
//     clientes_ids  jsonb not null default '[]'::jsonb,
//     clientes_ixc  jsonb not null default '[]'::jsonb,
//     afetados      integer not null default 0,
//     criado_em     timestamptz not null default now(),
//     criado_por    text,
//     atualizado_em timestamptz not null default now(),
//     resolvido_em  timestamptz,
//     resolvido_por text
//   );
//   create index if not exists movifiber_incidentes_status_idx  on movifiber_incidentes(status);
//   create index if not exists movifiber_incidentes_projeto_idx on movifiber_incidentes(projeto_id);
//
//   create table if not exists movifiber_incidente_avisos (
//     id           bigserial primary key,
//     incidente_id uuid not null references movifiber_incidentes(id) on delete cascade,
//     conversa_id  bigint,
//     contato_fone text not null,
//     cliente_ixc_id text,
//     enviado_em   timestamptz not null default now()
//   );
//   create index if not exists movifiber_avisos_busca_idx
//     on movifiber_incidente_avisos(incidente_id, contato_fone, enviado_em desc);
//
//   alter table movifiber_incidentes        enable row level security;
//   alter table movifiber_incidente_avisos  enable row level security;
//   -- sem policy: so a service_role (os proxies) enxerga. O front passa pelo proxy.
// ============================================================================
const SB_INC     = 'movifiber_incidentes';
const SB_INC_AVI = 'movifiber_incidente_avisos';

const INC_TIPOS  = ['queda', 'lentidao', 'manutencao', 'rompimento'];
const INC_ESCOPOS = ['projeto', 'area', 'caixas'];

function incErroTabela(status, corpo) {
  // PGRST205 = tabela inexistente. Sem esta dica o operador ve so "HTTP 404".
  if (status === 404 || /PGRST205|does not exist/i.test(String(corpo))) {
    return new Error('tabela ' + SB_INC + ' nao existe — rode a migration das instabilidades '
      + '(o SQL esta no cabecalho da secao INSTABILIDADES em api/movifiber.js)');
  }
  return new Error('Supabase HTTP ' + status + ': ' + String(corpo).slice(0, 300));
}

// Ray casting. Poligono = [[lat,lng],...]; o primeiro ponto NAO precisa repetir no fim.
function pontoNoPoligono(lat, lng, poly) {
  if (!isFinite(lat) || !isFinite(lng) || !Array.isArray(poly) || poly.length < 3) return false;
  let dentro = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    const corta = (xi > lng) !== (xj > lng)
      && lat < ((yj - yi) * (lng - xi)) / ((xj - xi) || 1e-12) + yi;
    if (corta) dentro = !dentro;
  }
  return dentro;
}

/* Quem esta dentro do incidente.
   - projeto / caixas: parte do VINCULO FTTH (quem o campo ja amarrou na caixa).
   - area: parte da COORDENADA do cliente, entao pega tambem quem ainda nao tem
     vinculo de caixa registrado — numa queda de regiao esse pessoal reclama igual. */
async function incResolverAfetados(o) {
  const escopo = INC_ESCOPOS.includes(o.escopo) ? o.escopo : 'projeto';
  const vistos = new Map();
  const juntar = (id, nome, ixc, caixa, bairro) => {
    if (id == null) return;
    if (!vistos.has(String(id))) vistos.set(String(id), { id, nome: nome || null, ixc_id: ixc ?? null, caixa_id: caixa ?? null, bairro: bairro || null });
  };

  if (escopo === 'area') {
    const poly = (Array.isArray(o.poligono) ? o.poligono : [])
      .filter(p => Array.isArray(p) && p.length >= 2 && isFinite(+p[0]) && isFinite(+p[1]))
      .map(p => [+p[0], +p[1]]);
    if (poly.length < 3) throw new Error('area sem poligono valido (minimo 3 pontos)');
    const url = `${process.env.SUPABASE_URL}/rest/v1/${SB_CLIENTES}`
      + `?select=${SB_ID},${SB_NOME},${SB_IXCID},${SB_LAT},${SB_LNG},bairro`
      + `&${SB_LAT}=not.is.null&${SB_LNG}=not.is.null`;
    const linhas = await sbGetAll(url);
    for (const c of linhas) {
      if (pontoNoPoligono(+c[SB_LAT], +c[SB_LNG], poly)) juntar(c[SB_ID], c[SB_NOME], c[SB_IXCID], null, c.bairro);
    }
    return montarAfetados(vistos);
  }

  const base = `${process.env.SUPABASE_URL}/rest/v1/${SB_INSTAL}`
    + `?select=projeto_ftth,caixa_id,caixa_nome,`
    + `${SB_CLIENTES}!${SB_INSTAL}_cliente_id_fkey(${SB_ID},${SB_NOME},${SB_IXCID},bairro)`
    + `&order=id.asc`;
  const rows = await sbGetAll(base);
  const caixas = new Set((o.caixas || []).map(c => String(c && c.id != null ? c.id : c)).filter(Boolean));
  if (escopo === 'caixas' && !caixas.size) throw new Error('nenhuma caixa selecionada');
  // projeto_ftth guarda o NOME do projeto ("FTTH-MAISA"), nao o id do MoviFiber
  // ("prj-kj5ma6") — quem preenche e o app do tecnico, escolhendo pela lista.
  // Aceitar os dois evita depender de qual deles chegou no vinculo.
  const norm = v => String(v == null ? '' : v).trim().toUpperCase();
  const alvos = new Set([o.projeto_id, o.projeto_nome].filter(Boolean).map(norm));
  if (escopo === 'projeto' && !alvos.size) throw new Error('projeto nao informado');

  for (const x of rows) {
    const c = Array.isArray(x[SB_CLIENTES]) ? x[SB_CLIENTES][0] : x[SB_CLIENTES];
    if (!c) continue;
    if (escopo === 'caixas') {
      if (!caixas.has(String(x.caixa_id))) continue;
    } else {
      if (!alvos.has(norm(x.projeto_ftth))) continue;
    }
    juntar(c[SB_ID], c[SB_NOME], c[SB_IXCID], x.caixa_id, c.bairro);
  }
  return montarAfetados(vistos);
}
function montarAfetados(mapa) {
  const clientes = [...mapa.values()];
  // Os bairros de quem está dentro. Servem para o painel sugerir o nome da
  // REGIÃO que vai na mensagem: quem marca a área no mapa não tem por que
  // adivinhar como o cliente chama aquele pedaço da cidade.
  const conta = new Map();
  for (const c of clientes) {
    const b = String(c.bairro || '').trim();
    if (!b) continue;
    conta.set(b, (conta.get(b) || 0) + 1);
  }
  const bairros = [...conta.entries()]
    .map(([nome, qtd]) => ({ nome, qtd }))
    .sort((a, b) => b.qtd - a.qtd)
    .slice(0, 6);
  return {
    clientes,
    ids: clientes.map(c => c.id),
    ixc: clientes.map(c => c.ixc_id).filter(v => v != null && v !== '').map(String),
    bairros,
    total: clientes.length
  };
}

function incProtocolo() {
  return 'INC-' + Date.now().toString(36).toUpperCase().slice(-5)
    + Math.random().toString(36).slice(2, 4).toUpperCase();
}

async function incListar(o = {}) {
  const filtros = [];
  if (o.status && o.status !== 'todos') filtros.push(`status=eq.${encodeURIComponent(o.status)}`);
  if (o.projeto) filtros.push(`projeto_id=eq.${encodeURIComponent(o.projeto)}`);
  const url = `${process.env.SUPABASE_URL}/rest/v1/${SB_INC}`
    + `?select=*&order=criado_em.desc&limit=${Math.min(+o.limite || 60, 200)}`
    + (filtros.length ? '&' + filtros.join('&') : '');
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw incErroTabela(r.status, await r.text());
  const incidentes = await r.json();

  // quantos clientes ja receberam o aviso automatico em cada incidente ativo
  const avisos = {};
  const ativos = incidentes.filter(i => i.status === 'ativo').map(i => i.id);
  if (ativos.length) {
    const lista = ativos.map(i => `"${String(i).replace(/"/g, '')}"`).join(',');
    const ra = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/${SB_INC_AVI}?select=incidente_id,contato_fone&incidente_id=in.(${lista})`,
      { headers: sbHeaders() });
    if (ra.ok) {
      const porInc = {};
      for (const a of await ra.json()) {
        (porInc[a.incidente_id] = porInc[a.incidente_id] || new Set()).add(a.contato_fone);
      }
      for (const k of Object.keys(porInc)) avisos[k] = porInc[k].size;
    }
  }
  return { incidentes, avisos };
}

async function incSalvar(inc, usuario) {
  if (!inc || typeof inc !== 'object') throw new Error('incidente invalido');
  const titulo = String(inc.titulo || '').trim();
  const mensagem = String(inc.mensagem || '').trim();
  if (!titulo) throw new Error('informe um titulo para a instabilidade');
  if (!mensagem) throw new Error('informe a mensagem que o bot vai enviar');
  if (mensagem.length > 1200) throw new Error('mensagem muito longa (maximo 1200 caracteres)');
  // {{regiao}} vai DENTRO da mensagem que o cliente le. Sem um nome de gente,
  // ele recebia "instabilidade na regiao Area marcada no mapa" — o rotulo
  // interno do desenho virava texto de atendimento.
  const regiao = String(inc.area_nome || '').trim();
  if (mensagem.includes('{{regiao}}')) {
    if (!regiao) throw new Error('informe o nome da regiao (bairro, rua, condominio) — ele aparece na mensagem do cliente');
    if (/^area marcada no mapa$/i.test(regiao.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) {
      throw new Error('troque "Area marcada no mapa" pelo nome real da regiao — e isso que o cliente vai ler');
    }
  }

  const escopo = INC_ESCOPOS.includes(inc.escopo) ? inc.escopo : 'projeto';
  const caixas = (Array.isArray(inc.caixas) ? inc.caixas : [])
    .map(c => ({ id: String(c.id ?? c), nome: String(c.nome ?? c.id ?? c) })).slice(0, 2000);
  const poligono = (Array.isArray(inc.poligono) ? inc.poligono : [])
    .filter(p => Array.isArray(p) && p.length >= 2).map(p => [+p[0], +p[1]]).slice(0, 5000);

  // Instabilidade criada pelo MONITOR DE CTO: as caixas dela vem do IXC
  // ("ixc:12"), que o vinculo do MoviFiber nao conhece. Editar o texto ou a
  // previsao no painel nao pode zerar a lista de clientes — enquanto as caixas
  // forem as mesmas, a lista que o monitor gravou continua valendo.
  let afetados = null;
  if (inc.id) {
    const existente = ((await monSb(`${SB_INC}?id=eq.${encodeURIComponent(String(inc.id))}`
      + `&select=origem,caixas,clientes_ids,clientes_ixc,afetados`).catch(() => [])) || [])[0];
    const chaves = l => JSON.stringify((l || []).map(c => String(c && c.id != null ? c.id : c)).sort());
    if (existente && existente.origem === 'monitor' && escopo === 'caixas' && chaves(existente.caixas) === chaves(caixas)) {
      afetados = { ids: existente.clientes_ids || [], ixc: existente.clientes_ixc || [], total: existente.afetados || 0, clientes: [], bairros: [] };
    }
  }
  if (!afetados) afetados = await incResolverAfetados({
    escopo, projeto_id: inc.projeto_id, projeto_nome: inc.projeto_nome, caixas, poligono
  });

  const agora = new Date().toISOString();
  const quem = usuario ? (usuario.nome || usuario.email || null) : null;
  const row = {
    titulo, mensagem, escopo,
    tipo: INC_TIPOS.includes(inc.tipo) ? inc.tipo : 'queda',
    projeto_id: inc.projeto_id ? String(inc.projeto_id) : null,
    projeto_nome: inc.projeto_nome ? String(inc.projeto_nome) : null,
    area_nome: regiao || null,
    poligono, caixas,
    gatilho: inc.gatilho === 'qualquer' ? 'qualquer' : 'reclamacao',
    encerrar: inc.encerrar === true,
    previsao: inc.previsao || null,
    status: inc.status === 'resolvido' ? 'resolvido' : 'ativo',
    clientes_ids: afetados.ids,
    clientes_ixc: afetados.ixc,
    afetados: afetados.total,
    atualizado_em: agora
  };
  if (inc.id) row.id = String(inc.id);
  else {
    row.protocolo = incProtocolo();
    row.criado_em = agora;
    row.criado_por = quem;
  }

  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${SB_INC}`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row)
  });
  if (!r.ok) throw incErroTabela(r.status, await r.text());
  const salvo = (await r.json())[0] || row;
  return { ok: true, incidente: salvo, afetados: afetados.total, amostra: afetados.clientes.slice(0, 8), bairros: afetados.bairros };
}

async function incResolverIncidente(id, usuario) {
  if (!id) throw new Error('id obrigatorio');
  const agora = new Date().toISOString();
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${SB_INC}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'resolvido', resolvido_em: agora, atualizado_em: agora,
      resolvido_por: usuario ? (usuario.nome || usuario.email || null) : null
    })
  });
  if (!r.ok) throw incErroTabela(r.status, await r.text());
  return { ok: true, incidente: (await r.json())[0] || null };
}

async function incReabrir(id) {
  if (!id) throw new Error('id obrigatorio');
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${SB_INC}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'ativo', resolvido_em: null, resolvido_por: null, atualizado_em: new Date().toISOString() })
  });
  if (!r.ok) throw incErroTabela(r.status, await r.text());
  return { ok: true, incidente: (await r.json())[0] || null };
}

async function incExcluir(id) {
  if (!id) throw new Error('id obrigatorio');
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${SB_INC}?id=eq.${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: sbHeaders() });
  if (!r.ok && r.status !== 404) throw incErroTabela(r.status, await r.text());
  return { ok: true };
}

// Previa: quantos clientes o operador vai atingir ANTES de ativar o aviso.
async function incPrevia(o) {
  const a = await incResolverAfetados({
    escopo: o.escopo, projeto_id: o.projeto_id, projeto_nome: o.projeto_nome,
    caixas: o.caixas || [], poligono: o.poligono || []
  });
  return { ok: true, afetados: a.total, amostra: a.clientes.slice(0, 8), bairros: a.bairros };
}

// Quem ja recebeu o aviso automatico deste incidente (acompanhamento no painel).
async function incAvisos(id) {
  if (!id) throw new Error('id obrigatorio');
  const r = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/${SB_INC_AVI}?select=*&incidente_id=eq.${encodeURIComponent(id)}&order=enviado_em.desc&limit=200`,
    { headers: sbHeaders() });
  if (!r.ok) throw incErroTabela(r.status, await r.text());
  return { ok: true, avisos: await r.json() };
}

// ============================================================================
// MONITOR DE CTO — a rede avisando o dono antes de o cliente ligar
// ----------------------------------------------------------------------------
// A cada 3 minutos o pg_cron do Supabase faz POST {acao:"monitor-cto"} com o
// token guardado em monitor_cto_config (gerado no banco; ninguem precisa ver).
// Aqui o monitor olha os logins do IXC caixa por caixa:
//
//   CAIU = nenhum login da caixa esta online AGORA, pelo menos `min_clientes`
//          cairam nos ultimos `recentes_min` minutos e todas essas quedas
//          aconteceram dentro de `janela_min` minutos ("de uma vez so").
//
// Login que ja estava fora havia horas (cliente viajando, ONU desligada) nao
// conta nem a favor nem contra: o que importa e quem estava online e caiu
// junto. Queda gradual, um cliente de cada vez, nao e falha de caixa.
//
// Quando cai, manda UM WhatsApp para os numeros configurados com as caixas
// atingidas. A resposta ("1" ativa, "2" ignora) chega pelo webhook do MoviTalk
// (api/atendimento.js), que cria a instabilidade igual a marcacao manual.
// Depois, quando a maioria volta, o proprio monitor encerra o aviso sozinho.
//
// De onde vem a caixa de cada cliente:
//   1. IXC: radusuarios.id_caixa_ftth (a CTO cadastrada no login);
//   2. MoviFiber/Campo: ftth_cliente_instalacao, para quem nao tem caixa no IXC.
// ============================================================================
const SB_MON_CFG = 'monitor_cto_config';
const SB_MON_ALE = 'monitor_cto_alertas';
const MON_TZ = process.env.TZ_ISP || 'America/Fortaleza';
const MON_IXC_OFFSET = process.env.IXC_TZ_OFFSET || '-03:00';   // horario que o IXC grava
const MON_PENDENTE_H = 6;            // alerta sem resposta vence depois disso
const MON_CAIXAS_CANDIDATAS = ['rad_caixa_ftth', 'caixa_ftth', 'ftth_caixa'];
let _monNomesCaixa = { em: 0, mapa: new Map(), tabela: null };

async function monSb(path, opts = {}) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${txt.slice(0, 300)}`);
  try { return txt ? JSON.parse(txt) : null; } catch { return null; }
}

async function monitorConfig() {
  const r = await monSb(`${SB_MON_CFG}?id=eq.1&select=*`);
  return (r && r[0]) || null;
}

/* O token vem do proprio banco (o job do pg_cron le a mesma linha). Comparacao
   em tempo constante: o endpoint e publico e responde a qualquer um. */
async function monitorTokenConfere(req) {
  const recebido = String(req.headers['x-monitor-token'] || '');
  if (recebido.length < 20) return false;
  let cfg;
  try { cfg = await monitorConfig(); } catch { return false; }
  const esperado = Buffer.from(String((cfg && cfg.token) || ''));
  const veio = Buffer.from(recebido);          // compara em bytes: acento muda o tamanho
  if (!esperado.length || esperado.length !== veio.length) return false;
  return crypto.timingSafeEqual(veio, esperado);
}

async function monitorEhAdmin(usuario) {
  if (!usuario || !usuario.id) return false;
  try {
    const r = await monSb(`perfis?id=eq.${encodeURIComponent(usuario.id)}&select=perfil`);
    return !!(r && r[0] && r[0].perfil === 'admin');
  } catch { return false; }
}

// "2026-10-18 14:32:10" (hora local do IXC) -> ms. Data zerada = nunca conectou.
function monIxcData(s) {
  const t = String(s || '').trim();
  if (!t || /^0000/.test(t)) return null;
  const ms = Date.parse(t.replace(' ', 'T') + MON_IXC_OFFSET);
  return isNaN(ms) ? null : ms;
}
function monHora(ms) {
  return new Date(ms).toLocaleTimeString('pt-BR', { timeZone: MON_TZ, hour: '2-digit', minute: '2-digit' });
}
function monDataHora(ms) {
  return new Date(ms).toLocaleString('pt-BR', { timeZone: MON_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
}
function monFone(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return '';
  return d.startsWith('55') ? d : '55' + d;
}

/* Nome da caixa no IXC. O nome da tabela muda entre versoes do IXC; testa as
   candidatas uma vez e guarda qual respondeu. Sem nome, vira "CTO #12". */
async function monNomesCaixasIxc(ids) {
  if (Date.now() - _monNomesCaixa.em > 3600e3) _monNomesCaixa = { em: Date.now(), mapa: new Map(), tabela: _monNomesCaixa.tabela || null };
  const faltam = ids.filter(id => !_monNomesCaixa.mapa.has(id));
  // '' = nenhuma tabela de caixas respondeu nesta hora: nao insiste a cada passada
  if (!faltam.length || _monNomesCaixa.tabela === '') return _monNomesCaixa.mapa;
  const tabelas = _monNomesCaixa.tabela ? [_monNomesCaixa.tabela] : MON_CAIXAS_CANDIDATAS;
  let achou = false;
  for (const tb of tabelas) {
    try {
      const regs = [];
      for (let i = 0; i < faltam.length; i += 400) {
        regs.push(...await ixcListarTudo(tb, { qtype: `${tb}.id`, query: faltam.slice(i, i + 400).join(','), oper: 'IN', sortname: `${tb}.id`, sortorder: 'asc' }));
      }
      for (const c of regs) {
        const nome = String(c.descricao || c.nome || c.identificacao || c.caixa || '').trim();
        if (nome) _monNomesCaixa.mapa.set(String(c.id), nome);
      }
      _monNomesCaixa.tabela = tb; achou = true;
      break;
    } catch { /* tabela inexistente nesta versao: tenta a proxima */ }
  }
  if (!achou) _monNomesCaixa.tabela = '';
  // quem nao veio com nome nao e consultado de novo nesta hora
  for (const id of faltam) if (!_monNomesCaixa.mapa.has(id)) _monNomesCaixa.mapa.set(id, null);
  return _monNomesCaixa.mapa;
}

/* Todos os logins monitorados, agrupados por caixa. */
async function monColetar() {
  const R = IXC_TB_RAD;
  // 1) logins com CTO cadastrada no IXC
  const comCaixa = await ixcListarTudo(R, {
    qtype: `${R}.id_caixa_ftth`, query: '0', oper: '>', sortname: `${R}.id`, sortorder: 'asc'
  });
  // 2) clientes do MoviOne (nome, bairro, ativo) — uma leitura so
  const clientes = await sbGetAll(`${process.env.SUPABASE_URL}/rest/v1/${SB_CLIENTES}`
    + `?select=${SB_ID},${SB_NOME},nome,${SB_IXCID},bairro,ativo&${SB_IXCID}=not.is.null`);
  const porIxc = new Map();
  for (const c of clientes) porIxc.set(String(c[SB_IXCID]).trim(), c);

  const grupos = new Map();
  const logins = new Map();          // id do login -> estado (para conferir a volta)
  const juntar = (chave, nome, projeto, u) => {
    if (String(u.ativo || 'S').toUpperCase() !== 'S') return;            // login desativado no IXC
    const cliIxc = String(u[R_CLIENTE] || '').trim();
    const cli = porIxc.get(cliIxc) || null;
    if (cli && cli.ativo === false) return;                                 // cliente cancelado
    const l = {
      login_id: String(u[R_ID]), cli_ixc: cliIxc || null,
      cliente_id: cli ? cli[SB_ID] : null,
      nome: cli ? (cli[SB_NOME] || cli.nome || null) : null,
      bairro: cli ? (cli.bairro || null) : null,
      online: String(u[R_ONLINE] || '').toUpperCase() === 'S',
      fim: monIxcData(u.ultima_conexao_final),
      motivo: String(u.motivo_desconexao || '').trim() || null,
    };
    logins.set(l.login_id, l);
    if (!grupos.has(chave)) grupos.set(chave, { chave, nome, projeto, logins: [] });
    const g = grupos.get(chave);
    if (!g.logins.some(x => x.login_id === l.login_id)) g.logins.push(l);
  };

  const idsCaixaIxc = [...new Set(comCaixa.map(u => String(u.id_caixa_ftth || '').trim()).filter(v => v && v !== '0'))];
  const nomes = await monNomesCaixasIxc(idsCaixaIxc).catch(() => new Map());
  const cobertos = new Set();
  for (const u of comCaixa) {
    const cx = String(u.id_caixa_ftth || '').trim();
    if (!cx || cx === '0') continue;
    cobertos.add(String(u[R_CLIENTE] || '').trim());
    juntar('ixc:' + cx, nomes.get(cx) || ('CTO #' + cx), null, u);
  }

  // 3) quem so tem a caixa no MoviFiber/Campo
  let vinculos = [];
  try {
    vinculos = await sbGetAll(`${process.env.SUPABASE_URL}/rest/v1/${SB_INSTAL}`
      + `?select=projeto_ftth,caixa_id,caixa_nome,${SB_CLIENTES}!${SB_INSTAL}_cliente_id_fkey(${SB_IXCID})&caixa_id=not.is.null&order=id.asc`);
  } catch { vinculos = []; }
  const mf = new Map();    // ixc do cliente -> vinculo
  for (const v of vinculos) {
    const c = Array.isArray(v[SB_CLIENTES]) ? v[SB_CLIENTES][0] : v[SB_CLIENTES];
    const ixcId = c && c[SB_IXCID] != null ? String(c[SB_IXCID]).trim() : '';
    if (ixcId && !cobertos.has(ixcId)) mf.set(ixcId, v);
  }
  if (mf.size) {
    const ids = [...mf.keys()];
    for (let i = 0; i < ids.length; i += 400) {
      const regs = await ixcListarTudo(R, {
        qtype: `${R}.${R_CLIENTE}`, query: ids.slice(i, i + 400).join(','), oper: 'IN', sortname: `${R}.${R_ID}`, sortorder: 'asc'
      }).catch(() => []);
      for (const u of regs) {
        const v = mf.get(String(u[R_CLIENTE] || '').trim());
        if (v) juntar('mf:' + v.caixa_id, v.caixa_nome || ('Caixa ' + v.caixa_id), v.projeto_ftth || null, u);
      }
    }
  }
  const ativosMoviOne = clientes.filter(c => c.ativo === true).length;
  const comCaixaAtivos = new Set([...logins.values()].map(l => l.cli_ixc).filter(Boolean)).size;
  return { grupos: [...grupos.values()], logins, cobertura: { clientes_ativos: ativosMoviOne, clientes_com_caixa: comCaixaAtivos, logins: logins.size } };
}

/* A regra de "caiu de uma vez". Devolve null quando a caixa esta bem. */
function monAvaliarCaixa(g, cfg, agora) {
  const mon = g.logins;
  const online = mon.filter(l => l.online);
  const lim = agora - cfg.recentes_min * 60e3;
  const recentes = mon.filter(l => !l.online && l.fim && l.fim >= lim && l.fim <= agora + 120e3);
  const estado = { total: mon.length, online: online.length, recentes: recentes.length };
  if (mon.length < cfg.min_clientes) return { ...estado, monitorada: false, caiu: false };
  if (online.length > 0 || recentes.length < cfg.min_clientes) return { ...estado, monitorada: true, caiu: false };
  const ts = recentes.map(l => l.fim).sort((a, b) => a - b);
  const espalhou = ts[ts.length - 1] - ts[0];
  if (espalhou > cfg.janela_min * 60e3) return { ...estado, monitorada: true, caiu: false, gradual: true };
  const motivos = {};
  for (const l of recentes) { const m = l.motivo || 'sem motivo'; motivos[m] = (motivos[m] || 0) + 1; }
  return { ...estado, monitorada: true, caiu: true, primeira: ts[0], ultima: ts[ts.length - 1], motivos };
}

function monBairros(logins) {
  const conta = new Map();
  for (const l of logins) { const b = String(l.bairro || '').trim(); if (b) conta.set(b, (conta.get(b) || 0) + 1); }
  return [...conta.entries()].map(([nome, qtd]) => ({ nome, qtd })).sort((a, b) => b.qtd - a.qtd).slice(0, 5);
}

async function monWaEnviar(fone, texto) {
  const url = (process.env.EVOLUTION_URL || '').replace(/\/$/, '');
  const key = process.env.EVOLUTION_APIKEY || '', inst = process.env.EVOLUTION_INSTANCE || '';
  if (!url || !key || !inst) throw new Error('WhatsApp (Evolution) nao configurado na Vercel');
  let ultimo = null;
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(`${url}/message/sendText/${inst}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key },
        body: JSON.stringify({ number: monFone(fone), text: texto })
      });
      const txt = await r.text();
      if (r.ok) { let d = {}; try { d = JSON.parse(txt); } catch {} return d?.key?.id || d?.data?.key?.id || d?.messageId || d?.id || null; }
      ultimo = `Evolution ${r.status}: ${txt.slice(0, 200)}`;
    } catch (err) { ultimo = err.message; }
    await new Promise(r2 => setTimeout(r2, i * 2000));
  }
  throw new Error(ultimo || 'falha no envio');
}
async function monAvisarDonos(cfg, texto) {
  const fones = (cfg.fones || []).map(monFone).filter(f => f.length >= 12);
  const ids = [], para = [], erros = [];
  for (const f of fones) {
    try { const id = await monWaEnviar(f, texto); if (id) ids.push(id); para.push(f); }
    catch (err) { erros.push(`${f}: ${err.message}`); }
  }
  return { ids, para, erros, semNumero: !fones.length };
}

function monTextoAlerta(novos, cfg) {
  const linhas = novos.map(a => {
    const regiao = (a.bairros || []).slice(0, 2).map(b => b.nome).join(', ');
    const motivo = Object.entries(a.motivos || {}).sort((x, y) => y[1] - x[1])[0];
    const min = Math.max(1, Math.round((a.ultima - a.primeira) / 60e3));
    return `📦 *${a.caixa_nome}*${a.projeto_nome ? ' · ' + a.projeto_nome : ''}${regiao ? ' — ' + regiao : ''}  _(${a.codigo})_\n`
      + `   ${a.caidos} de ${a.caidos} clientes online caíram às ${monHora(a.primeira)}`
      + `${a.ultima - a.primeira >= 60e3 ? ` (em ${min} min)` : ' (juntos)'}`
      + `${a.total_logins > a.caidos ? ` · ${a.total_logins} na caixa` : ''}`
      + `${motivo ? `\n   motivo: ${motivo[0]}` : ''}`;
  });
  const varias = novos.length > 1;
  return `🚨 *Monitor de CTO — MoviFiber*\n\n`
    + `${varias ? `${novos.length} caixas ficaram` : 'Uma caixa ficou'} totalmente off-line:\n\n`
    + linhas.join('\n\n')
    + `\n\nResponda:\n*1* — ativar o aviso de região off-line para ${varias ? 'essas caixas' : 'esses clientes'}\n*2* — ignorar`
    + (varias ? `\n(para só uma: *1 ${novos[0].codigo}*)` : '')
    + `\n\nPrevisão que vai no aviso: ${cfg.previsao_horas ? cfg.previsao_horas + 'h' : 'sem previsão'} (para mudar: *1 2h*)`;
}

/* O ciclo. `simular` so devolve a situacao das caixas, sem gravar nem avisar. */
async function monitorCto({ simular = false } = {}) {
  const cfg = await monitorConfig();
  if (!cfg) throw new Error('rode a migration do monitor de CTO (tabela monitor_cto_config)');
  if (!simular && !cfg.ativo) return { ok: true, desligado: true };

  const agora = Date.now();
  if (!simular) {
    // trava contra duas passadas ao mesmo tempo (cron atrasado + manual)
    const limite = new Date(agora - 90e3).toISOString();
    const pego = await monSb(`${SB_MON_CFG}?id=eq.1&or=(ultima_execucao.is.null,ultima_execucao.lt.${limite})`, {
      method: 'PATCH', body: { ultima_execucao: new Date(agora).toISOString() }
    });
    if (!pego || !pego.length) return { ok: true, pulado: 'outra verificacao em andamento' };
  }

  const res = { ok: true, em: new Date(agora).toISOString(), novos: [], normalizados: [], erros: [] };
  let dados;
  try { dados = await monColetar(); }
  catch (err) {
    res.ok = false; res.erros.push('IXC: ' + err.message);
    if (!simular) await monSb(`${SB_MON_CFG}?id=eq.1`, { method: 'PATCH', prefer: 'return=minimal', body: { ultimo_resultado: res } }).catch(() => {});
    return res;
  }

  const situacao = [];
  const caidas = [];
  for (const g of dados.grupos) {
    const av = monAvaliarCaixa(g, cfg, agora);
    situacao.push({ chave: g.chave, nome: g.nome, projeto: g.projeto, total: av.total, online: av.online, recentes: av.recentes, monitorada: av.monitorada, caiu: av.caiu, gradual: !!av.gradual });
    if (av.caiu) caidas.push({ g, av });
  }
  situacao.sort((a, b) => (b.caiu - a.caiu) || ((a.online / (a.total || 1)) - (b.online / (b.total || 1))) || (b.total - a.total));
  res.cobertura = { ...dados.cobertura, caixas: dados.grupos.length, monitoradas: situacao.filter(s => s.monitorada).length };
  res.caidas = caidas.map(c => c.g.nome);
  if (simular) return { ...res, situacao };

  // ---- alertas que ja existem: nao repetir, e conferir quem voltou ----
  const desde = new Date(agora - 24 * 3600e3).toISOString();
  const abertos = await monSb(`${SB_MON_ALE}?select=*&or=(status.in.(pendente,ativado),detectado_em.gte.${desde})&order=detectado_em.desc&limit=300`).catch(() => []) || [];

  // instabilidades ativas (manuais ou do monitor): se a caixa ja esta dentro de uma, nao alerta
  const incAtivos = await monSb(`${SB_INC}?status=eq.ativo&select=id,clientes_ixc,origem,protocolo`).catch(() => []) || [];

  const novos = [];
  for (const { g, av } of caidas) {
    const mesmaQueda = abertos.find(a => a.caixa_chave === g.chave
      && (['pendente', 'ativado'].includes(a.status) || new Date(a.detectado_em).getTime() >= av.primeira - 60e3));
    if (mesmaQueda) continue;
    const ixcs = g.logins.map(l => l.cli_ixc).filter(Boolean);
    const jaMarcada = incAtivos.some(i => {
      const lista = new Set((i.clientes_ixc || []).map(String));
      const dentro = ixcs.filter(x => lista.has(String(x))).length;
      return ixcs.length && dentro / ixcs.length >= 0.5;
    });
    if (jaMarcada) continue;
    const caidosIds = new Set(g.logins.filter(l => !l.online && l.fim && l.fim >= av.primeira).map(l => l.login_id));
    novos.push({
      caixa_chave: g.chave, caixa_nome: g.nome, projeto_nome: g.projeto,
      total_logins: av.total, caidos: av.recentes,
      clientes: g.logins.map(l => ({ login_id: l.login_id, cli_ixc: l.cli_ixc, id: l.cliente_id, nome: l.nome, bairro: l.bairro, caiu: caidosIds.has(l.login_id) })),
      bairros: monBairros(g.logins), motivos: av.motivos,
      primeira_queda: new Date(av.primeira).toISOString(), ultima_queda: new Date(av.ultima).toISOString(),
      primeira: av.primeira, ultima: av.ultima,
    });
  }

  if (novos.length) {
    const lote = 'L' + agora.toString(36).toUpperCase();
    const gravados = await monSb(SB_MON_ALE, {
      method: 'POST',
      body: novos.map(n => ({
        codigo: 'C?', lote, caixa_chave: n.caixa_chave, caixa_nome: n.caixa_nome, projeto_nome: n.projeto_nome,
        total_logins: n.total_logins, caidos: n.caidos, clientes: n.clientes, bairros: n.bairros, motivos: n.motivos,
        primeira_queda: n.primeira_queda, ultima_queda: n.ultima_queda, status: 'pendente'
      }))
    });
    // codigo curto e legivel para responder ("1 C17")
    for (let i = 0; i < (gravados || []).length; i++) {
      const codigo = 'C' + gravados[i].id;
      novos[i].id = gravados[i].id; novos[i].codigo = codigo;
      await monSb(`${SB_MON_ALE}?id=eq.${gravados[i].id}`, { method: 'PATCH', prefer: 'return=minimal', body: { codigo } }).catch(() => {});
    }
    const envio = await monAvisarDonos(cfg, monTextoAlerta(novos, cfg));
    const patch = envio.para.length
      ? { wa_msg_ids: envio.ids, enviado_para: envio.para, erro_envio: envio.erros.join(' | ') || null }
      : { status: 'falhou', erro_envio: envio.semNumero ? 'nenhum numero de WhatsApp configurado' : envio.erros.join(' | ') };
    const ids = novos.map(n => n.id).filter(Boolean);
    if (ids.length) await monSb(`${SB_MON_ALE}?id=in.(${ids.join(',')})`, { method: 'PATCH', prefer: 'return=minimal', body: patch }).catch(err => res.erros.push(err.message));
    if (envio.erros.length) res.erros.push(...envio.erros);
    res.novos = novos.map(n => ({ id: n.id, codigo: n.codigo, caixa: n.caixa_nome, caidos: n.caidos }));
  }

  // ---- volta: pendente que voltou sozinha, ou aviso ativo que pode encerrar ----
  const estadoLogin = id => dados.logins.get(String(id));
  for (const a of abertos.filter(x => ['pendente', 'ativado'].includes(x.status))) {
    const afetados = (a.clientes || []).filter(c => c.caiu);
    const base = afetados.length ? afetados : (a.clientes || []);
    const voltaram = base.filter(c => estadoLogin(c.login_id)?.online).length;
    const pct = base.length ? voltaram / base.length * 100 : 0;
    const voltou = base.length > 0 && pct >= cfg.retorno_pct;

    if (a.status === 'pendente') {
      if (voltou) {
        await monSb(`${SB_MON_ALE}?id=eq.${a.id}&status=eq.pendente`, { method: 'PATCH', prefer: 'return=minimal',
          body: { status: 'normalizado', normalizado_em: new Date(agora).toISOString(), voltaram } }).catch(() => {});
        res.normalizados.push(a.codigo);
        await monAvisarDonos(cfg, `✅ *${a.caixa_nome}* voltou sozinha (${voltaram} de ${base.length} online). `
          + `O alerta ${a.codigo} foi cancelado — não precisa responder.`).catch(() => {});
      } else if (agora - new Date(a.detectado_em).getTime() > MON_PENDENTE_H * 3600e3) {
        await monSb(`${SB_MON_ALE}?id=eq.${a.id}&status=eq.pendente`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'expirado' } }).catch(() => {});
      }
      continue;
    }

    // ativado
    const inc = a.incidente_id ? (await monSb(`${SB_INC}?id=eq.${a.incidente_id}&select=id,status,protocolo`).catch(() => []) || [])[0] : null;
    if (!inc || inc.status !== 'ativo') {
      // encerrado a mao no MoviFiber: so fecha o alerta
      await monSb(`${SB_MON_ALE}?id=eq.${a.id}`, { method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'normalizado', normalizado_em: new Date(agora).toISOString(), voltaram } }).catch(() => {});
      continue;
    }
    if (voltou && cfg.auto_normalizar) {
      const quando = new Date(agora).toISOString();
      await monSb(`${SB_INC}?id=eq.${inc.id}&status=eq.ativo`, { method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'resolvido', resolvido_em: quando, resolvido_por: 'Monitor de CTO', atualizado_em: quando } }).catch(err => res.erros.push(err.message));
      await monSb(`${SB_MON_ALE}?id=eq.${a.id}`, { method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'normalizado', normalizado_em: quando, voltaram } }).catch(() => {});
      res.normalizados.push(a.codigo);
      await monAvisarDonos(cfg, `✅ *${a.caixa_nome}* normalizou: ${voltaram} de ${base.length} clientes online de novo.\n`
        + `Encerrei o aviso ${inc.protocolo || ''} — quem escrever agora segue o atendimento normal.`).catch(() => {});
    }
  }

  res.situacao_resumo = situacao.slice(0, 40);
  await monSb(`${SB_MON_CFG}?id=eq.1`, { method: 'PATCH', prefer: 'return=minimal', body: { ultimo_resultado: res } }).catch(() => {});
  return res;
}

async function monitorStatus() {
  const cfg = await monitorConfig();
  if (!cfg) throw new Error('rode a migration do monitor de CTO (tabela monitor_cto_config)');
  const { token, ...semToken } = cfg;
  const alertas = await monSb(`${SB_MON_ALE}?select=id,codigo,lote,caixa_chave,caixa_nome,projeto_nome,total_logins,caidos,bairros,motivos,primeira_queda,detectado_em,status,respondido_em,respondido_por,incidente_id,normalizado_em,voltaram,erro_envio&order=detectado_em.desc&limit=40`).catch(() => []);
  return { ok: true, config: semToken, alertas: alertas || [], whatsapp_ok: !!(process.env.EVOLUTION_URL && process.env.EVOLUTION_APIKEY && process.env.EVOLUTION_INSTANCE) };
}

async function monitorSalvar(c, usuario) {
  const inteiro = (v, min, max, pad) => { const n = parseInt(v, 10); return isFinite(n) ? Math.min(max, Math.max(min, n)) : pad; };
  const fones = [...new Set((Array.isArray(c.fones) ? c.fones : String(c.fones || '').split(/[\n,;]+/))
    .map(monFone).filter(f => f.length >= 12 && f.length <= 13))].slice(0, 5);
  if (c.ativo === true && !fones.length) throw new Error('informe pelo menos um WhatsApp para receber os alertas');
  const body = {
    ativo: c.ativo === true,
    fones,
    min_clientes: inteiro(c.min_clientes, 2, 50, 3),
    janela_min: inteiro(c.janela_min, 2, 60, 10),
    recentes_min: inteiro(c.recentes_min, 5, 180, 30),
    previsao_horas: inteiro(c.previsao_horas, 0, 72, 4),
    gatilho: c.gatilho === 'reclamacao' ? 'reclamacao' : 'qualquer',
    encerrar: c.encerrar !== false,
    auto_normalizar: c.auto_normalizar !== false,
    retorno_pct: inteiro(c.retorno_pct, 50, 100, 80),
    atualizado_em: new Date().toISOString(),
    atualizado_por: usuario ? (usuario.nome || usuario.email || null) : null
  };
  const r = await monSb(`${SB_MON_CFG}?id=eq.1`, { method: 'PATCH', body });
  const { token, ...semToken } = (r && r[0]) || body;
  return { ok: true, config: semToken };
}

async function monitorTestar(usuario) {
  const cfg = await monitorConfig();
  if (!cfg || !(cfg.fones || []).length) throw new Error('salve um WhatsApp antes de testar');
  const quem = usuario ? (usuario.nome || usuario.email || '') : '';
  const envio = await monAvisarDonos(cfg, `🧪 *Teste do Monitor de CTO — MoviFiber*\n\n`
    + `Se esta mensagem chegou, os alertas de CTO off-line vão chegar aqui.\n`
    + `Quando chegar um alerta de verdade, responda *1* para ativar o aviso aos clientes ou *2* para ignorar.\n\n`
    + `Para ver as caixas em alerta a qualquer hora, mande *status*.${quem ? `\n\n(teste enviado por ${quem})` : ''}`);
  if (!envio.para.length) throw new Error(envio.erros.join(' | ') || 'não consegui enviar');
  return { ok: true, enviado_para: envio.para, erros: envio.erros };
}
