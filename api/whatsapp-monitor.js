// ============================================================================
// MONITOR DA CONEXÃO DO WHATSAPP (Evolution API)  — POST /api/whatsapp-monitor
// ----------------------------------------------------------------------------
// O MoviTalk só descobria que o WhatsApp tinha caído quando alguém tentava
// enviar. Este monitor, chamado pelo agendador do banco a cada 2 minutos
// (cron "whatsapp-monitor", com o token de atend_whatsapp_monitor):
//   · pergunta à Evolution o estado da conexão e mede quanto ela demora;
//   · a cada mudança de estado grava em atend_whatsapp_conexao quando foi,
//     quanto durou o estado anterior e o MOTIVO da queda que a Evolution guarda
//     (disconnectionReasonCode) — "servidor fora do ar" (indisponivel) e
//     "sessão derrubada" (close) ficam separados;
//   · se continuar desconectado, pede à Evolution para reconectar com a sessão
//     guardada (o mesmo "conectar" da tela, sem desconectar nem pedir QR), no
//     máximo a cada 10 minutos e nunca quando o WhatsApp encerrou a sessão;
//   · se a sessão está "conectada" mas travada (envia e nada é entregue, nada
//     chega), reinicia a instância na Evolution — o que antes era feito à mão,
//     desconectando e lendo o QR Code;
//   · guarda um diagnóstico (versão da Evolution, último motivo de queda) —
//     sem token, sem número e sem nome de ninguém.
// ============================================================================
import crypto from 'crypto';

export const config = { maxDuration: 30 };

const sbUrl = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const sbKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const evoUrl = () => (process.env.EVOLUTION_URL || '').replace(/\/$/, '');
const evoKey = () => process.env.EVOLUTION_APIKEY || '';
const evoInst = () => process.env.EVOLUTION_INSTANCE || '';

export const RECONECTAR_APOS_MS = 90e3;         // desconectado há mais de 1,5 min (2 checagens)
export const RECONECTAR_CADA_MS = 10 * 60e3;    // no máximo uma tentativa a cada 10 min
export const ALERTA_APOS_MS = 5 * 60e3;         // fora do ar há mais de 5 min: alerta na tela
const DIAGNOSTICO_CADA_MS = 30 * 60e3;
const LATENCIAS = 30;                           // tempos de resposta guardados (as últimas checagens)

// códigos de desconexão do WhatsApp (Baileys) que a Evolution guarda
export const MOTIVOS = {
  401: 'o WhatsApp encerrou a sessão (aparelho desconectado no celular ou sessão expirada): precisa ler o QR Code',
  403: 'o WhatsApp recusou o acesso (número restrito ou bloqueado)',
  408: 'conexão perdida por tempo esgotado (rede ou servidor lento)',
  411: 'versão do WhatsApp incompatível com a Evolution (atualizar a Evolution)',
  428: 'conexão fechada (queda de rede ou reinício do servidor)',
  440: 'a sessão foi aberta em outro lugar (outra instância ou servidor usando o mesmo número)',
  500: 'sessão corrompida: precisa ler o QR Code',
  503: 'serviço do WhatsApp indisponível',
  515: 'o WhatsApp pediu para reiniciar a conexão',
};
export const motivoDoCodigo = c => (c == null || c === '' ? null : MOTIVOS[Number(c)] || `código ${c}`);

async function sb(caminho, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${sbUrl()}/rest/v1/${caminho}`, {
    method,
    headers: { apikey: sbKey(), Authorization: `Bearer ${sbKey()}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${txt.slice(0, 200)}`);
  try { return txt ? JSON.parse(txt) : null; } catch { return null; }
}

async function evo(caminho, { ms = 10000, method = 'GET', body } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const ini = Date.now();
  try {
    const r = await fetch(`${evoUrl()}${caminho}`, { method, headers: { apikey: evoKey(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const json = await r.json().catch(() => null);
    return { status: r.status, json, ms: Date.now() - ini };
  } finally { clearTimeout(timer); }
}

// número, jid ou token que a Evolution cite no texto do erro: fora
const limpo = t => String(t || '').replace(/\S+@\S+/g, '(jid)').replace(/\d{8,}/g, '(número)').replace(/[A-Za-z0-9_-]{32,}/g, '(chave)').slice(0, 200);

/* Diagnóstico sem dado sensível: versão da Evolution e, da instância, só o
   estado, o último motivo de queda e as contagens. */
export function diagnosticoDe(raiz, instancia) {
  const i = Array.isArray(instancia) ? instancia[0] : instancia;
  const inst = (i && (i.instance || i)) || {};
  const obj = inst.disconnectionObject;
  let textoQueda = null;
  if (obj) {
    try {
      const o = typeof obj === 'string' ? JSON.parse(obj) : obj;
      textoQueda = limpo((o && (o.error && (o.error.output && o.error.output.payload && o.error.output.payload.message) || o.error && o.error.message) || o.message) || '');
    } catch { textoQueda = limpo(obj); }
  }
  const cont = inst._count || inst.count || null;
  return {
    versao: (raiz && (raiz.version || raiz.versao)) || null,
    versao_whatsapp_web: (raiz && raiz.whatsappWebVersion) || null,
    estado: inst.connectionStatus || inst.state || null,
    integracao: inst.integration || null,
    queda_codigo: inst.disconnectionReasonCode != null ? String(inst.disconnectionReasonCode) : null,
    queda_motivo: motivoDoCodigo(inst.disconnectionReasonCode),
    queda_em: inst.disconnectionAt || null,
    queda_texto: textoQueda || null,
    atualizado_na_evolution: inst.updatedAt || null,
    contagens: cont && typeof cont === 'object'
      ? { mensagens: cont.Message ?? cont.messages ?? null, contatos: cont.Contact ?? cont.contacts ?? null, conversas: cont.Chat ?? cont.chats ?? null }
      : null,
  };
}

/* SESSÃO TRAVADA: a Evolution diz "conectado", mas a sessão morreu por dentro —
   o que se envia volta como aceito e nunca é entregue, e nada chega (visto em
   10 e 11/11: começa depois de a própria Evolution passar por "conectando").
   O sinal é o tráfego: as últimas mensagens enviadas (3 ou mais, para 2 ou mais
   conversas, há mais de 4 minutos) sem nenhuma confirmação de entrega, e nada
   recebido nem confirmado desde a mais antiga delas. */
export const TRAVA_JANELA_MS = 40 * 60e3, TRAVA_ESPERA_MS = 4 * 60e3;
export const REINICIAR_CADA_MS = 15 * 60e3, REINICIOS_MAX = 2;
export function sessaoTravada({ saidas = [], ultimaEntrada = null, ultimoRecibo = null } = {}) {
  // da mais nova para a mais velha: a sequência final de "só enviadas"
  const fila = [...saidas].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const seq = [];
  for (const m of fila) { if (m.status === 'enviado') seq.push(m); else break; }
  if (seq.length < 3 || new Set(seq.map(m => String(m.conversa_id))).size < 2) return null;
  const desde = Math.min(...seq.map(m => Date.parse(m.created_at)));
  if (ultimaEntrada && Date.parse(ultimaEntrada) > desde) return null;
  if (ultimoRecibo && Date.parse(ultimoRecibo) > desde) return null;
  return { desde: new Date(desde).toISOString(), mensagens: seq.length };
}
async function lerTrafego(agora) {
  const de = new Date(agora - TRAVA_JANELA_MS).toISOString(), ate = new Date(agora - TRAVA_ESPERA_MS).toISOString();
  const [saidas, ent, rec] = await Promise.all([
    sb(`atend_mensagens?select=conversa_id,status,created_at&direcao=in.(out,bot)&wa_id=not.is.null&excluido_em=is.null&created_at=gte.${encodeURIComponent(de)}&created_at=lte.${encodeURIComponent(ate)}&order=id.desc&limit=30`),
    sb('atend_mensagens?select=created_at&direcao=eq.in&order=id.desc&limit=1'),
    sb(`atend_mensagens?select=status_em&status=in.(entregue,lido)&status_em=gte.${encodeURIComponent(de)}&order=status_em.desc&limit=1`),
  ]);
  return { saidas: saidas || [], ultimaEntrada: ent && ent[0] ? ent[0].created_at : null, ultimoRecibo: rec && rec[0] ? rec[0].status_em : null };
}
/* Reinicia a instância na Evolution: refaz a ligação com o WhatsApp usando a
   sessão guardada (sem QR e sem desconectar o aparelho). */
async function reiniciarInstancia(inst) {
  for (const method of ['POST', 'PUT']) {
    try {
      const r = await evo(`/instance/restart/${inst}`, { ms: 20000, method });
      if (r.status === 404 || r.status === 405) continue;
      return r.status < 400 ? 'pedido' : `recusado (${r.status})`;
    } catch { return 'sem resposta'; }
  }
  return 'não suportado por esta Evolution';
}

export async function verificar({ agora = new Date() } = {}) {
  const linha = ((await sb('atend_whatsapp_monitor?id=eq.1&select=estado,desde,reconexao_em,diagnostico,diagnostico_em,latencias,reinicio_em,reinicios,travada')) || [])[0] || {};
  const inst = encodeURIComponent(evoInst());
  let estado = 'desconhecido', ms = null;
  try {
    const r = await evo(`/instance/connectionState/${inst}`);
    ms = r.ms;
    estado = r.status === 404 ? 'nao_criada' : ((r.json && ((r.json.instance && r.json.instance.state) || r.json.state)) || (r.status >= 500 ? 'indisponivel' : 'desconhecido'));
  } catch {
    estado = 'indisponivel';
  }
  const mudou = estado !== linha.estado;
  const desde = mudou || !linha.desde ? agora.toISOString() : linha.desde;
  const latencias = [...(Array.isArray(linha.latencias) ? linha.latencias : []), ms == null ? -1 : ms].slice(-LATENCIAS);
  const upd = { estado, desde, checado_em: agora.toISOString(), ms, latencias };

  // diagnóstico: na mudança de estado e a cada 30 min (a Evolution guarda o motivo da última queda)
  let diag = linha.diagnostico || null;
  const diagVelho = !linha.diagnostico_em || agora - Date.parse(linha.diagnostico_em) > DIAGNOSTICO_CADA_MS;
  if (estado !== 'indisponivel' && (mudou || diagVelho)) {
    try {
      const [raiz, info] = await Promise.all([
        evo('/', { ms: 8000 }).then(r => r.json).catch(() => null),
        evo(`/instance/fetchInstances?instanceName=${inst}`, { ms: 10000 }).then(r => r.json).catch(() => null),
      ]);
      diag = diagnosticoDe(raiz, info);
      upd.diagnostico = diag; upd.diagnostico_em = agora.toISOString();
    } catch { /* fica o anterior */ }
  }

  const acoes = [];
  if (mudou) {
    const durou = linha.desde ? Math.max(0, Math.round((agora - Date.parse(linha.desde)) / 1000)) : null;
    const codigo = estado === 'close' && diag ? diag.queda_codigo : null;
    acoes.push({ em: agora.toISOString(), estado, anterior: linha.estado || null, durou_seg: durou, motivo_codigo: codigo,
      motivo: estado === 'indisponivel' ? 'o servidor da Evolution não respondeu (fora do ar ou lento demais)' : motivoDoCodigo(codigo), ms });
  }

  // reconectar com a sessão guardada: desconectado há mais de 1,5 min, uma vez a cada 10 min,
  // e nunca quando o WhatsApp encerrou a sessão (401: só o QR Code resolve)
  const fora = estado === 'close' && !mudou && agora - Date.parse(desde) >= RECONECTAR_APOS_MS;
  const podeTentar = !linha.reconexao_em || agora - Date.parse(linha.reconexao_em) >= RECONECTAR_CADA_MS;
  const sessaoEncerrada = diag && ['401', '500', '403'].includes(String(diag.queda_codigo || ''));
  if (fora && podeTentar && !sessaoEncerrada) {
    let resultado = 'pedida';
    try { const r = await evo(`/instance/connect/${inst}`, { ms: 15000 }); resultado = r.status < 400 ? 'pedida' : `recusada (${r.status})`; }
    catch { resultado = 'sem resposta'; }
    upd.reconexao_em = agora.toISOString();
    acoes.push({ em: agora.toISOString(), estado, anterior: estado, acao: 'reconexao', motivo: `reconexão automática ${resultado}`, ms });
  }

  // sessão travada ("conectado" sem entregar nem receber): reinicia a instância sozinho,
  // no máximo a cada 15 min e 2 vezes sem melhora — depois disso só o QR resolve
  let travada = null;
  if (estado === 'open') {
    try {
      const tr = await lerTrafego(agora.getTime());
      travada = sessaoTravada(tr);
      // já estava travada e as mensagens saíram da janela: continua travada até chegar
      // mensagem ou confirmação de entrega. Sem envio novo depois do reinício não dá para
      // saber se ele resolveu: fica aguardando, sem reiniciar de novo nem alertar.
      const antes = linha.travada && linha.travada.desde ? Date.parse(linha.travada.desde) : null;
      if (!travada && antes && !(tr.ultimaEntrada && Date.parse(tr.ultimaEntrada) > antes) && !(tr.ultimoRecibo && Date.parse(tr.ultimoRecibo) > antes)) {
        const depois = linha.reinicio_em ? tr.saidas.filter(m => m.status === 'enviado' && Date.parse(m.created_at) > Date.parse(linha.reinicio_em)).length : 0;
        travada = { desde: linha.travada.desde, mensagens: linha.travada.mensagens || 0, ...(depois ? { depois_do_reinicio: depois } : { aguardando: true }) };
      }
    } catch { travada = null; }
    let reinicios = linha.reinicios || 0;
    // depois do último reinício voltou a entregar ou receber: zera a conta
    if (!travada && reinicios) { reinicios = 0; upd.reinicios = 0; }
    if (travada) {
      const jaTentou = linha.reinicio_em && Date.parse(linha.reinicio_em) > Date.parse(travada.desde);
      const podeReiniciar = !linha.reinicio_em || agora - Date.parse(linha.reinicio_em) >= REINICIAR_CADA_MS;
      if (reinicios < REINICIOS_MAX && podeReiniciar && !travada.aguardando) {
        const resultado = await reiniciarInstancia(inst);
        upd.reinicio_em = agora.toISOString(); upd.reinicios = reinicios + 1;
        acoes.push({ em: agora.toISOString(), estado, anterior: estado, acao: 'reinicio', ms,
          motivo: `sessão travada: ${travada.mensagens} mensagens enviadas desde ${new Date(travada.desde).toLocaleTimeString('pt-BR', { timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit' })} sem entrega e nada recebido — reinício automático ${resultado}` });
        travada.reinicio = resultado;
      }
      travada.tentativas = upd.reinicios ?? reinicios; travada.ja_tentou = !!jaTentou;
    }
    if (!!travada !== !!linha.travada || travada) upd.travada = travada;
  } else if (linha.travada) upd.travada = null;

  // a Evolution passou por "conectando" e voltou sozinha: em 11/11 as duas vezes a sessão
  // voltou travada. Reinício preventivo — sem esperar alguém enviar e não ser entregue
  // (com o atendimento parado ninguém envia, e as mensagens dos clientes ficam sem chegar).
  // Não vale para a volta de um QR Code recém-lido nem para a volta do nosso próprio reinício.
  const recente = (v, ms) => !!v && agora - Date.parse(v) < ms;
  if (mudou && estado === 'open' && linha.estado === 'connecting' && !acoes.some(a => a.acao === 'reinicio')
      && !recente(linha.reinicio_em, REINICIAR_CADA_MS) && !recente(linha.reconexao_em, REINICIAR_CADA_MS) && !recente(diag && diag.queda_em, REINICIAR_CADA_MS)) {
    const resultado = await reiniciarInstancia(inst);
    upd.reinicio_em = agora.toISOString();
    acoes.push({ em: agora.toISOString(), estado, anterior: estado, acao: 'reinicio', ms, motivo: `a Evolution reconectou sozinha: reinício preventivo da sessão ${resultado}` });
  }

  // alerta na tela: fora do ar há mais de 5 minutos, ou travada sem o reinício resolver
  const parado = estado !== 'open' && agora - Date.parse(desde) >= ALERTA_APOS_MS;
  const travadaSemJeito = travada && !travada.aguardando && (travada.tentativas || 0) >= REINICIOS_MAX && linha.reinicio_em && agora - Date.parse(linha.reinicio_em) >= ALERTA_APOS_MS;
  upd.alerta = parado ? { desde, estado, motivo: estado === 'indisponivel' ? 'servidor da Evolution sem resposta' : (diag && diag.queda_motivo) || null }
    : travadaSemJeito ? { desde: travada.desde, estado: 'travada', motivo: 'a sessão aparece conectada, mas não entrega nem recebe, e o reinício automático não resolveu: desconecte e leia o QR Code de novo' }
    : null;

  for (const a of acoes) await sb('atend_whatsapp_conexao', { method: 'POST', prefer: 'return=minimal', body: a });
  await sb('atend_whatsapp_monitor?id=eq.1', { method: 'PATCH', prefer: 'return=minimal', body: upd });
  return { estado, ms, mudou, reconexao: !!upd.reconexao_em && acoes.some(a => a.acao === 'reconexao'), reinicio: acoes.some(a => a.acao === 'reinicio') };
}

function tokenConfere(recebido, esperado) {
  const a = Buffer.from(String(recebido || '')), b = Buffer.from(String(esperado || ''));
  return a.length >= 32 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  try {
    const cfg = ((await sb('atend_whatsapp_monitor?id=eq.1&select=token')) || [])[0];
    if (!cfg || !tokenConfere(req.headers['x-monitor-token'], cfg.token)) return res.status(401).json({ ok: false });
    if (!evoUrl() || !evoKey() || !evoInst()) return res.status(200).json({ ok: false, erro: 'Evolution não configurada' });
    const r = await verificar();
    return res.status(200).json({ ok: true, ...r });
  } catch (err) {
    console.error('[whatsapp-monitor]', String(err.message || err).slice(0, 200));
    return res.status(200).json({ ok: false });
  }
}
