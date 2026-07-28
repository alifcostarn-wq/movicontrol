// ============================================================================
// api/atendimento.js — PROXY ISOLADO DO CENTRO DE ATENDIMENTO (Vercel)
// ----------------------------------------------------------------------------
// Isolamento moviOn: arquivo EXCLUSIVO deste módulo. Nada compartilhado com
// ixc-proxy.js, campo-proxy.js, movifiber.js, moviapp.js ou push.js.
//
// RESPONSABILIDADES
//   1. Receber o webhook da Evolution API (mensagem recebida do cliente)
//   2. Interpretar o fluxo do bot (o mesmo JSON que o canvas gera)
//   3. Executar os conectores (fatura, pix, chamado, bloqueio, viabilidade)
//   4. Servir o front-end (conversas, mensagens, fluxo) com auth por setor
//
// ENV VARS (Vercel > Settings > Environment Variables)
//   já existentes:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//                   IXC_URL, IXC_USER, IXC_TOKEN, GROQ_API_KEY
//   novas:          EVOLUTION_URL       ex: https://wa.seudominio.com.br
//                   EVOLUTION_APIKEY    a AUTHENTICATION_API_KEY da VPS
//                   EVOLUTION_INSTANCE  ex: movion
//                   ATEND_WEBHOOK_SECRET  string aleatória longa
//
// ROTAS (POST /api/atendimento, body {acao:"..."})
//   webhook            <- chamado pela Evolution (autentica por secret)
//   cron               <- agendamentos + limpeza (Vercel Cron)
//   me                 -> perfil do usuário logado no módulo
//   conversas.listar   -> lista filtrada por setor
//   conversas.atualizar-> muda coluna/setor/atendente/tags/notas
//   mensagens.listar   -> thread de uma conversa
//   mensagens.enviar   -> atendente humano responde
//   fluxo.obter        -> fluxo ativo
//   fluxo.salvar       -> grava nodes/edges (só admin)
//   fluxo.simular      -> testa o fluxo sem WhatsApp (dry-run)
// ============================================================================

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const MAX_PASSOS_FLUXO = 15;   // trava anti-loop
const MAX_TENTATIVAS   = 3;    // respostas não reconhecidas antes de transbordar

// ============================================================================
// HELPERS BÁSICOS
// ============================================================================
function env() {
  return {
    SUPA_URL:  process.env.SUPABASE_URL || 'https://mgtetsmcswdtvsgewcen.supabase.co',
    SRV:       process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    IXC_URL:  (process.env.IXC_URL || 'https://netmaisconnect.com.br').replace(/\/$/, '').replace(/\/adm\.php$/, ''),
    IXC_USER:  process.env.IXC_USER || '',
    IXC_TOKEN: process.env.IXC_TOKEN || '',
    EVO_URL:  (process.env.EVOLUTION_URL || '').replace(/\/$/, ''),
    EVO_KEY:   process.env.EVOLUTION_APIKEY || '',
    EVO_INST:  process.env.EVOLUTION_INSTANCE || '',
    WH_SECRET: process.env.ATEND_WEBHOOK_SECRET || '',
    GROQ:      process.env.GROQ_API_KEY || '',
  };
}

function normalizarTxt(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// "5585988110101@s.whatsapp.net" -> "5585988110101"
function normalizarFone(v) {
  const d = String(v ?? '').split('@')[0].replace(/\D/g, '');
  if (!d) return '';
  return d.startsWith('55') ? d : '55' + d;
}

// O Brasil tem o problema do 9º dígito: gera as duas formas para busca
function variantesFone(fone) {
  const f = normalizarFone(fone);
  const out = new Set([f]);
  const m = f.match(/^55(\d{2})(\d+)$/);
  if (m) {
    const [, ddd, resto] = m;
    if (resto.length === 9 && resto.startsWith('9')) out.add('55' + ddd + resto.slice(1));
    if (resto.length === 8) out.add('55' + ddd + '9' + resto);
  }
  return [...out];
}

function fmtMoeda(v) {
  return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
}

// Substitui {{variavel}} no texto do bloco
function montarTexto(texto, vars) {
  return String(texto || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars?.[k] ?? ''));
}

// ============================================================================
// SUPABASE (REST com service role — sem dependência de pacote)
// ============================================================================
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

async function sbUm(e, path, opts) {
  const d = await sb(e, path, opts);
  return Array.isArray(d) ? (d[0] || null) : d;
}

async function logFluxo(e, reg) {
  try { await sb(e, 'atend_fluxo_logs', { method: 'POST', body: reg, prefer: 'return=minimal' }); }
  catch (err) { console.error('[atendimento] falha ao gravar log:', err.message); }
}

// ============================================================================
// EVOLUTION API — envio
// ============================================================================
async function waEnviar(e, fone, texto) {
  if (!e.EVO_URL || !e.EVO_KEY || !e.EVO_INST) {
    throw new Error('Evolution API não configurada (EVOLUTION_URL / EVOLUTION_APIKEY / EVOLUTION_INSTANCE).');
  }
  const r = await fetch(`${e.EVO_URL}/message/sendText/${e.EVO_INST}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: e.EVO_KEY },
    // Evolution v2. Em v1 o corpo é { number, textMessage: { text } }.
    body: JSON.stringify({ number: normalizarFone(fone), text: texto }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Evolution ${r.status}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

// ============================================================================
// IXC — leitura/escrita (mesmo padrão dos outros proxies do moviOn)
// Auth: Basic base64(IXC_USER:IXC_TOKEN) — o token sozinho NÃO funciona.
// ============================================================================
async function ixc(e, endpoint, params = {}, metodo = 'listar') {
  if (!e.IXC_USER || !e.IXC_TOKEN) throw new Error('IXC não configurado (IXC_USER / IXC_TOKEN).');
  const auth = Buffer.from(`${e.IXC_USER}:${e.IXC_TOKEN}`).toString('base64');
  const r = await fetch(`${e.IXC_URL}/webservice/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
      ixcsoft: metodo,
    },
    body: JSON.stringify(params),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`IXC ${r.status}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

// O gateway (Sulcredi/IXC) devolve o PIX aninhado em profundidade variável.
// Procura recursivamente qualquer string EMV que comece com "0002".
function acharPix(obj, prof = 0) {
  if (!obj || prof > 8) return null;
  if (typeof obj === 'string') return /^0002[0-9A-Za-z]/.test(obj.trim()) && obj.length > 60 ? obj.trim() : null;
  if (Array.isArray(obj)) {
    for (const it of obj) { const r = acharPix(it, prof + 1); if (r) return r; }
    return null;
  }
  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) { const r = acharPix(v, prof + 1); if (r) return r; }
  }
  return null;
}

// ============================================================================
// CONECTORES — o que o bot sabe fazer sozinho
// Cada um recebe { e, conversa, vars, texto } e devolve:
//   { resultado, variaveis, anexoTexto, patchConversa }
// `resultado` é o que escolhe a aresta de saída (ex: 'sim' / 'nao').
// ============================================================================
const CONECTORES = {

  async consultar_cliente({ e, conversa }) {
    const vars = {}, patch = {};
    for (const f of variantesFone(conversa.contato_fone)) {
      const d = await ixc(e, 'cliente', {
        qtype: 'cliente.telefone_celular', query: f.replace(/^55/, ''), oper: '=', rp: '1',
      });
      const c = (d.registros || [])[0];
      if (c) {
        vars.cliente_nome = (c.razao || '').split(' ')[0];
        vars.cliente_id = c.id;
        patch.cliente_ixc_id = String(c.id);
        patch.contato_nome = c.razao || conversa.contato_nome;
        patch.cliente_snapshot = { id: c.id, razao: c.razao, cpf: c.cnpj_cpf, ativo: c.ativo };
        return { resultado: 'cliente', variaveis: vars, patchConversa: patch };
      }
    }
    return { resultado: 'lead', variaveis: { cliente_nome: '' } };
  },

  async consultar_bloqueio({ e, conversa, vars }) {
    const id = vars.cliente_id || conversa.cliente_ixc_id;
    if (!id) return { resultado: 'nao' };
    const d = await ixc(e, 'cliente_contrato', {
      qtype: 'cliente_contrato.id_cliente', query: String(id), oper: '=', rp: '20',
    });
    const contratos = d.registros || [];
    // status_internet: 'A' ativo | 'B'/'CM'/'FA' bloqueios | 'D' desativado
    const bloqueado = contratos.some(c => ['B', 'CM', 'FA'].includes(String(c.status_internet || '').toUpperCase()));
    return {
      resultado: bloqueado ? 'sim' : 'nao',
      variaveis: { bloqueado: bloqueado ? 'sim' : 'nao' },
      patchConversa: { cliente_snapshot: { ...(conversa.cliente_snapshot || {}), bloqueado } },
    };
  },

  async enviar_fatura({ e, conversa, vars }) {
    const id = vars.cliente_id || conversa.cliente_ixc_id;
    if (!id) return { resultado: 'sem_cliente', anexoTexto: 'Não localizei seu cadastro pelo número. Vou te encaminhar para um atendente.' };
    const d = await ixc(e, 'fn_areceber', {
      qtype: 'fn_areceber.id_cliente', query: String(id), oper: '=', rp: '50',
      sortname: 'fn_areceber.data_vencimento', sortorder: 'asc',
    });
    const abertas = (d.registros || []).filter(f => String(f.status || '').toUpperCase() === 'A');
    if (!abertas.length) return { resultado: 'sem_debito', anexoTexto: 'Não encontrei faturas em aberto. Está tudo em dia! ✅' };
    const f = abertas[0];
    const link = `${e.IXC_URL}/boleto/${f.id}`;
    return {
      resultado: 'ok',
      variaveis: { fatura_id: f.id, fatura_valor: fmtMoeda(f.valor), fatura_venc: f.data_vencimento },
      anexoTexto: `Vencimento: ${f.data_vencimento}\nValor: ${fmtMoeda(f.valor)}\n${link}`,
    };
  },

  async enviar_pix({ e, conversa, vars }) {
    const id = vars.cliente_id || conversa.cliente_ixc_id;
    if (!id) return { resultado: 'sem_cliente' };
    let faturaId = vars.fatura_id;
    if (!faturaId) {
      const d = await ixc(e, 'fn_areceber', {
        qtype: 'fn_areceber.id_cliente', query: String(id), oper: '=', rp: '50',
        sortname: 'fn_areceber.data_vencimento', sortorder: 'asc',
      });
      const ab = (d.registros || []).filter(f => String(f.status || '').toUpperCase() === 'A');
      if (!ab.length) return { resultado: 'sem_debito', anexoTexto: 'Você não tem faturas em aberto. ✅' };
      faturaId = ab[0].id;
    }
    const g = await ixc(e, 'get_pix', { id_areceber: String(faturaId) }, 'listar');
    const pix = acharPix(g);
    if (!pix) return { resultado: 'erro', anexoTexto: 'Não consegui gerar o Pix agora. Vou te encaminhar para o Financeiro.' };
    return { resultado: 'ok', variaveis: { pix }, anexoTexto: pix };
  },

  async abrir_chamado({ e, conversa, vars }) {
    const id = vars.cliente_id || conversa.cliente_ixc_id;
    if (!id) return { resultado: 'sem_cliente' };
    const r = await ixc(e, 'su_ticket', {
      id_cliente: String(id),
      titulo: 'Atendimento WhatsApp — abertura automática',
      mensagem: `Chamado aberto pelo bot.\nÚltima mensagem: ${vars.ultima_msg || '—'}`,
      id_assunto: process.env.IXC_ASSUNTO_PADRAO || '1',
      prioridade: 'M',
      origem_endereco: 'M',
      status: 'N',
    }, 'inserir');
    const chamado = r?.id || r?.registro?.id || null;
    return {
      resultado: chamado ? 'ok' : 'erro',
      variaveis: { chamado_id: chamado },
      patchConversa: chamado ? { chamado_id: String(chamado) } : {},
      anexoTexto: chamado ? `Protocolo: #${chamado}` : '',
    };
  },

  async consultar_viabilidade({ e, vars, texto }) {
    const endereco = (texto || '').trim();
    if (endereco.length < 8) {
      return { resultado: 'aguardando', anexoTexto: '' };
    }
    // Consulta as CTOs do MoviFiber no Supabase (proximidade textual por bairro).
    try {
      const termo = encodeURIComponent(normalizarTxt(endereco).split(/[,\-]/)[0].slice(0, 40));
      const ctos = await sb(e, `ftth_cliente_instalacao?select=caixa_nome&limit=1&caixa_nome=ilike.*${termo}*`);
      const tem = Array.isArray(ctos) && ctos.length > 0;
      return {
        resultado: tem ? 'sim' : 'nao',
        variaveis: { endereco },
        anexoTexto: tem
          ? 'Boa notícia: temos cobertura na sua região! 🎉'
          : 'Não identifiquei cobertura confirmada nesse endereço. Um consultor vai verificar manualmente.',
      };
    } catch {
      return { resultado: 'nao', variaveis: { endereco } };
    }
  },

  async enviar_contrato({ e, conversa, vars }) {
    const id = vars.cliente_id || conversa.cliente_ixc_id;
    if (!id) return { resultado: 'sem_cliente' };
    return { resultado: 'ok', anexoTexto: `${e.IXC_URL}/contrato/${id}` };
  },

  // ATENÇÃO: o desbloqueio de confiança só funciona via Central do Assinante
  // (login por sessão com CPF mascarado). O endpoint PUT do webservice NÃO
  // executa a liberação. Por isso aqui ele transborda para o Financeiro até
  // que a rotina da Central seja portada para este proxy.
  async desbloqueio_confianca({ conversa, vars }) {
    return {
      resultado: 'manual',
      anexoTexto: 'Vou pedir para o Financeiro liberar seu acesso de confiança agora mesmo.',
    };
  },
};

// ============================================================================
// IA (fallback) — Groq
// ============================================================================
async function responderIA(e, no, conversa, texto) {
  if (!e.GROQ) return 'Não entendi. Vou te encaminhar para um atendente. 👤';
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${e.GROQ}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 300,
        messages: [
          { role: 'system', content: `Você é o assistente da MoviOn, provedor de internet em Mossoró/RN. Responda em português do Brasil, no máximo 3 frases, de forma cordial. ${no.texto || ''} Se não souber, diga que vai encaminhar para um atendente humano.` },
          { role: 'user', content: String(texto || '').slice(0, 500) },
        ],
      }),
    });
    const d = await r.json();
    return d?.choices?.[0]?.message?.content?.trim() || 'Vou te encaminhar para um atendente. 👤';
  } catch {
    return 'Vou te encaminhar para um atendente. 👤';
  }
}

// ============================================================================
// INTERPRETADOR DE FLUXO
// ============================================================================
function indexarFluxo(fluxo) {
  const nodes = new Map((fluxo.nodes || []).map(n => [Number(n.id), n]));
  const saidas = new Map();
  for (const ed of (fluxo.edges || [])) {
    const k = Number(ed.from);
    if (!saidas.has(k)) saidas.set(k, []);
    saidas.get(k).push(ed);
  }
  return { nodes, saidas };
}

function numeroDaLabel(label) {
  const m = normalizarTxt(label).match(/^(\d+)/);
  return m ? m[1] : null;
}

function labelSemNumero(label) {
  return normalizarTxt(label).replace(/^\d+\s*[·.\-)]*\s*/, '').trim();
}

// Qual aresta o cliente escolheu no menu?
function casarOpcao(arestas, texto) {
  const t = normalizarTxt(texto);
  if (!t) return null;
  const digitos = t.replace(/\D/g, '');
  if (digitos) {
    const porNum = arestas.find(a => numeroDaLabel(a.label) === digitos);
    if (porNum) return porNum;
  }
  if (t.length >= 3) {
    const porTexto = arestas.find(a => {
      const l = labelSemNumero(a.label);
      return l.length >= 3 && (l.includes(t) || t.includes(l));
    });
    if (porTexto) return porTexto;
  }
  return null;
}

// Qual aresta seguir depois de uma ação/condição?
function escolherAresta(arestas, resultado) {
  if (!arestas.length) return null;
  if (resultado) {
    const casada = arestas.find(a => {
      const l = labelSemNumero(a.label);
      return l && (l.includes(normalizarTxt(resultado)) || normalizarTxt(resultado).includes(l));
    });
    if (casada) return casada;
  }
  const semLabel = arestas.find(a => !String(a.label || '').trim());
  return semLabel || arestas[0];
}

function arestaFallback(arestas) {
  return arestas.find(a => /nao reconhec|fallback|\bia\b/.test(normalizarTxt(a.label))) || null;
}

/**
 * Roda o fluxo a partir do estado atual.
 * Não toca no banco nem envia WhatsApp — devolve o que precisa acontecer.
 */
async function rodarFluxo(e, { fluxo, sessao, conversa, texto }) {
  const { nodes, saidas } = indexarFluxo(fluxo);
  const out = { enviar: [], logs: [], patch: {}, sessao: null, limparSessao: false };
  const vars = { ...(sessao?.variaveis || {}), ultima_msg: texto };

  // ---- 1. Ponto de partida -------------------------------------------------
  let noId = null;
  let retomando = null;   // nó de ação sendo reexecutado: não repete o texto do prompt

  if (sessao?.node_atual && nodes.has(Number(sessao.node_atual))) {
    const noMenu = nodes.get(Number(sessao.node_atual));
    const arestas = saidas.get(noMenu.id) || [];
    const escolhida = casarOpcao(arestas, texto);

    if (escolhida) {
      // menu com `captura` guarda a resposta do cliente (ex.: nota de 1 a 5)
      if (noMenu.captura) {
        const bruto = String(texto || '').trim();
        vars[noMenu.captura] = bruto;
        if (noMenu.captura === 'rating') {
          const n = parseInt(bruto.replace(/\D/g, ''), 10);
          if (n >= 1 && n <= 5) out.patch.rating = n;
        }
      }
      noId = Number(escolhida.to);
    } else if (noMenu.tipo === 'acao' || sessao.aguardando === 'texto_livre') {
      // o bloco pediu texto livre (ex.: endereço) — reexecuta com o que chegou
      noId = noMenu.id;
      retomando = noMenu.id;
    } else {
      const tentativas = Number(sessao.tentativas || 0) + 1;
      const fb = arestaFallback(arestas);
      if (fb) {
        noId = Number(fb.to);
      } else if (tentativas >= MAX_TENTATIVAS) {
        out.enviar.push({ texto: 'Não consegui entender. Vou te passar para um atendente. 👤' });
        out.patch = { coluna: 'atendimento', bot_ativo: false, setor: conversa.setor || 'Suporte' };
        out.limparSessao = true;
        return out;
      } else {
        out.enviar.push({ texto: 'Não entendi essa opção. ' + montarTexto(noMenu.texto, vars), node: noMenu.id });
        out.sessao = { node_atual: noMenu.id, aguardando: sessao.aguardando || 'opcao', variaveis: vars, tentativas };
        return out;
      }
    }
  } else {
    const inicio = [...nodes.values()].find(n => n.tipo === 'inicio');
    if (!inicio) throw new Error('Fluxo sem bloco de início.');
    noId = inicio.id;
  }

  // ---- 2. Percorre o fluxo até uma parada ---------------------------------
  for (let passo = 0; passo < MAX_PASSOS_FLUXO; passo++) {
    const no = nodes.get(Number(noId));
    if (!no) break;
    const arestas = saidas.get(no.id) || [];
    let resultado = null;

    switch (no.tipo) {

      case 'inicio':
        break;

      case 'mensagem': {
        const t = montarTexto(no.texto, vars);
        if (t.trim()) out.enviar.push({ texto: t, node: no.id });
        break;
      }

      case 'acao': {
        const t0 = Date.now();
        const fn = CONECTORES[no.conector];
        if (!fn) {
          out.logs.push({ node_id: no.id, node_tipo: 'acao', conector: no.conector, erro: 'conector desconhecido' });
          break;
        }
        try {
          const r = await fn({ e, conversa: { ...conversa, ...out.patch }, vars, texto });
          resultado = r.resultado || null;
          Object.assign(vars, r.variaveis || {});
          Object.assign(out.patch, r.patchConversa || {});
          const prompt = (no.id === retomando) ? '' : montarTexto(no.texto, vars);
          const corpo = [prompt, r.anexoTexto].filter(x => x && String(x).trim()).join('\n');
          if (corpo.trim()) out.enviar.push({ texto: corpo, node: no.id });
          out.logs.push({ node_id: no.id, node_tipo: 'acao', conector: no.conector, entrada: texto, resultado, ms: Date.now() - t0 });

          // conector pediu um dado do cliente: para e espera a resposta
          if (resultado === 'aguardando') {
            out.sessao = { node_atual: no.id, aguardando: 'texto_livre', variaveis: vars, tentativas: 0 };
            return out;
          }
        } catch (err) {
          out.logs.push({ node_id: no.id, node_tipo: 'acao', conector: no.conector, erro: err.message, ms: Date.now() - t0 });
          resultado = 'erro';
        }
        break;
      }

      case 'condicao':
        resultado = normalizarTxt(vars[no.variavel] || vars.bloqueado || '');
        break;

      case 'ia': {
        const t = await responderIA(e, no, conversa, texto);
        out.enviar.push({ texto: t, node: no.id });
        out.logs.push({ node_id: no.id, node_tipo: 'ia', entrada: texto });
        out.limparSessao = true;
        return out;
      }

      case 'menu': {
        out.enviar.push({ texto: montarTexto(no.texto, vars), node: no.id });
        out.sessao = { node_atual: no.id, aguardando: 'opcao', variaveis: vars, tentativas: 0 };
        return out;
      }

      case 'setor': {
        out.patch.setor = no.setor || conversa.setor || 'Suporte';
        out.patch.coluna = 'atendimento';
        out.patch.bot_ativo = false;
        out.enviar.push({ texto: `Encaminhando para o setor ${out.patch.setor}. Um atendente continua com você em instantes. 👤`, node: no.id });
        out.logs.push({ node_id: no.id, node_tipo: 'setor', resultado: out.patch.setor });
        out.limparSessao = true;
        return out;
      }

      case 'fim': {
        const t = montarTexto(no.texto, vars);
        if (t.trim()) out.enviar.push({ texto: t, node: no.id });
        out.patch.coluna = 'resolvidos';
        out.patch.bot_ativo = true;
        out.logs.push({ node_id: no.id, node_tipo: 'fim' });
        out.limparSessao = true;
        return out;
      }

      default:
        break;
    }

    const prox = escolherAresta(arestas, resultado);
    if (!prox) break;
    noId = Number(prox.to);
  }

  return out;
}

// ============================================================================
// APLICA O RESULTADO: grava no banco e dispara no WhatsApp
// ============================================================================
async function aplicarResultado(e, conversa, out) {
  // 1. mensagens
  for (const m of out.enviar) {
    let erro = null;
    try { await waEnviar(e, conversa.contato_fone, m.texto); }
    catch (err) { erro = err.message; console.error('[atendimento] envio falhou:', err.message); }
    await sb(e, 'atend_mensagens', {
      method: 'POST', prefer: 'return=minimal',
      body: { conversa_id: conversa.id, direcao: 'bot', conteudo: m.texto, node_id: m.node || null },
    });
    if (erro) await logFluxo(e, { conversa_id: conversa.id, contato_fone: conversa.contato_fone, node_id: m.node || null, erro });
  }

  // 2. patch da conversa
  if (Object.keys(out.patch).length) {
    const patch = { ...out.patch };
    if (out.enviar.length) {
      patch.ultima_msg = out.enviar[out.enviar.length - 1].texto.slice(0, 200);
      patch.ultima_msg_em = new Date().toISOString();
    }
    await sb(e, `atend_conversas?id=eq.${conversa.id}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' });
  }

  // 3. sessão
  if (out.limparSessao) {
    await sb(e, `atend_sessoes?contato_fone=eq.${conversa.contato_fone}`, { method: 'DELETE', prefer: 'return=minimal' });
  } else if (out.sessao) {
    await sb(e, 'atend_sessoes?on_conflict=contato_fone', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: {
        contato_fone: conversa.contato_fone,
        conversa_id: conversa.id,
        node_atual: out.sessao.node_atual,
        aguardando: out.sessao.aguardando,
        variaveis: out.sessao.variaveis,
        tentativas: out.sessao.tentativas,
        expira_em: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
  }

  // 4. logs
  for (const l of out.logs) {
    await logFluxo(e, { ...l, conversa_id: conversa.id, contato_fone: conversa.contato_fone });
  }
}

// ============================================================================
// WEBHOOK — mensagem recebida da Evolution API
// ============================================================================
async function tratarWebhook(e, body) {
  const evento = String(body.event || body.type || '').toLowerCase();
  if (evento && !evento.includes('messages.upsert') && !evento.includes('messages_upsert')) {
    return { ok: true, ignorado: `evento ${evento}` };
  }

  const d = body.data || body.message || body;
  const key = d.key || {};
  if (key.fromMe) return { ok: true, ignorado: 'mensagem própria' };

  const fone = normalizarFone(key.remoteJid || d.from || d.number);
  if (!fone || String(key.remoteJid || '').includes('@g.us')) {
    return { ok: true, ignorado: 'grupo ou remetente inválido' };
  }

  const msg = d.message || {};
  const texto = (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.buttonsResponseMessage?.selectedDisplayText ||
    msg.listResponseMessage?.title ||
    d.text || ''
  ).trim();

  let tipo = 'texto';
  if (msg.imageMessage) tipo = 'imagem';
  else if (msg.audioMessage) tipo = 'audio';
  else if (msg.videoMessage) tipo = 'video';
  else if (msg.documentMessage) tipo = 'documento';
  else if (msg.locationMessage) tipo = 'localizacao';

  // dedupe por wa_id
  const waId = key.id || null;
  if (waId) {
    const jaTem = await sbUm(e, `atend_mensagens?wa_id=eq.${encodeURIComponent(waId)}&select=id&limit=1`);
    if (jaTem) return { ok: true, ignorado: 'duplicada' };
  }

  // acha ou cria a conversa (reaproveita a aberta; resolvida gera uma nova)
  let conversa = await sbUm(e,
    `atend_conversas?contato_fone=eq.${fone}&coluna=neq.resolvidos&deleted_at=is.null&select=*&limit=1`);

  if (!conversa) {
    conversa = await sbUm(e, 'atend_conversas', {
      method: 'POST',
      body: {
        contato_fone: fone,
        contato_nome: d.pushName || body.pushName || fone,
        coluna: 'novos',
        ultima_msg: texto.slice(0, 200),
        ultima_msg_em: new Date().toISOString(),
        nao_lidas: 1,
      },
    });
  }

  // grava a mensagem recebida
  await sb(e, 'atend_mensagens', {
    method: 'POST', prefer: 'return=minimal',
    body: { conversa_id: conversa.id, direcao: 'in', conteudo: texto || `[${tipo}]`, tipo, wa_id: waId },
  });
  await sb(e, `atend_conversas?id=eq.${conversa.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      ultima_msg: (texto || `[${tipo}]`).slice(0, 200),
      ultima_msg_em: new Date().toISOString(),
      nao_lidas: (conversa.nao_lidas || 0) + 1,
    },
  });

  // humano assumiu → bot fica quieto
  if (conversa.bot_ativo === false) return { ok: true, bot: 'inativo', conversa_id: conversa.id };
  if (!texto) return { ok: true, bot: 'sem texto para interpretar', conversa_id: conversa.id };

  const fluxo = await sbUm(e, 'atend_fluxos?ativo=is.true&select=*&limit=1');
  if (!fluxo) return { ok: true, bot: 'nenhum fluxo ativo', conversa_id: conversa.id };

  const sessao = await sbUm(e, `atend_sessoes?contato_fone=eq.${fone}&select=*&limit=1`);
  const sessaoValida = sessao && new Date(sessao.expira_em) > new Date() ? sessao : null;

  const out = await rodarFluxo(e, { fluxo, sessao: sessaoValida, conversa, texto });
  await aplicarResultado(e, conversa, out);

  return { ok: true, conversa_id: conversa.id, enviadas: out.enviar.length, patch: out.patch };
}

// ============================================================================
// CRON — agendamentos vencidos + limpeza de sessões
// ============================================================================
async function tratarCron(e) {
  const agora = new Date().toISOString();
  const pend = await sb(e,
    `atend_agendamentos?enviado_em=is.null&quando=lte.${agora}&select=id,texto,conversa_id&limit=50`);
  let enviados = 0, falhas = 0;

  for (const ag of (pend || [])) {
    const c = await sbUm(e, `atend_conversas?id=eq.${ag.conversa_id}&select=id,contato_fone`);
    if (!c) continue;
    try {
      await waEnviar(e, c.contato_fone, ag.texto);
      await sb(e, 'atend_mensagens', {
        method: 'POST', prefer: 'return=minimal',
        body: { conversa_id: c.id, direcao: 'out', conteudo: ag.texto },
      });
      await sb(e, `atend_agendamentos?id=eq.${ag.id}`, {
        method: 'PATCH', prefer: 'return=minimal', body: { enviado_em: new Date().toISOString(), erro: null },
      });
      enviados++;
    } catch (err) {
      falhas++;
      await sb(e, `atend_agendamentos?id=eq.${ag.id}`, {
        method: 'PATCH', prefer: 'return=minimal', body: { erro: err.message.slice(0, 300) },
      });
    }
  }

  let sessoes = 0;
  try {
    const r = await fetch(`${e.SUPA_URL}/rest/v1/rpc/atend_limpar_sessoes`, {
      method: 'POST',
      headers: { apikey: e.SRV, Authorization: `Bearer ${e.SRV}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    sessoes = await r.json();
  } catch { /* não crítico */ }

  return { ok: true, enviados, falhas, sessoes_expiradas: sessoes };
}

// ============================================================================
// AUTENTICAÇÃO — valida o token do usuário e devolve o perfil do módulo
// ============================================================================
async function autenticar(e, req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) { const err = new Error('Token ausente.'); err.status = 401; throw err; }

  let userId = null;
  try {
    const r = await fetch(`${e.SUPA_URL}/auth/v1/user`, {
      headers: { apikey: e.SRV, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error('sessão inválida');
    userId = (await r.json()).id;
  } catch {
    const err = new Error('Sessão inválida ou expirada.'); err.status = 401; throw err;
  }

  const p = await sbUm(e, `perfis?id=eq.${userId}&select=id,nome,email,perfil,atendimento,atend_setor,atend_admin`);
  if (!p) { const err = new Error('Perfil não encontrado.'); err.status = 403; throw err; }
  if (!p.atendimento) { const err = new Error('Seu usuário não tem acesso ao Centro de Atendimento.'); err.status = 403; throw err; }

  return {
    id: p.id,
    nome: p.nome,
    email: p.email,
    setor: p.atend_setor || null,                                     // null = vê tudo
    admin: !!p.atend_admin || ['admin', 'operador'].includes(p.perfil),
  };
}

// filtro PostgREST de setor conforme o papel
function filtroSetor(user) {
  if (user.admin || !user.setor) return '';
  return `&setor=eq.${encodeURIComponent(user.setor)}`;
}

// ============================================================================
// HANDLER
// ============================================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-atend-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido' });

  const e = env();
  if (!e.SRV) return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY não configurada na Vercel.' });

  const body = req.body || {};
  const acao = body.acao || (body.event || body.data ? 'webhook' : '');

  try {
    // ---- rotas sem login de usuário -------------------------------------
    if (acao === 'webhook') {
      const segredo = req.headers['x-atend-secret'] || body.secret || '';
      if (e.WH_SECRET && segredo !== e.WH_SECRET) {
        return res.status(401).json({ ok: false, error: 'Secret do webhook inválido.' });
      }
      const r = await tratarWebhook(e, body);
      return res.status(200).json(r);
    }

    if (acao === 'cron') {
      const segredo = req.headers['x-atend-secret'] || body.secret || '';
      if (e.WH_SECRET && segredo !== e.WH_SECRET) {
        return res.status(401).json({ ok: false, error: 'Secret inválido.' });
      }
      return res.status(200).json(await tratarCron(e));
    }

    // ---- daqui pra baixo exige usuário logado ---------------------------
    const user = await autenticar(e, req);

    switch (acao) {

      case 'me':
        return res.status(200).json({ ok: true, user });

      // tudo que o app precisa para abrir, numa chamada só
      case 'bootstrap': {
        const [setores, etiquetas, atalhos, regras, equipe, fluxo, conversas] = await Promise.all([
          sb(e, 'atend_setores?select=nome,cor,ordem&ativo=is.true&order=ordem'),
          sb(e, 'atend_etiquetas?select=id,nome,cor&order=id'),
          sb(e, 'atend_atalhos?select=id,titulo,mensagem,setor&order=id'),
          sb(e, 'atend_regras?select=id,palavra,acao&ativa=is.true&order=id'),
          sb(e, 'perfis?select=id,nome,atend_setor&atendimento=is.true&order=nome'),
          sbUm(e, 'atend_fluxos?ativo=is.true&select=*&limit=1'),
          sb(e, `atend_conversas?select=*&deleted_at=is.null${filtroSetor(user)}&order=ultima_msg_em.desc.nullslast&limit=300`),
        ]);
        const agendamentos = await sb(e,
          `atend_agendamentos?select=id,conversa_id,texto,quando,enviado_em&enviado_em=is.null&order=quando&limit=200`);
        return res.status(200).json({ ok: true, user, setores, etiquetas, atalhos, regras, equipe, fluxo, conversas, agendamentos });
      }

      case 'agendamentos.criar': {
        const conversa_id = Number(body.conversa_id);
        const texto = String(body.texto || '').trim();
        const quando = body.quando;
        if (!conversa_id || !texto || !quando) {
          return res.status(400).json({ ok: false, error: 'conversa_id, texto e quando são obrigatórios.' });
        }
        if (isNaN(Date.parse(quando))) return res.status(400).json({ ok: false, error: 'Data/hora inválida.' });
        const r = await sbUm(e, 'atend_agendamentos', {
          method: 'POST',
          body: { conversa_id, texto, quando: new Date(quando).toISOString(), created_by: user.id },
        });
        return res.status(200).json({ ok: true, agendamento: r });
      }

      case 'agendamentos.cancelar': {
        const id = Number(body.id);
        if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório' });
        await sb(e, `atend_agendamentos?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      case 'chat.listar': {
        const [linhas, perfis] = await Promise.all([
          sb(e, 'atend_chat_interno?select=*&order=created_at&limit=500'),
          sb(e, 'perfis?select=id,nome&atendimento=is.true'),
        ]);
        const nomeDe = Object.fromEntries((perfis || []).map(p => [p.id, p.nome]));
        const canais = {}, dm = {};
        for (const l of (linhas || [])) {
          const item = {
            de: nomeDe[l.autor_id] || 'Usuário',
            x: l.texto,
            h: new Date(l.created_at).toTimeString().slice(0, 5),
          };
          if (l.canal) {
            (canais[l.canal] ||= []).push(item);
          } else if (l.dm_para === user.id || l.autor_id === user.id) {
            const outro = l.autor_id === user.id ? l.dm_para : l.autor_id;
            (dm[nomeDe[outro] || 'Usuário'] ||= []).push(item);
          }
        }
        return res.status(200).json({ ok: true, canais, dm, equipe: perfis });
      }

      case 'chat.enviar': {
        const texto = String(body.texto || '').trim();
        if (!texto) return res.status(400).json({ ok: false, error: 'texto obrigatório' });
        if (!body.canal && !body.dm_para) return res.status(400).json({ ok: false, error: 'informe canal ou dm_para' });
        await sb(e, 'atend_chat_interno', {
          method: 'POST', prefer: 'return=minimal',
          body: { canal: body.canal || null, dm_para: body.dm_para || null, autor_id: user.id, texto },
        });
        return res.status(200).json({ ok: true });
      }

      case 'catalogo.salvar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const tabelas = { etiquetas: 'atend_etiquetas', atalhos: 'atend_atalhos', regras: 'atend_regras' };
        const tab = tabelas[body.tipo];
        if (!tab) return res.status(400).json({ ok: false, error: 'tipo inválido (etiquetas|atalhos|regras)' });
        if (body.remover) {
          await sb(e, `${tab}?id=eq.${Number(body.remover)}`, { method: 'DELETE', prefer: 'return=minimal' });
          return res.status(200).json({ ok: true });
        }
        const r = await sbUm(e, tab, { method: 'POST', body: body.registro || {} });
        return res.status(200).json({ ok: true, registro: r });
      }

      case 'conversas.listar': {
        const col = body.coluna ? `&coluna=eq.${body.coluna}` : '';
        const lista = await sb(e,
          `atend_conversas?select=*&deleted_at=is.null${filtroSetor(user)}${col}` +
          `&order=ultima_msg_em.desc.nullslast&limit=${Math.min(Number(body.limite) || 200, 500)}`);
        return res.status(200).json({ ok: true, conversas: lista });
      }

      case 'conversas.atualizar': {
        const id = Number(body.id);
        if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório' });
        const atual = await sbUm(e, `atend_conversas?id=eq.${id}&select=setor`);
        if (!atual) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });
        if (!user.admin && user.setor && atual.setor && atual.setor !== user.setor) {
          return res.status(403).json({ ok: false, error: 'Conversa de outro setor.' });
        }
        const permitido = ['coluna', 'setor', 'atendente_id', 'tags', 'notas', 'nao_lidas', 'bot_ativo', 'rating', 'contato_nome'];
        const patch = { updated_by: user.id };
        for (const k of permitido) if (k in body) patch[k] = body[k];
        const r = await sbUm(e, `atend_conversas?id=eq.${id}`, { method: 'PATCH', body: patch });
        return res.status(200).json({ ok: true, conversa: r });
      }

      case 'conversas.criar': {
        const fone = normalizarFone(body.fone);
        const texto = String(body.texto || '').trim();
        if (!fone || fone.length < 12) return res.status(400).json({ ok: false, error: 'Telefone inválido. Use DDD + número.' });

        // já existe conversa aberta com esse número? reaproveita
        const existente = await sbUm(e,
          `atend_conversas?contato_fone=eq.${fone}&coluna=neq.resolvidos&deleted_at=is.null&select=*&limit=1`);
        if (existente) return res.status(200).json({ ok: true, conversa: existente, reaproveitada: true });

        const c = await sbUm(e, 'atend_conversas', {
          method: 'POST',
          body: {
            contato_fone: fone,
            contato_nome: String(body.nome || '').trim() || fone,
            coluna: 'atendimento',
            setor: body.setor || user.setor || 'Vendas',
            atendente_id: user.id,
            bot_ativo: false,             // iniciado por humano: o bot não interfere
            created_by: user.id,
            ultima_msg_em: new Date().toISOString(),
          },
        });

        if (texto) {
          await waEnviar(e, fone, texto);
          await sb(e, 'atend_mensagens', {
            method: 'POST', prefer: 'return=minimal',
            body: { conversa_id: c.id, direcao: 'out', conteudo: texto, autor_id: user.id },
          });
          await sb(e, `atend_conversas?id=eq.${c.id}`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: { ultima_msg: 'Você: ' + texto.slice(0, 180), ultima_msg_em: new Date().toISOString() },
          });
        }
        return res.status(200).json({ ok: true, conversa: c });
      }

      case 'mensagens.listar': {
        const id = Number(body.conversa_id);
        if (!id) return res.status(400).json({ ok: false, error: 'conversa_id obrigatório' });
        const msgs = await sb(e,
          `atend_mensagens?conversa_id=eq.${id}&select=*&order=created_at.asc&limit=${Math.min(Number(body.limite) || 300, 1000)}`);
        return res.status(200).json({ ok: true, mensagens: msgs });
      }

      case 'mensagens.enviar': {
        const id = Number(body.conversa_id);
        const texto = String(body.texto || '').trim();
        if (!id || !texto) return res.status(400).json({ ok: false, error: 'conversa_id e texto obrigatórios' });

        const c = await sbUm(e, `atend_conversas?id=eq.${id}&select=*`);
        if (!c) return res.status(404).json({ ok: false, error: 'Conversa não encontrada.' });
        if (!user.admin && user.setor && c.setor && c.setor !== user.setor) {
          return res.status(403).json({ ok: false, error: 'Conversa de outro setor.' });
        }

        await waEnviar(e, c.contato_fone, texto);
        await sb(e, 'atend_mensagens', {
          method: 'POST', prefer: 'return=minimal',
          body: { conversa_id: id, direcao: 'out', conteudo: texto, autor_id: user.id },
        });
        // atendente humano assumiu: o bot para de responder nesta conversa
        await sb(e, `atend_conversas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            bot_ativo: false,
            coluna: c.coluna === 'novos' ? 'atendimento' : c.coluna,
            atendente_id: c.atendente_id || user.id,
            ultima_msg: 'Você: ' + texto.slice(0, 180),
            ultima_msg_em: new Date().toISOString(),
            nao_lidas: 0,
            updated_by: user.id,
          },
        });
        await sb(e, `atend_sessoes?contato_fone=eq.${c.contato_fone}`, { method: 'DELETE', prefer: 'return=minimal' });
        return res.status(200).json({ ok: true });
      }

      case 'fluxo.obter': {
        const f = await sbUm(e, 'atend_fluxos?ativo=is.true&select=*&limit=1');
        return res.status(200).json({ ok: true, fluxo: f });
      }

      case 'fluxo.salvar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores editam o fluxo.' });
        const { nodes, edges, nome, id } = body;
        if (!Array.isArray(nodes) || !Array.isArray(edges)) {
          return res.status(400).json({ ok: false, error: 'nodes e edges obrigatórios.' });
        }
        if (!nodes.some(n => n.tipo === 'inicio')) {
          return res.status(400).json({ ok: false, error: 'O fluxo precisa de um bloco de início.' });
        }
        const payload = { nome: nome || 'Fluxo principal', nodes, edges, ativo: true, updated_by: user.id, updated_at: new Date().toISOString() };
        let f;
        if (id) {
          f = await sbUm(e, `atend_fluxos?id=eq.${Number(id)}`, { method: 'PATCH', body: payload });
        } else {
          await sb(e, 'atend_fluxos?ativo=is.true', { method: 'PATCH', body: { ativo: false }, prefer: 'return=minimal' });
          f = await sbUm(e, 'atend_fluxos', { method: 'POST', body: payload });
        }
        return res.status(200).json({ ok: true, fluxo: f });
      }

      // dry-run: testa o fluxo sem WhatsApp e sem gravar nada
      case 'fluxo.simular': {
        const fluxo = body.fluxo || await sbUm(e, 'atend_fluxos?ativo=is.true&select=*&limit=1');
        if (!fluxo) return res.status(400).json({ ok: false, error: 'Nenhum fluxo ativo.' });
        const conversaFake = { id: 0, contato_fone: '5500000000000', contato_nome: 'Teste', setor: null, cliente_ixc_id: body.cliente_ixc_id || null };
        const out = await rodarFluxo(e, {
          fluxo,
          sessao: body.sessao || null,
          conversa: conversaFake,
          texto: String(body.texto || ''),
        });
        return res.status(200).json({ ok: true, respostas: out.enviar, sessao: out.sessao, patch: out.patch, logs: out.logs });
      }

      default:
        return res.status(400).json({ ok: false, error: `Ação desconhecida: ${acao || '(vazia)'}` });
    }

  } catch (err) {
    console.error('[atendimento]', err);
    return res.status(err.status || 500).json({ ok: false, error: err.message });
  }
}
