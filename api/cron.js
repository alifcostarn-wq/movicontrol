// ============================================================================
// AGENDADOR — o relógio que a régua de cobrança não tinha
// ----------------------------------------------------------------------------
// Até aqui, o único gatilho do cron era o próprio painel: atendimento.html
// cutuca {"acao":"cron"} a cada 3 minutos ENQUANTO alguém tem a tela aberta.
// Duas consequências, as duas medidas em produção:
//
//   • No dia 09/09 a régua não produziu uma linha sequer — foi o dia em que o
//     painel estava travado. Os lembretes de vencimento daquele dia (D-2 e D-1
//     das faturas do dia 10) simplesmente não saíram.
//   • Mesmo com o painel aberto, cada passada tem orçamento de 45 segundos e a
//     régua pausa 8 entre clientes: dá ~6 cobranças por execução. Para as 68
//     faturas que venceram no dia 10, só 30 clientes receberam o lembrete de
//     três dias antes. Os outros 38 souberam da fatura no dia do vencimento.
//
// Este arquivo resolve os dois:
//   1. O cron da Vercel (vercel.json) bate aqui sozinho, sem depender de
//      ninguém ter o painel aberto.
//   2. Quando a passada termina dizendo que ainda há fila (`cobranca.continua`),
//      este endpoint chama a si mesmo para continuar de onde parou. Uma
//      cutucada percorre a base inteira em vez de seis clientes.
//
// Por que não um serviço externo de ping: funciona, mas depende de uma conta
// de terceiro que ninguém lembra de renovar, e some sem avisar. Isto mora no
// mesmo deploy do resto.
//
// As travas contra repetição são as da própria régua e continuam valendo aqui:
// o índice único (fatura_id, etapa_id), o teto diário, o cooldown por cliente
// e o intervalo entre mensagens. Encadear NÃO cobra ninguém duas vezes — só
// deixa a mesma fila andar mais rápido.
// ============================================================================

export const config = { maxDuration: 60 };

// Teto do encadeamento. O limite real de quanto sai por dia é o `limite_diario`
// da configuração de cobrança (150); este número existe só para que um defeito
// futuro em `continua` não vire uma corrente infinita de invocações.
const MAX_ELOS = 25;

function baseDoSite(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

/* Quem pode disparar o agendador.
   - CRON_SECRET definido: exige o Bearer que a própria Vercel manda. É o
     modo estrito, e é o recomendado.
   - Sem CRON_SECRET: aceita o que a Vercel marca como cron e o segredo interno
     que o resto do sistema já usa. Não fica aberto ao mundo. */
function podeDisparar(req) {
  const cronSecret = process.env.CRON_SECRET || '';
  const auth = String(req.headers.authorization || '');
  if (cronSecret) return auth === `Bearer ${cronSecret}`;

  const interno = process.env.ATEND_WEBHOOK_SECRET || '';
  if (interno && req.headers['x-atend-secret'] === interno) return true;

  // a Vercel identifica as próprias execuções agendadas
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  return ua.includes('vercel-cron') || !!req.headers['x-vercel-cron-schedule'];
}

export default async function handler(req, res) {
  if (!podeDisparar(req)) {
    return res.status(401).json({ ok: false, error: 'Não autorizado.' });
  }

  const segredo = process.env.ATEND_WEBHOOK_SECRET || '';
  const base = baseDoSite(req);
  const elo = Math.max(0, Number(req.query?.elo || 0));

  let r = null, erro = null;
  try {
    const resp = await fetch(`${base}/api/atendimento`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(segredo ? { 'x-atend-secret': segredo } : {}),
      },
      body: JSON.stringify({ acao: 'cron' }),
    });
    r = await resp.json().catch(() => null);
    if (!resp.ok) erro = `atendimento respondeu ${resp.status}`;
  } catch (err) {
    erro = String(err.message).slice(0, 200);
  }

  // Ainda tem fila e ainda cabe elo: chama o próximo e devolve. NÃO espera a
  // resposta dele — esperar aninharia a corrente inteira dentro desta
  // invocação e ela morreria no limite de 60 segundos, que é exatamente o
  // problema que estamos resolvendo. O `catch` vazio é proposital: se o
  // próximo elo não subir, a corrente para aqui e a próxima cutucada
  // (cron ou painel) recomeça de onde parou — nada se perde.
  const continua = !!(r && r.cobranca && r.cobranca.continua);
  let proximo = false;
  if (continua && elo + 1 < MAX_ELOS && !erro) {
    proximo = true;
    const url = `${base}/api/cron?elo=${elo + 1}`;
    const disparo = fetch(url, {
      method: 'GET',
      headers: {
        ...(process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
        ...(segredo ? { 'x-atend-secret': segredo } : {}),
      },
    }).catch(() => null);
    // dá tempo de a requisição sair antes de a função congelar, sem esperar
    // o trabalho do outro lado terminar
    await Promise.race([disparo, new Promise(ok => setTimeout(ok, 1500))]);
  }

  return res.status(200).json({
    ok: !erro, elo, proximo_elo: proximo, erro,
    cobranca: r && r.cobranca ? r.cobranca : null,
    resumo: r ? {
      enviados: r.enviados, encerradas_por_inatividade: r.encerradas_por_inatividade,
      bot_parado: r.bot_parado, sync_ixc: r.sync_ixc,
    } : null,
  });
}
