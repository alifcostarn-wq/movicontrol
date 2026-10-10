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
   Qualquer outro erro (chave, limite, servidor fora) não muda trocando de
   modelo, então sobe direto. */
function modeloIndisponivel(status, err) {
  const cod = String(err?.code || '');
  const msg = String(err?.message || '');
  return cod === 'model_decommissioned' || cod === 'model_not_found'
    || ((status === 400 || status === 404) && /decommission|deprecat|does not exist|not found|no longer supported/i.test(msg));
}

/* Conversa com a Groq. Devolve { texto, modelo, usage } ou lança Error com
   uma mensagem legível. `maxTokens` é o tamanho da RESPOSTA: nos modelos que
   raciocinam antes de responder (gpt-oss), o raciocínio também consome do
   limite, então a reserva para ele é somada aqui. */
export async function groqChat({ messages, maxTokens = 600, temperature = 0.4, chave, env = process.env, prazoMs = 25000 } = {}) {
  const key = chave || env.GROQ_API_KEY || '';
  if (!key) throw new Error('GROQ_API_KEY não configurada na Vercel.');
  if (!Array.isArray(messages) || !messages.length) throw new Error('Sem mensagens para a IA.');

  let ultimoErro = null;
  for (const modelo of groqModelos(env)) {
    const corpo = { model: modelo, messages, temperature, max_completion_tokens: maxTokens };
    if (ehRaciocinio(modelo)) {
      // raciocínio curto: as respostas aqui são de atendimento e resumo, não
      // de matemática; e sem devolver o raciocínio, que só gastaria banda
      corpo.reasoning_effort = 'low';
      corpo.include_reasoning = false;
      corpo.max_completion_tokens = maxTokens + 1024;
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
      if (r.status === 429) throw new Error('Limite de uso da Groq atingido. Tente de novo em instantes.');
      throw new Error(`Groq ${r.status}: ${err.message || 'erro desconhecido'}`);
    }

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
export async function groqTranscrever({ audio, mimetype = 'audio/ogg', idioma = 'pt', chave, env = process.env, prazoMs = 20000 } = {}) {
  const key = chave || env.GROQ_API_KEY || '';
  if (!key) throw new Error('GROQ_API_KEY não configurada na Vercel.');
  const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(String(audio || ''), 'base64');
  if (!buf.length) throw new Error('Áudio vazio.');
  const tipo = String(mimetype || 'audio/ogg').split(';')[0].trim().toLowerCase();
  const ext = EXT_AUDIO[tipo] || 'ogg';

  let ultimoErro = null;
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
      if (r.status === 429) throw new Error('Limite de uso da Groq atingido. Tente de novo em instantes.');
      if (r.status === 413) throw new Error('Áudio grande demais para transcrever.');
      throw new Error(`Groq ${r.status}: ${err.message || 'erro desconhecido'}`);
    }

    const segs = Array.isArray(d?.segments) ? d.segments : null;
    const falados = segs ? segs.filter(s => !(Number(s.no_speech_prob) > 0.6)).map(s => s.text) : [d?.text];
    let texto = falados.join(' ');
    for (const rx of ALUCINACOES) texto = texto.replace(rx, ' ');
    texto = texto.replace(/\s+/g, ' ').trim();
    // sobrou só pontuação: não havia fala
    if (!/[\p{L}\p{N}]/u.test(texto)) texto = '';
    return { texto, modelo, duracao: Number(d?.duration) || null };
  }
  throw new Error('Transcrição indisponível: ' + (ultimoErro || 'nenhum modelo respondeu'));
}
