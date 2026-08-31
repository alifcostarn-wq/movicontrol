/* ============================================================================
 * CAMPANHAS — envio manual em massa
 * ----------------------------------------------------------------------------
 * COMO APLICAR: cole o bloco de FUNÇÕES antes de `export default async function
 * handler`, e o bloco de ROTAS dentro do switch de ações (junto das demais).
 * No final há a linha a acrescentar no cron.
 *
 * ESTRATÉGIA CONTRA BLOQUEIO — o desenho todo gira em torno disso:
 *
 *  1. FILA, NÃO RAJADA. O clique só enfileira. Um cron manda de poucos em
 *     poucos. Rajada de centenas de mensagens iguais em segundos é exatamente
 *     o padrão que o antispam do WhatsApp procura.
 *  2. INTERVALO IRREGULAR. 25s fixos é assinatura de robô. Variamos ±40%.
 *  3. SÓ CONTRATO ATIVO. Travado dentro de camp_publico, no banco — não é
 *     opção na tela. Opção que pode ser desmarcada uma hora é desmarcada, e
 *     comunicado para ex-cliente vira denúncia de spam, que pesa muito mais
 *     que volume e derruba o número que atende todo mundo.
 *  4. JANELA DE HORÁRIO. Nada de madrugada.
 *  5. PRAZO, NÃO TETO DIÁRIO. Aviso de manutenção vale para o momento: o que
 *     não sair até o prazo vira EXPIRADO e some da fila. Mensagem que chega no
 *     dia seguinte avisa de algo que já aconteceu — pior que não ter enviado.
 *  6. VARIAÇÃO DO TEXTO. Mensagem idêntica para 600 números é fácil de
 *     detectar; personalizar com o nome já muda a impressão digital.
 *  7. OPT-OUT. Quem responde PARAR sai das próximas.
 *  8. FREIO AUTOMÁTICO. Se as falhas passarem de 15%, a campanha pausa
 *     sozinha — é sinal de que o número já está sendo limitado.
 * ========================================================================== */

/* ---------------------------------------------------------------- FUNÇÕES -- */

/* Intervalo humano: nunca o mesmo valor duas vezes seguidas. */
function campIntervalo(base) {
  // piso de 6s: abaixo disso o padrão fica evidente para o antispam, por mais
  // urgente que seja o aviso
  const b = Math.max(6, Number(base) || 25);
  return Math.round(b * (0.6 + Math.random() * 0.8)) * 1000;   // ±40%
}

/* Pequenas variações no texto para as mensagens não saírem idênticas.
   Não muda o sentido — só evita 600 cópias byte a byte iguais. */
function campVariar(texto, nome) {
  let t = String(texto || '');
  const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
  t = t.replace(/%nomecliente%/gi, primeiro)
       .replace(/\{nome\}/gi, primeiro)
       .replace(/\{primeiro_nome\}/gi, primeiro);
  // saudação conforme a hora, quando o texto começa com uma
  const h = new Date().getHours();
  const saud = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  t = t.replace(/^(bom dia|boa tarde|boa noite)/i, saud);
  return t;
}

function campJanelaOk(c, agora) {
  const dias = Array.isArray(c.dias_semana) && c.dias_semana.length ? c.dias_semana : [1,2,3,4,5,6];
  if (!dias.includes(agora.getDay())) return false;
  const hm = String(agora.getHours()).padStart(2,'0') + ':' + String(agora.getMinutes()).padStart(2,'0');
  return hm >= String(c.janela_ini).slice(0,5) && hm <= String(c.janela_fim).slice(0,5);
}

/* Processa a fila de campanhas. Chamada pelo cron. */
async function processarCampanhas(e) {
  const ativas = await sb(e,
    'atend_campanhas?status=in.(enfileirada,enviando)&select=*&order=criado_em.asc&limit=3');
  if (!ativas || !ativas.length) return { ok: true, campanhas: 0 };

  const agora = new Date();
  const hojeISO = agora.toISOString().slice(0, 10);
  const resumo = [];

  for (const c of ativas) {
    // PRAZO VENCIDO: encerra e marca quem não recebeu. Sem isto a fila
    // continuaria amanhã, avisando de manutenção que já passou.
    if (c.expira_em && new Date(c.expira_em) <= agora) {
      const pend = await sb(e, `atend_campanha_alvos?campanha_id=eq.${c.id}&status=eq.pendente&select=id`);
      const qtd = (pend || []).length;
      if (qtd) {
        await sb(e, `atend_campanha_alvos?campanha_id=eq.${c.id}&status=eq.pendente`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { status: 'expirado', motivo: 'prazo da notificação encerrado' },
        });
      }
      await sb(e, `atend_campanhas?id=eq.${c.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          status: qtd ? 'expirada' : 'concluida', nao_enviados: qtd,
          concluido_em: new Date().toISOString(),
          erro: qtd ? `${qtd} cliente(s) não receberam: o prazo venceu antes.` : null,
        },
      });
      resumo.push({ id: c.id, expirada: true, nao_enviados: qtd });
      continue;
    }

    if (!campJanelaOk(c, agora)) { resumo.push({ id: c.id, pulou: 'fora da janela' }); continue; }

    // O lote acompanha o tempo que RESTA: prazo apertado manda mais por
    // rodada; com folga, mantém o ritmo calmo que protege o número.
    let lote = 8;
    const pend = await sb(e, `atend_campanha_alvos?campanha_id=eq.${c.id}&status=eq.pendente&select=id`);
    const faltam = (pend || []).length;
    if (c.expira_em && faltam) {
      const minRestantes = Math.max(1, (new Date(c.expira_em) - agora) / 60000);
      const porRodada = Math.ceil((faltam / minRestantes) * 2);   // cron a cada ~2min
      lote = Math.max(4, Math.min(20, porRodada));
    }
    const alvos = await sb(e,
      `atend_campanha_alvos?campanha_id=eq.${c.id}&status=eq.pendente&select=*&order=id.asc&limit=${lote}`);
    if (!alvos || !alvos.length) {
      await sb(e, `atend_campanhas?id=eq.${c.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'concluida', concluido_em: new Date().toISOString() },
      });
      resumo.push({ id: c.id, concluida: true });
      continue;
    }

    if (c.status !== 'enviando') {
      await sb(e, `atend_campanhas?id=eq.${c.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'enviando', iniciado_em: c.iniciado_em || new Date().toISOString() },
      });
    }

    let ok = 0, erro = 0;
    for (const a of alvos) {
      try {
        const texto = campVariar(c.texto, a.nome);
        let env;
        if (c.midia_url) {
          env = await waEnviarMidia(e, a.fone, {
            base64: c.midia_url, tipo: c.midia_tipo || 'image',
            nomeArquivo: c.midia_nome || 'arquivo', legenda: texto,
          });
        } else {
          env = await waEnviar(e, a.fone, texto);
        }
        await sb(e, `atend_campanha_alvos?id=eq.${a.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { status: 'enviado', wa_id: idDaEvolution(env), enviado_em: new Date().toISOString() },
        });
        ok++;
      } catch (err) {
        await sb(e, `atend_campanha_alvos?id=eq.${a.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { status: 'erro', motivo: String(err.message).slice(0, 200) },
        });
        erro++;
      }
      await new Promise(r => setTimeout(r, campIntervalo(c.intervalo_seg)));
    }

    const tot = await sb(e, `atend_campanha_alvos?campanha_id=eq.${c.id}&select=status`);
    const env = (tot || []).filter(x => x.status === 'enviado').length;
    const fal = (tot || []).filter(x => x.status === 'erro').length;

    // FREIO: falha acima de 15% com volume relevante é sinal de que o número
    // está sendo limitado. Continuar piora a situação.
    const patch = { enviados: env, falhas: fal };
    if (env + fal >= 20 && fal / (env + fal) > 0.15) {
      patch.status = 'pausada';
      patch.erro = `Pausada automaticamente: ${Math.round(fal/(env+fal)*100)}% de falha. Verifique a conexão do WhatsApp antes de retomar.`;
    }
    await sb(e, `atend_campanhas?id=eq.${c.id}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
    resumo.push({ id: c.id, enviados: ok, falhas: erro, pausada: patch.status === 'pausada' });
  }
  return { ok: true, campanhas: resumo.length, detalhe: resumo };
}

/* ----------------------------------------------------------------- ROTAS -- */
/* Cole dentro do switch(acao), junto das demais rotas.

      case 'campanha.filtros': {
        const bairros = await sb(e, 'rpc/camp_bairros', { method: 'POST', body: {} });
        return res.status(200).json({ ok: true, bairros: bairros || [] });
      }

      // prévia: quantos e quem, ANTES de enfileirar
      case 'campanha.previa': {
        const f = body.filtros || {};
        const alvos = await sb(e, 'rpc/camp_publico', {
          method: 'POST',
          body: { p_bairros: f.bairros || null, p_cidades: f.cidades || null, p_busca: f.busca || null },
        });
        const lista = alvos || [];
        // O operador escolhe o PRAZO; o sistema calcula o ritmo necessário e
        // diz se ele é seguro. Escolher segundos entre mensagens é abstrato —
        // "preciso avisar em 30 min" é a decisão real de quem está no aviso.
        const prazoMin = Math.max(5, Number(body.prazo_min) || 120);
        const total = lista.length;
        const ivNecessario = total ? Math.floor((prazoMin * 60) / total) : 0;
        const iv = Math.max(6, ivNecessario);
        const cabe = ivNecessario >= 6;
        const risco = ivNecessario >= 20 ? 'baixo'
                    : ivNecessario >= 12 ? 'medio'
                    : 'alto';
        return res.status(200).json({
          ok: true, total, amostra: lista.slice(0, 10),
          intervalo: iv, risco, cabe,
          // com ritmo no piso, quantos ficam de fora do prazo
          nao_cabem: cabe ? 0 : Math.max(0, total - Math.floor((prazoMin * 60) / 6)),
          minutos: Math.ceil(total * iv / 60),
        });
      }

      case 'campanha.criar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const texto = String(body.texto || '').trim();
        const nome = String(body.nome || '').trim() || 'Campanha';
        if (!texto) return res.status(400).json({ ok: false, error: 'Escreva a mensagem.' });

        const f = body.filtros || {};
        const alvos = await sb(e, 'rpc/camp_publico', {
          method: 'POST',
          body: { p_bairros: f.bairros || null, p_cidades: f.cidades || null, p_busca: f.busca || null },
        });
        if (!alvos || !alvos.length) {
          return res.status(400).json({ ok: false, error: 'Nenhum cliente com contrato ativo nos filtros escolhidos.' });
        }

        const nova = await sb(e, 'atend_campanhas', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: {
            nome, texto, filtros: f, total: alvos.length,
            midia_url: body.midia_base64 || null, midia_tipo: body.midia_tipo || null,
            midia_nome: body.midia_nome || null,
            intervalo_seg: Math.max(6, Number(body.intervalo_seg) || 25),
            // a notificação morre no prazo: nada atravessa para o dia seguinte
            expira_em: new Date(Date.now() + Math.max(5, Number(body.prazo_min) || 120) * 60000).toISOString(),
            limite_dia: 5000,
            janela_ini: body.janela_ini || '08:00', janela_fim: body.janela_fim || '20:00',
            dias_semana: Array.isArray(body.dias_semana) && body.dias_semana.length ? body.dias_semana : [1,2,3,4,5,6],
            status: body.enfileirar ? 'enfileirada' : 'rascunho',
            criado_por: user.id,
          },
        });
        const camp = Array.isArray(nova) ? nova[0] : nova;

        // grava os alvos em lotes: 600 linhas num POST só estoura o limite
        for (let i = 0; i < alvos.length; i += 400) {
          await sb(e, 'atend_campanha_alvos', {
            method: 'POST', prefer: 'return=minimal',
            body: alvos.slice(i, i + 400).map(a => ({
              campanha_id: camp.id, cliente_ixc_id: a.cliente_ixc_id,
              nome: a.nome, fone: a.fone, bairro: a.bairro,
            })),
          });
        }
        return res.status(200).json({ ok: true, campanha: camp, total: alvos.length });
      }

      case 'campanha.listar': {
        const itens = await sb(e, 'atend_campanhas?select=*&order=criado_em.desc&limit=50');
        return res.status(200).json({ ok: true, campanhas: itens || [] });
      }

      case 'campanha.detalhe': {
        const id = Number(body.id);
        const c = await sbUm(e, `atend_campanhas?id=eq.${id}&select=*`);
        const alvos = await sb(e, `atend_campanha_alvos?campanha_id=eq.${id}&select=*&order=id.asc&limit=1000`);
        return res.status(200).json({ ok: true, campanha: c, alvos: alvos || [] });
      }

      case 'campanha.status': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const id = Number(body.id);
        const novo = String(body.status || '');
        if (!['enfileirada','pausada','cancelada'].includes(novo)) {
          return res.status(400).json({ ok: false, error: 'status inválido.' });
        }
        await sb(e, `atend_campanhas?id=eq.${id}`, {
          method: 'PATCH', prefer: 'return=minimal', body: { status: novo, erro: null },
        });
        return res.status(200).json({ ok: true });
      }

      case 'campanha.executar': {
        if (!user.admin) return res.status(403).json({ ok: false, error: 'Apenas administradores.' });
        const r = await processarCampanhas(e);
        return res.status(200).json(r);
      }

      case 'campanha.optout': {
        const fone = normalizarFone(String(body.fone || ''));
        if (!fone) return res.status(400).json({ ok: false, error: 'Telefone obrigatório.' });
        if (body.remover) {
          await sb(e, `atend_campanha_optout?fone=eq.${fone}`, { method: 'DELETE', prefer: 'return=minimal' });
        } else {
          await sb(e, 'atend_campanha_optout?on_conflict=fone', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: { fone, motivo: body.motivo || null },
          });
        }
        return res.status(200).json({ ok: true });
      }
*/

/* ------------------------------------------------------------------ CRON -- */
/* Dentro de tratarCron(), antes do return, acrescente:

  let campanhas = null;
  try { campanhas = await processarCampanhas(e); }
  catch (err) { console.error('[campanhas]', err.message); campanhas = { erro: err.message }; }

   e inclua `campanhas` no objeto de retorno.
*/
