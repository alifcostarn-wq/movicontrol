// ============================================================================
// SINCRONIZAÇÃO DO IXC — sem depender de ninguém abrir a aba de clientes
// ----------------------------------------------------------------------------
// Até aqui a cópia completa do IXC (cadastro, contratos e logins) só acontecia
// dentro do NAVEGADOR: `syncIXC()` no MoviOne, disparada quando alguém abria a
// aba Clientes. Três consequências disso, todas medidas em produção:
//
//   • Ninguém abriu a aba hoje → a base do MoviControl é a de ontem. Telefone
//     trocado, endereço corrigido, contrato cancelado: nada disso chega.
//   • Quem abriu a aba e fechou no meio levou a sincronização junto. A aba é
//     que estava rodando a cópia — fechada, ela para onde parou.
//   • Os outros módulos (MoviTalk, MoviApp, MoviFiber, campo) leem a mesma
//     cópia e herdam o atraso sem ter como saber que ele existe.
//
// Este endpoint faz o mesmo trabalho no SERVIDOR, com a chave de serviço, e é
// acionado por quem não depende de navegador: o cron da Vercel e o tráfego real
// que o sistema já recebe (webhook do WhatsApp, pulso do painel de atendimento).
// O navegador continua podendo pedir — só deixou de ser o único que pode.
//
// COMO ELA CABE EM 60 SEGUNDOS
// A função tem teto de tempo na plataforma e a base não cabe nele. Então a
// rodada é dividida em FASES com cursor de página, cada invocação gasta um
// ORÇAMENTO e, se ainda faltar, chama a si mesma para continuar de onde parou —
// o mesmo encadeamento que o agendador da régua de cobrança já usa.
//
// COMO DUAS RODADAS NÃO SE ATROPELAM
// A trava é uma linha do `app_config` reivindicada com um PATCH filtrado: quem
// conseguir mudar a linha leva a rodada, os outros seguem sem sincronizar. Os
// elos da mesma corrente provam que são donos apresentando o `run` sorteado no
// início — que só existe em memória e no banco.
//
// O QUE ELA NUNCA FAZ
//   • Não apaga nada. Contrato que sumiu do IXC continua aqui; quem decide
//     excluir cadastro é gente, não uma cópia.
//   • Não reescreve a data de cadastro, a coordenada capturada em campo, nem
//     SSID/senha do Wi-Fi/observação editados à mão. Ver `lib/ixc-mapa.mjs`.
// ============================================================================

import {
  emLotes, linhaClienteDoIxc, coordDoIxc, linhaContratoDoIxc,
  linhaLoginDoIxc, extrairWifi, agregarStatusCliente,
} from '../lib/ixc-mapa.mjs';

export const config = { maxDuration: 60 };

// Sai bem antes do corte da plataforma: parar por conta própria deixa o cursor
// gravado e a corrente continua; ser morto no meio perde a passada inteira.
//
// O orçamento é conferido ANTES de cada passo, nunca no meio dele. Então o pior
// caso real é "um passo começou no último instante do orçamento": 35s de
// orçamento + 20s de teto para o IXC responder + as gravações ainda cabem nos
// 60s da função. Aumentar um sem baixar o outro é o que faria a invocação
// morrer no meio de uma página — justamente o que o cursor existe para evitar.
const ORCAMENTO_MS = Number(process.env.IXC_SYNC_ORCAMENTO_MS || 35000);
const IXC_PRAZO_MS = Number(process.env.IXC_SYNC_PRAZO_MS || 20000);

// Com que frequência vale repetir a cópia completa. Também é o tempo que uma
// rodada travada segura a trava antes de outra poder assumir — por isso cada
// elo renova o carimbo: corrente viva nunca é confundida com corrente morta.
//
// Uma hora é o padrão porque a passada inteira custa ~2 minutos de função e o
// plano tem teto de tempo de execução no mês: de meia em meia hora dobraria
// essa conta sem dobrar a utilidade. O que é urgente — cliente ativado agora —
// já chega em minutos pela cópia incremental do MoviTalk; o que esta aqui
// resolve é MUDANÇA em cadastro que já existe, e isso não muda de minuto em
// minuto. Para acelerar, IXC_SYNC_CADA_MIN na Vercel.
const JANELA_MS = Number(process.env.IXC_SYNC_CADA_MIN || 60) * 60 * 1000;

const RP = Number(process.env.IXC_SYNC_RP || 500);   // registros por página no IXC
const MAX_ELOS = Number(process.env.IXC_SYNC_MAX_ELOS || 30);

// Trava de segurança, não de capacidade: 200 páginas de 500 são 100 mil linhas,
// muito além da base. Existe para o caso de uma versão do IXC ignorar o
// parâmetro de página e devolver a primeira para sempre — aí a fase termina em
// vez de a corrente girar em falso até o teto de elos.
const MAX_PAGINAS = Number(process.env.IXC_SYNC_MAX_PAGINAS || 200);

// A senha do Wi-Fi mora numa segunda fonte, consultada UM login por vez. Varrer
// a base inteira nisso seria mil chamadas ao IXC por rodada. Cada rodada pega
// uma leva e guarda onde parou; em poucas rodadas cobre todo mundo.
const WIFI_MAX  = Number(process.env.IXC_SYNC_WIFI_MAX || 200);
const WIFI_POOL = 6;

const CHAVE_TRAVA  = 'ixc_sync_lock';
const CHAVE_ESTADO = 'ixc_sync_estado';
const CHAVE_ULTIMO = 'ixc_sync_ultimo';

const FASES = ['clientes', 'contratos', 'logins', 'wifi', 'traduzir', 'status', 'fim'];

// ============================================================================
// AMBIENTE E CLIENTES HTTP
// ============================================================================
function limparUrl(u) {
  return String(u || '').trim().replace(/\/$/, '').replace(/\/adm\.php$/, '');
}

function env() {
  return {
    SUPA_URL: process.env.SUPABASE_URL || 'https://mgtetsmcswdtvsgewcen.supabase.co',
    SRV:      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    IXC_URL:  limparUrl(process.env.IXC_URL || ''),
    IXC_USER: process.env.IXC_USER || '',
    IXC_TOKEN: process.env.IXC_TOKEN || '',
    CRON_SECRET: process.env.CRON_SECRET || '',
    WH_SECRET: process.env.ATEND_WEBHOOK_SECRET || '',
  };
}

async function sb(e, path, opts = {}) {
  const r = await fetch(`${e.SUPA_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: e.SRV,
      Authorization: `Bearer ${e.SRV}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function fetchComPrazo(url, opts = {}, ms = IXC_PRAZO_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`IXC não respondeu em ${Math.round(ms / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// Auth: Basic base64(IXC_USER:IXC_TOKEN) — o token sozinho NÃO funciona.
async function ixc(e, endpoint, params = {}, metodo = 'listar') {
  if (!e.IXC_URL || !e.IXC_USER || !e.IXC_TOKEN) throw new Error('IXC não configurado (URL / usuário / token).');
  const auth = Buffer.from(`${e.IXC_USER}:${e.IXC_TOKEN}`).toString('base64');
  const r = await fetchComPrazo(`${e.IXC_URL}/webservice/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}`, ixcsoft: metodo },
    body: JSON.stringify(params),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`IXC ${r.status} em ${endpoint}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { throw new Error(`IXC devolveu algo que não é JSON em ${endpoint}: ${txt.slice(0, 120)}`); }
}

/* Uma página da listagem. É o mesmo corpo que o proxy do navegador monta e que
   está em produção há meses: sem qtype, ordenado por id, página a página. */
async function ixcPagina(e, endpoint, pagina) {
  const r = await ixc(e, endpoint, {
    qtype: '', query: '', oper: '=',
    page: String(pagina), rp: String(RP),
    sortname: 'id', sortorder: 'asc',
  });
  const regs = r?.registros;
  return Array.isArray(regs) ? regs : (regs && typeof regs === 'object' ? Object.values(regs) : []);
}

// ============================================================================
// CONFIGURAÇÃO E TRAVA (app_config)
// ----------------------------------------------------------------------------
// Não existe tabela nova para isto de propósito: `app_config` já é o lugar onde
// a integração com o IXC guarda as credenciais, e a trava é só um carimbo de
// tempo. Carimbo em texto ISO compara certo em ordem alfabética, que é o que
// permite reivindicar a rodada com um PATCH filtrado — atômico, sem transação.
// ============================================================================
async function cfgLer(e, chaves) {
  const linhas = await sb(e, `app_config?chave=in.(${chaves.join(',')})&select=chave,valor`);
  return Object.fromEntries((linhas || []).map(r => [r.chave, r.valor || '']));
}

async function cfgGravar(e, chave, valor) {
  await sb(e, 'app_config?on_conflict=chave', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [{ chave, valor: valor == null ? null : String(valor), updated_at: new Date().toISOString() }],
  });
}

async function cfgJson(e, chave) {
  const m = await cfgLer(e, [chave]);
  if (!m[chave]) return null;
  try { return JSON.parse(m[chave]); } catch { return null; }
}

/* As credenciais podem estar na Vercel (variáveis de ambiente) ou no
   `app_config`, que é onde o modal de configuração do MoviOne grava. Quem
   configurou pela tela nunca mexeu em variável de ambiente — e a sincronização
   automática não pode exigir isso dele para funcionar. */
async function completarCredenciaisIxc(e) {
  if (e.IXC_URL && e.IXC_USER && e.IXC_TOKEN) return;
  try {
    const m = await cfgLer(e, ['ixc_url', 'ixc_user', 'ixc_token']);
    e.IXC_URL   = limparUrl(e.IXC_URL || m.ixc_url || 'https://netmaisconnect.com.br');
    e.IXC_USER  = e.IXC_USER || m.ixc_user || '';
    e.IXC_TOKEN = e.IXC_TOKEN || m.ixc_token || '';
  } catch (err) {
    console.error('[ixc-sync] credenciais do app_config:', err.message);
  }
}

async function criarLinhaSeFaltar(e, chave) {
  await sb(e, 'app_config?on_conflict=chave', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: [{ chave, valor: null }],
  });
}

/* Reivindica a rodada. Devolve false quando outra passada é recente demais ou
   ainda está andando — e aí esta invocação simplesmente não faz nada, que é o
   comportamento certo para um gatilho que pode disparar a cada mensagem. */
async function reivindicar(e, janelaMs) {
  await criarLinhaSeFaltar(e, CHAVE_TRAVA);
  const corte = new Date(Date.now() - janelaMs).toISOString();
  const r = await sb(e, `app_config?chave=eq.${CHAVE_TRAVA}&or=(valor.is.null,valor.lt.${corte})`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: { valor: new Date().toISOString(), updated_at: new Date().toISOString() },
  });
  return Array.isArray(r) && r.length > 0;
}

async function renovarTrava(e) {
  await cfgGravar(e, CHAVE_TRAVA, new Date().toISOString());
}

function novoEstado(ultimo) {
  return {
    run: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    inicio_em: new Date().toISOString(),
    fase: FASES[0],
    pagina: 1,
    // continua a varredura de Wi-Fi de onde a rodada anterior parou
    wifi_off: Number(ultimo?.wifi_off || 0),
    elos: 0,
    stats: { clientes: 0, contratos: 0, logins: 0, wifi: 0, status: 0, cidades_corrigidas: 0, ufs_corrigidas: 0 },
  };
}

// ============================================================================
// APOIO: DE ID DO IXC PARA ID LOCAL
// ============================================================================
async function mapaPorIxcId(e, tabela, ids, select) {
  const mapa = new Map();
  for (const lote of emLotes([...new Set(ids.filter(Boolean))], 100)) {
    if (!lote.length) continue;
    const achados = await sb(e,
      `${tabela}?ixc_id=in.(${lote.map(encodeURIComponent).join(',')})&select=${select}`);
    for (const r of (achados || [])) mapa.set(String(r.ixc_id), r);
  }
  return mapa;
}

async function upsertEmLotes(e, tabela, linhas) {
  for (const lote of emLotes(linhas, 200)) {
    await sb(e, `${tabela}?on_conflict=ixc_id`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: lote,
    });
  }
}

/* Lê uma tabela inteira em páginas. O PostgREST tem teto por resposta; pedir
   "tudo" sem paginar devolve só o primeiro pedaço, em silêncio. */
async function lerTudo(e, tabela, select, filtro) {
  const passo = 1000, saida = [];
  for (let off = 0; off < 200000; off += passo) {
    const p = await sb(e, `${tabela}?select=${select}${filtro ? '&' + filtro : ''}&order=id.asc&limit=${passo}&offset=${off}`);
    saida.push(...(p || []));
    if (!p || p.length < passo) break;
  }
  return saida;
}

// ============================================================================
// AS FASES
// Cada uma devolve true quando terminou o seu trabalho.
// ============================================================================
async function passoClientes(e, estado) {
  const regs = await ixcPagina(e, 'cliente', estado.pagina);
  if (regs.length) {
    const linhas = regs.map(linhaClienteDoIxc).filter(l => l.ixc_id);
    await upsertEmLotes(e, 'clientes', linhas);
    estado.stats.clientes += linhas.length;

    // A coordenada entra por RPC porque ela só PREENCHE o que está vazio: a
    // posição que o técnico marcou na porta do cliente vale mais que a do
    // cadastro e não pode ser sobrescrita por uma cópia.
    const coords = regs.map(coordDoIxc).filter(Boolean);
    if (coords.length) {
      try { await sb(e, 'rpc/atualizar_coords_ixc_lote', { method: 'POST', prefer: 'return=minimal', body: { p_dados: coords } }); }
      catch (err) { console.error('[ixc-sync] coordenadas:', err.message); }
    }
  }
  estado.pagina++;
  return regs.length < RP || estado.pagina > MAX_PAGINAS;
}

async function passoContratos(e, estado) {
  const regs = await ixcPagina(e, 'cliente_contrato', estado.pagina);
  if (regs.length) {
    const mapa = await mapaPorIxcId(e, 'clientes', regs.map(r => String(r.id_cliente || '')), 'id,ixc_id');
    const linhas = regs
      .map(r => linhaContratoDoIxc(r, mapa.get(String(r.id_cliente || ''))?.id))
      .filter(l => l.ixc_id);
    await upsertEmLotes(e, 'clientes_contratos', linhas);
    estado.stats.contratos += linhas.length;
  }
  estado.pagina++;
  return regs.length < RP || estado.pagina > MAX_PAGINAS;
}

async function passoLogins(e, estado) {
  const regs = await ixcPagina(e, 'radusuarios', estado.pagina);
  if (regs.length) {
    const [mapaCli, mapaCtr, existentes] = await Promise.all([
      mapaPorIxcId(e, 'clientes', regs.map(r => String(r.id_cliente || '')), 'id,ixc_id'),
      mapaPorIxcId(e, 'clientes_contratos', regs.map(r => String(r.id_contrato || '')), 'id,ixc_id,plano,velocidade_mbps'),
      mapaPorIxcId(e, 'clientes_logins', regs.map(r => String(r.id || '')), 'ixc_id,ssid,senha_wifi,obs'),
    ]);
    const linhas = regs.map(r => {
      const ctr = mapaCtr.get(String(r.id_contrato || '')) || null;
      return linhaLoginDoIxc(r, {
        clienteIdLocal:  mapaCli.get(String(r.id_cliente || ''))?.id,
        contratoIdLocal: ctr?.id,
        contrato: ctr,
        existente: existentes.get(String(r.id || '')) || null,
      });
    }).filter(l => l.ixc_id);
    await upsertEmLotes(e, 'clientes_logins', linhas);
    estado.stats.logins += linhas.length;
  }
  estado.pagina++;
  return regs.length < RP || estado.pagina > MAX_PAGINAS;
}

/* A senha do Wi-Fi normalmente NÃO vem no `radusuarios`: mora na configuração
   da ONU, que se consulta um login por vez. Uma leva por rodada, com o ponto
   de parada guardado — em poucas rodadas a base inteira fica coberta, e
   nenhuma rodada estoura o orçamento por causa disso. */
async function passoWifi(e, estado, prazo) {
  if (WIFI_MAX <= 0) return true;
  const pend = await sb(e,
    `clientes_logins?senha_wifi=is.null&ativo=is.true&select=id,ixc_id,ssid&order=id.asc&limit=${WIFI_MAX}&offset=${estado.wifi_off}`);
  if (!pend || !pend.length) { estado.wifi_off = 0; return true; }

  let i = 0, achados = 0;
  const trabalhador = async () => {
    while (i < pend.length && Date.now() < prazo) {
      const l = pend[i++];
      try {
        const r = await ixc(e, 'radpop_radio_cliente_fibra', {
          qtype: 'radpop_radio_cliente_fibra.id_login', query: String(l.ixc_id), oper: '=', rp: '5',
        });
        let ssid = '', senha = '';
        for (const reg of (r?.registros || [])) {
          const w = extrairWifi(reg, 'radio');
          if (w.ssid && !ssid) ssid = w.ssid;
          if (w.senha && !senha) senha = w.senha;
        }
        const patch = {};
        if (senha) patch.senha_wifi = senha;
        if (ssid && !l.ssid) patch.ssid = ssid;   // nunca troca um SSID já gravado
        if (Object.keys(patch).length) {
          await sb(e, `clientes_logins?id=eq.${l.id}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
          achados++;
        }
      } catch (err) {
        // o endpoint da ONU não existe em toda versão do IXC — seguir é o certo
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WIFI_POOL, pend.length) }, trabalhador));
  estado.stats.wifi += achados;

  if (i >= pend.length) {
    // página curta = chegou ao fim da fila; volta ao começo na próxima rodada
    estado.wifi_off = pend.length < WIFI_MAX ? 0 : estado.wifi_off + pend.length;
    return true;
  }
  estado.wifi_off += i;   // orçamento acabou no meio: o próximo elo continua daqui
  return false;
}

/* Cidade e UF chegam do IXC como número ("1161", "25"). As tabelas de tradução
   já existem e são mantidas pela sincronização do MoviTalk; aqui só se aplica a
   tradução ao que acabou de entrar. Sem isto, cadastro novo fica com o id no
   lugar do nome — e vai assim para dentro de um contrato assinado. */
async function passoTraduzir(e, estado) {
  try { estado.stats.cidades_corrigidas = Number(await sb(e, 'rpc/corrigir_cidades_ixc', { method: 'POST', body: {} })) || 0; }
  catch (err) { console.error('[ixc-sync] cidades:', err.message); }
  try { estado.stats.ufs_corrigidas = Number(await sb(e, 'rpc/corrigir_ufs_ixc', { method: 'POST', body: {} })) || 0; }
  catch (err) { console.error('[ixc-sync] ufs:', err.message); }
  return true;
}

/* O status que a lista de clientes mostra não vem do cadastro: sai dos
   contratos. Cliente com um ativo e dois cancelados é cliente ATIVO — e era
   isso que ficava errado enquanto a cópia não rodava. */
async function passoStatus(e, estado) {
  const contratos = await lerTudo(e, 'clientes_contratos', 'ixc_cliente_id,status_contrato,status_acesso');
  const porCliente = new Map();
  for (const c of contratos) {
    const k = String(c.ixc_cliente_id || '');
    if (!k) continue;
    if (!porCliente.has(k)) porCliente.set(k, []);
    porCliente.get(k).push(c);
  }

  const clientes = await lerTudo(e, 'clientes', 'ixc_id,status_contrato', 'origem=eq.ixc&ixc_id=not.is.null');
  const porNovoStatus = new Map();   // status -> [ixc_id, ...]
  for (const cli of clientes) {
    const novo = agregarStatusCliente(porCliente.get(String(cli.ixc_id)) || []);
    if (novo === (cli.status_contrato || null)) continue;
    const chave = novo == null ? '' : novo;
    if (!porNovoStatus.has(chave)) porNovoStatus.set(chave, []);
    porNovoStatus.get(chave).push(String(cli.ixc_id));
  }

  // Agrupado por valor: são ~8 status possíveis, então oito PATCHes em vez de
  // um por cliente. Mil PATCHes não caberiam no orçamento de uma invocação.
  let mudados = 0;
  for (const [status, ids] of porNovoStatus) {
    for (const lote of emLotes(ids, 200)) {
      await sb(e, `clientes?ixc_id=in.(${lote.map(encodeURIComponent).join(',')})`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status_contrato: status === '' ? null : status },
      });
      mudados += lote.length;
    }
  }
  estado.stats.status = mudados;
  return true;
}

/* Roda fases até terminar ou até o orçamento acabar. Devolve true se chegou ao
   fim. O `while` reavalia o relógio a cada passo: uma página do IXC leva
   segundos, então a checagem antes de cada passo é granularidade suficiente. */
async function rodar(e, estado, prazo) {
  while (Date.now() < prazo) {
    let pronto = false;
    switch (estado.fase) {
      case 'clientes':  pronto = await passoClientes(e, estado); break;
      case 'contratos': pronto = await passoContratos(e, estado); break;
      case 'logins':    pronto = await passoLogins(e, estado); break;
      case 'wifi':      pronto = await passoWifi(e, estado, prazo); break;
      case 'traduzir':  pronto = await passoTraduzir(e, estado); break;
      case 'status':    pronto = await passoStatus(e, estado); break;
      case 'fim':       return true;
      default:          estado.fase = 'fim'; return true;
    }
    if (pronto) {
      estado.fase = FASES[FASES.indexOf(estado.fase) + 1] || 'fim';
      estado.pagina = 1;
      if (estado.fase === 'fim') return true;
    }
  }
  return false;
}

// ============================================================================
// QUEM PODE DISPARAR
// ----------------------------------------------------------------------------
// Quatro crachás, nesta ordem:
//   1. o cron da Vercel (ele se identifica) ou o Bearer do CRON_SECRET;
//   2. o segredo interno que o resto do sistema já usa entre endpoints;
//   3. o `run` sorteado no início da rodada — é como um elo da corrente prova
//      que é continuação dela e não um pedido de fora. Vale mesmo sem nenhum
//      segredo configurado, porque o valor só existe em memória e no banco;
//   4. um usuário logado do MoviOne (a mesma sessão do Supabase do painel).
// ============================================================================
function ehDaPlataforma(req, e) {
  const auth = String(req.headers.authorization || '');
  if (e.CRON_SECRET && auth === `Bearer ${e.CRON_SECRET}`) return true;
  if (e.WH_SECRET && req.headers['x-atend-secret'] === e.WH_SECRET) return true;
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  return ua.includes('vercel-cron') || !!req.headers['x-vercel-cron-schedule'];
}

async function usuarioDoPainel(e, req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const r = await fetch(`${e.SUPA_URL}/auth/v1/user`, {
      headers: { apikey: e.SRV, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const id = (await r.json()).id;
    if (!id) return null;
    const p = await sb(e, `perfis?id=eq.${id}&select=id,nome,perfil`);
    const perfil = Array.isArray(p) ? p[0] : null;
    // técnico não mexe no cadastro financeiro; o resto de quem loga no MoviOne sim
    if (!perfil || perfil.perfil === 'tecnico') return null;
    return perfil;
  } catch { return null; }
}

function baseDoSite(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

/* Chama o próximo elo e NÃO espera a resposta: esperar aninharia a corrente
   inteira dentro desta invocação, que morreria no teto de 60 segundos — que é
   exatamente o problema que o encadeamento resolve. Se o elo não subir, a
   corrente para aqui, o cursor fica gravado e o próximo gatilho continua. */
async function chamarProximoElo(e, req, estado, elo) {
  const url = `${baseDoSite(req)}/api/ixc-sync?run=${encodeURIComponent(estado.run)}&elo=${elo + 1}`;
  const disparo = fetch(url, {
    method: 'GET',
    headers: {
      ...(e.CRON_SECRET ? { authorization: `Bearer ${e.CRON_SECRET}` } : {}),
      ...(e.WH_SECRET ? { 'x-atend-secret': e.WH_SECRET } : {}),
    },
  }).catch(() => null);
  // dá tempo de a requisição sair antes de a função congelar
  await Promise.race([disparo, new Promise(ok => setTimeout(ok, 1500))]);
}

// ============================================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-atend-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const e = env();
  if (!e.SRV) return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY não configurada na Vercel.' });

  const q = req.query || {};
  const corpo = (req.body && typeof req.body === 'object') ? req.body : {};
  const run = String(q.run || corpo.run || '');
  const elo = Math.max(0, Number(q.elo || corpo.elo || 0));
  const forcar = String(q.forcar || corpo.forcar || '') === '1';

  // --- crachá -------------------------------------------------------------
  let quem = null;
  if (ehDaPlataforma(req, e)) {
    quem = 'plataforma';
  } else if (run) {
    const atual = await cfgJson(e, CHAVE_ESTADO).catch(() => null);
    if (atual && atual.run === run) quem = 'elo';
  }
  if (!quem) {
    const u = await usuarioDoPainel(e, req);
    if (u) quem = `painel:${u.nome || u.id}`;
  }
  if (!quem) return res.status(401).json({ ok: false, error: 'Não autorizado.' });

  await completarCredenciaisIxc(e);
  if (!e.IXC_USER || !e.IXC_TOKEN) {
    return res.status(200).json({ ok: false, rodou: false, error: 'IXC não configurado (usuário/token).' });
  }

  // --- só consulta --------------------------------------------------------
  if (String(q.acao || corpo.acao || '') === 'status') {
    const [ultimo, trava, estado] = await Promise.all([
      cfgJson(e, CHAVE_ULTIMO), cfgLer(e, [CHAVE_TRAVA]), cfgJson(e, CHAVE_ESTADO),
    ]);
    return res.status(200).json({
      ok: true, ultimo,
      trava_em: trava[CHAVE_TRAVA] || null,
      em_andamento: !!(estado && estado.fase && estado.fase !== 'fim'),
      fase: estado?.fase || null,
    });
  }

  // --- reivindica a rodada (ou entra como elo de uma já em curso) ---------
  let estado;
  if (run) {
    estado = await cfgJson(e, CHAVE_ESTADO);
    if (!estado || estado.run !== run) {
      return res.status(200).json({ ok: true, rodou: false, motivo: 'outra rodada assumiu' });
    }
    // elo atrasado de uma corrente que já fechou: sem isto ele reescreveria o
    // registro da última passada com os mesmos números, de novo
    if (estado.fase === 'fim') {
      return res.status(200).json({ ok: true, rodou: false, motivo: 'rodada já terminou' });
    }
    await renovarTrava(e);
  } else {
    let levou = false;
    if (forcar) { await renovarTrava(e); levou = true; }
    else { levou = await reivindicar(e, JANELA_MS); }
    if (!levou) {
      return res.status(200).json({
        ok: true, rodou: false, motivo: 'sincronizada há pouco ou em andamento',
        ultimo: await cfgJson(e, CHAVE_ULTIMO),
      });
    }
    estado = novoEstado(await cfgJson(e, CHAVE_ULTIMO));
    await cfgGravar(e, CHAVE_ESTADO, JSON.stringify(estado));
  }

  // --- trabalha -----------------------------------------------------------
  const prazo = Date.now() + ORCAMENTO_MS;
  let terminou = false, erro = null;
  try { terminou = await rodar(e, estado, prazo); }
  catch (err) { erro = String(err.message || err).slice(0, 300); console.error('[ixc-sync]', erro); }

  estado.elos = elo;
  await cfgGravar(e, CHAVE_ESTADO, JSON.stringify(estado)).catch(() => {});

  // --- continua ou fecha --------------------------------------------------
  const podeContinuar = !terminou && !erro && elo + 1 < MAX_ELOS;
  if (podeContinuar) {
    await chamarProximoElo(e, req, estado, elo);
    return res.status(200).json({
      ok: true, rodou: true, quem, elo, proximo_elo: elo + 1,
      fase: estado.fase, parciais: estado.stats,
    });
  }

  const ultimo = {
    em: new Date().toISOString(),
    inicio_em: estado.inicio_em,
    duracao_ms: Date.now() - new Date(estado.inicio_em).getTime(),
    elos: elo + 1,
    completa: terminou,
    fase_parada: terminou ? null : estado.fase,
    wifi_off: estado.wifi_off,
    disparada_por: quem,
    ...estado.stats,
    erro,
  };
  await cfgGravar(e, CHAVE_ULTIMO, JSON.stringify(ultimo)).catch(() => {});
  // deixa o estado fechado para que um elo atrasado não retome uma rodada morta
  await cfgGravar(e, CHAVE_ESTADO, JSON.stringify({ ...estado, fase: 'fim' })).catch(() => {});

  return res.status(200).json({ ok: !erro, rodou: true, quem, elo, proximo_elo: false, ultimo });
}
