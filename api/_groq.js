// ============================================================================
// GROQ — a IA do MoviControl, num lugar só
// ----------------------------------------------------------------------------
// Usada pelo bot do MoviTalk (resposta quando o fluxo não entende), pelo
// assistente do MoviApp e pelas análises do MoviOne (Inteligência Financeira,
// Gerente Financeiro, orçamento).
//
// Por que existe: o modelo vivia escrito em três arquivos. Quando a Groq
// desligou o llama-3.3-70b-versatile (16/08/2026, contas fora do plano
// Enterprise), as três partes pararam juntas e em silêncio — o bot passou a
// mandar "vou te encaminhar para um atendente" para tudo. Agora:
//   • o modelo é escolhido aqui (ou pela variável GROQ_MODEL na Vercel);
//   • se a Groq disser que o modelo foi desligado, tenta o próximo da lista;
//   • toda falha vai para o log da Vercel, em vez de sumir.
//
// Arquivo com "_" na frente: a Vercel não o publica como função.
// ============================================================================

// Em ordem de preferência. Os dois são de produção na Groq hoje.
export const GROQ_MODELOS_PADRAO = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

export function groqModelos(env = process.env) {
  const escolhido = String(env.GROQ_MODEL || '').trim();
  return [...new Set([escolhido, ...GROQ_MODELOS_PADRAO].filter(Boolean))];
}

const ehRaciocinio = m => /gpt-oss/i.test(m);

/* O modelo deixou de existir (ou nunca existiu): vale tentar o próximo.
   Limite de uso (429) também: a Groq conta o limite POR MODELO, então o
   próximo da lista tem a cota dele. Qualquer outro erro (chave, servidor
   fora) não muda trocando de modelo, então sobe direto. */
function modeloIndisponivel(status, err) {
  const cod = String(err?.code || '');
  const msg = String(err?.message || '');
  return cod === 'model_decommissioned' || cod === 'model_not_found'
    || ((status === 400 || status === 404) && /decommission|deprecat|does not exist|not found|no longer supported/i.test(msg));
}

/* ---------------------------------------------------------------------------
   MONITOR DE USO. O plano grátis da Groq tem limite por modelo (por dia e por
   minuto) e, quando estoura, a IA para de responder. Cada pedido soma no dia
   (tabela groq_uso: tokens de entrada, do cache, de saída, segundos de áudio,
   por quem usou) e guarda o que a própria Groq informa do limite
   (groq_limites): pedidos/dia e tokens/minuto vêm nos cabeçalhos de toda
   resposta; tokens/dia só aparece na mensagem do erro 429. O painel mostra em
   Configurações › IA. É só medição: se falhar, a resposta segue normalmente.
   --------------------------------------------------------------------------- */
const inteiro = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : undefined; };

function limitesDosCabecalhos(h, { tokens = true } = {}) {
  if (!h || typeof h.get !== 'function') return {};
  const out = {
    rpd_limite: inteiro(h.get('x-ratelimit-limit-requests')),
    rpd_restante: inteiro(h.get('x-ratelimit-remaining-requests')),
  };
  if (tokens) {
    out.tpm_limite = inteiro(h.get('x-ratelimit-limit-tokens'));
    out.tpm_restante = inteiro(h.get('x-ratelimit-remaining-tokens'));
  }
  return out;
}

// "... on tokens per day (TPD): Limit 200000, Used 199845, Requested 2241 ..."
function limiteDoErro(mensagem) {
  const m = String(mensagem || '').match(/\((TPD|TPM|RPD|RPM|ASH|ASD)\)\s*:\s*Limit\s+(\d+)/i);
  if (!m) return { limite_tipo: 'outro' };
  const tipo = m[1].toUpperCase(), valor = Number(m[2]);
  return { limite_tipo: tipo, ...(tipo === 'TPD' ? { tpd_limite: valor } : tipo === 'TPM' ? { tpm_limite: valor } : tipo === 'RPD' ? { rpd_limite: valor } : {}) };
}

export async function registrarUsoGroq(dados, env = process.env) {
  const url = env.SUPABASE_URL || 'https://mgtetsmcswdtvsgewcen.supabase.co';
  const chave = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!chave || !dados || !dados.modelo) return;
  // só o que veio: a função no banco não mexe no que não foi informado
  const p = Object.fromEntries(Object.entries(dados).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(`${url}/rest/v1/rpc/groq_uso_registrar`, {
      method: 'POST',
      headers: { apikey: chave, Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p }),
      signal: ctrl.signal,
    });
    if (!r.ok) console.error('[groq] monitor de uso: HTTP ' + r.status);
  } catch (err) {
    console.error('[groq] monitor de uso: ' + err.message);
  } finally {
    clearTimeout(t);
  }
}

/* Conversa com a Groq. Devolve { texto, modelo, usage } ou lança Error com
   uma mensagem legível. `maxTokens` é o tamanho da RESPOSTA: nos modelos que
   raciocinam antes de responder (gpt-oss), o raciocínio também consome do
   limite, então a reserva para ele é somada aqui. `raciocinio` ('low',
   'medium', 'high'): quanto o modelo pensa antes de responder — mais
   pensamento, decisões melhores, resposta um pouco mais lenta. `origem`:
   quem pediu (conversa, aprendizado, moviapp, movione), para o monitor. */
/* No plano grátis o limite por minuto é 8.000 tokens, e a Groq confere CADA
   pedido contando o texto enviado mais a reserva da resposta: com 4.096 de
   reserva, uma conversa longa (~4.000 de texto) passava de 8.000 e era
   recusada ("Request too large"). 3.072 cabe e sobra para o raciocínio de
   uma resposta de WhatsApp. */
const RESERVA_RACIOCINIO = { low: 1024, medium: 2048, high: 3072 };
export async function groqChat({ messages, maxTokens = 600, temperature = 0.4, chave, env = process.env, prazoMs = 25000, raciocinio = 'low', origem = 'outro' } = {}) {
  const key = chave || env.GROQ_API_KEY || '';
  if (!key) throw new Error('GROQ_API_KEY não configurada na Vercel.');
  if (!Array.isArray(messages) || !messages.length) throw new Error('Sem mensagens para a IA.');

  let ultimoErro = null, limitado = false;
  for (const modelo of groqModelos(env)) {
    const corpo = { model: modelo, messages, temperature, max_completion_tokens: maxTokens };
    if (ehRaciocinio(modelo)) {
      // por padrão, raciocínio curto (resumos e análises); a conversa com o
      // cliente pede mais. Sem devolver o raciocínio, que só gastaria banda.
      const nivel = RESERVA_RACIOCINIO[raciocinio] ? raciocinio : 'low';
      corpo.reasoning_effort = nivel;
      corpo.include_reasoning = false;
      corpo.max_completion_tokens = maxTokens + RESERVA_RACIOCINIO[nivel];
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), prazoMs);
    let r, d;
    try {
      r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(corpo),
        signal: ctrl.signal,
      });
      d = await r.json().catch(() => ({}));
    } catch (err) {
      clearTimeout(t);
      const msg = err.name === 'AbortError' ? 'A IA demorou demais para responder.' : 'Não consegui falar com a Groq: ' + err.message;
      console.error(`[groq] ${modelo}: ${msg}`);
      throw new Error(msg);
    }
    clearTimeout(t);

    if (!r.ok) {
      const err = d?.error || {};
      console.error(`[groq] ${modelo}: HTTP ${r.status} ${err.code || ''} ${String(err.message || '').slice(0, 200)}`);
      if (modeloIndisponivel(r.status, err)) { ultimoErro = `modelo ${modelo} indisponível`; continue; }
      if (r.status === 401) throw new Error('A Groq recusou a chave (GROQ_API_KEY).');
      if (r.status === 429) {
        limitado = true; ultimoErro = `limite de uso do ${modelo}`;
        await registrarUsoGroq({ modelo, origem, limitados: 1, ...limitesDosCabecalhos(r.headers), ...limiteDoErro(err.message), limite_msg: String(err.message || '').slice(0, 300) }, env);
        continue;
      }
      // pedido maior que o limite por minuto: o outro modelo tem o mesmo limite,
      // então não adianta trocar — quem chamou pode pedir de novo, menor
      if (r.status === 413 || /request too large/i.test(String(err.message || ''))) {
        await registrarUsoGroq({ modelo, origem, limitados: 1, ...limiteDoErro(err.message), limite_msg: String(err.message || '').slice(0, 300) }, env);
        throw new Error('Pedido grande demais para o limite por minuto da Groq.');
      }
      throw new Error(`Groq ${r.status}: ${err.message || 'erro desconhecido'}`);
    }

    // gastou, respondendo ou não: entra na conta do dia
    const uso = d?.usage || {};
    await registrarUsoGroq({ modelo, origem, requisicoes: 1, entrada: inteiro(uso.prompt_tokens), cache: inteiro(uso.prompt_tokens_details?.cached_tokens),
      saida: inteiro(uso.completion_tokens), ...limitesDosCabecalhos(r.headers) }, env);

    const msg = d?.choices?.[0]?.message || {};
    // modelos que pensam "em voz alta" dentro do texto: tira o bloco <think>
    const texto = String(msg.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!texto) {
      console.error(`[groq] ${modelo}: resposta vazia (finish_reason=${d?.choices?.[0]?.finish_reason || '?'})`);
      ultimoErro = 'a IA devolveu uma resposta vazia';
      continue;
    }
    return { texto, modelo, usage: d?.usage || null };
  }
  if (limitado) throw new Error('Limite de uso da Groq atingido. Tente de novo em instantes.');
  throw new Error('IA indisponível: ' + (ultimoErro || 'nenhum modelo respondeu'));
}

// ============================================================================
// TRANSCRIÇÃO DE ÁUDIO — o áudio do cliente vira texto (Whisper, na Groq)
// ----------------------------------------------------------------------------
// Chegam ~77 áudios por mês no MoviTalk. O bot não entendia nenhum e o
// atendente precisava parar para ouvir. Com o texto, o áudio aparece escrito
// no balão, entra na busca e o bot responde como se o cliente tivesse digitado.
//
// O turbo é o mais rápido e o mais barato (a Groq cobra por hora de áudio);
// o v3 cheio fica de reserva se a Groq desligar o primeiro, como aconteceu
// com o modelo de conversa.
export const GROQ_WHISPER_PADRAO = ['whisper-large-v3-turbo', 'whisper-large-v3'];

export function groqModelosAudio(env = process.env) {
  const escolhido = String(env.GROQ_WHISPER_MODEL || '').trim();
  return [...new Set([escolhido, ...GROQ_WHISPER_PADRAO].filter(Boolean))];
}

const EXT_AUDIO = {
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a',
  'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/webm': 'webm', 'audio/flac': 'flac', 'video/mp4': 'mp4', 'video/webm': 'webm',
};

/* O Whisper "ouve" frases em áudio mudo ou só com ruído — em português, as
   legendas de vídeo do YouTube com que ele foi treinado. Nenhum cliente diz
   isso a uma operadora: sai do texto. */
const ALUCINACOES = [
  /legendas?( e transcrições)? (pela|por) comunidade amara\.org/gi,
  /transcrição e legendas?:?[^.!?]*/gi,
  /legendad[oa] por [^.!?]*/gi,
  /inscreva-se no( nosso)? canal[^.!?]*/gi,
  /obrigad[oa] por assistir[^.!?]*/gi,
  /deixe seu like[^.!?]*/gi,
];

/* Áudio → texto. `audio` é Buffer ou base64. Devolve { texto, modelo,
   duracao } — texto vazio quando não há fala reconhecível — ou lança Error
   com mensagem legível. Trecho com cara de silêncio (no_speech_prob alto)
   fica de fora: é nele que o Whisper inventa. */
export async function groqTranscrever({ audio, mimetype = 'audio/ogg', idioma = 'pt', chave, env = process.env, prazoMs = 20000, origem = 'audio' } = {}) {
  const key = chave || env.GROQ_API_KEY || '';
  if (!key) throw new Error('GROQ_API_KEY não configurada na Vercel.');
  const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(String(audio || ''), 'base64');
  if (!buf.length) throw new Error('Áudio vazio.');
  const tipo = String(mimetype || 'audio/ogg').split(';')[0].trim().toLowerCase();
  const ext = EXT_AUDIO[tipo] || 'ogg';

  let ultimoErro = null, limitado = false;
  for (const modelo of groqModelosAudio(env)) {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: tipo }), `audio.${ext}`);
    fd.append('model', modelo);
    fd.append('language', idioma);
    fd.append('response_format', 'verbose_json');
    fd.append('temperature', '0');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), prazoMs);
    let r, d;
    try {
      r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, signal: ctrl.signal,
      });
      d = await r.json().catch(() => ({}));
    } catch (err) {
      clearTimeout(t);
      const msg = err.name === 'AbortError' ? 'A transcrição demorou demais.' : 'Não consegui falar com a Groq: ' + err.message;
      console.error(`[groq] ${modelo}: ${msg}`);
      throw new Error(msg);
    }
    clearTimeout(t);

    if (!r.ok) {
      const err = d?.error || {};
      console.error(`[groq] ${modelo}: HTTP ${r.status} ${err.code || ''} ${String(err.message || '').slice(0, 200)}`);
      if (modeloIndisponivel(r.status, err)) { ultimoErro = `modelo ${modelo} indisponível`; continue; }
      if (r.status === 401) throw new Error('A Groq recusou a chave (GROQ_API_KEY).');
      if (r.status === 429) {
        limitado = true; ultimoErro = `limite de uso do ${modelo}`;
        await registrarUsoGroq({ modelo, origem, limitados: 1, ...limitesDosCabecalhos(r.headers, { tokens: false }), ...limiteDoErro(err.message), limite_msg: String(err.message || '').slice(0, 300) }, env);
        continue;
      }
      if (r.status === 413) throw new Error('Áudio grande demais para transcrever.');
      throw new Error(`Groq ${r.status}: ${err.message || 'erro desconhecido'}`);
    }

    await registrarUsoGroq({ modelo, origem, requisicoes: 1, audio: Number(d?.duration) || 0, ...limitesDosCabecalhos(r.headers, { tokens: false }) }, env);

    const segs = Array.isArray(d?.segments) ? d.segments : null;
    const falados = segs ? segs.filter(s => !(Number(s.no_speech_prob) > 0.6)).map(s => s.text) : [d?.text];
    let texto = falados.join(' ');
    for (const rx of ALUCINACOES) texto = texto.replace(rx, ' ');
    texto = texto.replace(/\s+/g, ' ').trim();
    // sobrou só pontuação: não havia fala
    if (!/[\p{L}\p{N}]/u.test(texto)) texto = '';
    return { texto, modelo, duracao: Number(d?.duration) || null };
  }
  if (limitado) throw new Error('Limite de uso da Groq atingido. Tente de novo em instantes.');
  throw new Error('Transcrição indisponível: ' + (ultimoErro || 'nenhum modelo respondeu'));
}
