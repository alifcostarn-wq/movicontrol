// api/assinatura-propria.js - Sistema PRÓPRIO de assinatura eletrônica
// Armazenamento: Cloudflare R2 (bucket movionfotos) via aws4fetch (biblioteca S3-compatível
// recomendada pela própria documentação da Cloudflare para ambientes serverless)
//
// Fluxo: admin cria um "lote" com 1+ documentos preenchidos -> cliente revisa no MoviApp,
// confirma seus dados e tira selfie com RG/CNH -> lote fica "assinado".
//
// Dependência (adicionar ao package.json do projeto): aws4fetch
//   npm install aws4fetch
//
// Env vars necessárias:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (metadados/registros)
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET=movionfotos

import { AwsClient } from 'aws4fetch';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import crypto from 'crypto';

// maxDuration: assinar é a parte cara. Para CADA documento do lote o servidor
// baixa o original do R2, refaz o PDF com a página de certificado (pdf-lib) e
// sobe de volta — com três documentos e uma função fria, os 10s padrão do
// plano estouram no meio e o cliente vê "não deu para assinar" depois de ter
// tirado a selfie. sizeLimit: a selfie e os PDFs viajam em base64, que passa
// folgado do 1MB padrão.
export const config = { api: { bodyParser: { sizeLimit: '4mb' } }, maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-target');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método não permitido' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mgtetsmcswdtvsgewcen.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
  const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
  const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
  const R2_BUCKET = process.env.R2_BUCKET || 'movionfotos';

  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ ok: false, error: 'Config Supabase ausente' });
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY || !R2_SECRET_KEY) return res.status(500).json({ ok: false, error: 'Config R2 ausente (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)' });

  const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const r2 = new AwsClient({ accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY });

  const { action } = req.body || {};
  if (!action) return res.status(400).json({ ok: false, error: 'action obrigatória' });

  // Ações do LINK PÚBLICO: o cliente recebe o endereço no WhatsApp, clica e
  // assina no próprio navegador. Não passam por Supabase Auth de propósito —
  // quem clica é o cliente, que na maioria dos casos ainda não tem o MoviApp.
  // Quem autentica aqui é o token do link: 32 bytes sorteados, guardados num
  // único lote e com prazo de validade. A checagem fica ANTES da exigência de
  // Authorization para que a falta do cabeçalho não derrube o cliente na porta.
  const ACOES_PUBLICAS = new Set(['link_abrir', 'link_assinar']);
  const acaoPublica = ACOES_PUBLICAS.has(action);

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!acaoPublica && !token) return res.status(401).json({ ok: false, error: 'Token ausente' });
  const target = req.headers['x-target'] || 'admin';

  let userId = null;
  if (!acaoPublica) {
    try {
      const uResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_KEY }
      });
      if (!uResp.ok) return res.status(401).json({ ok: false, error: 'Token inválido' });
      userId = (await uResp.json()).id;
    } catch (e) {
      return res.status(401).json({ ok: false, error: 'Falha na validação do token' });
    }
  }

  async function sb(path, opts = {}) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...opts,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: opts.prefer || 'return=representation',
        ...(opts.headers || {})
      }
    });
    const txt = await r.text();
    let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
    return { ok: r.ok, status: r.status, data };
  }

  // Upload direto (PUT) via aws4fetch - assina e envia numa chamada só
  async function r2Upload(key, buffer, contentType) {
    const url = `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;
    const r = await r2.fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: buffer });
    if (!r.ok) return { ok: false, error: `R2 upload falhou (${r.status}): ${await r.text()}` };
    return { ok: true, key };
  }

  // Download de um objeto do R2 (para reprocessar o PDF original na hora de assinar)
  async function r2Get(key) {
    const url = `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;
    const r = await r2.fetch(url, { method: 'GET' });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  }

  // Monta a página final de "Relatório de Assinatura" (padrão do mercado) e anexa ao PDF original
  // Gera código de verificação legível: MOV-2026-XXXX-XXXX (sem caracteres ambíguos)
  function gerarCodigoVerificacao(data) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I,O,0,1
    const bloco = () => Array.from({ length: 4 }, () => chars[crypto.randomBytes(1)[0] % chars.length]).join('');
    return `MOV-${data.getFullYear()}-${bloco()}-${bloco()}`;
  }

  async function gerarPdfAssinado({ originalBytes, hashOriginal, documentoNome, signer, dataAssinatura, ip, userAgent, selfieBuf, codigoVerificacao, geoTexto, meio }) {
    const doc = await PDFDocument.load(originalBytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);

    const page = doc.addPage([595.28, 841.89]); // A4
    const M = 50;
    let y = 780;
    const gray = rgb(0.35, 0.35, 0.4);
    const dark = rgb(0.1, 0.1, 0.18);
    const azul = rgb(0.231, 0.243, 0.847);

    page.drawText('Relatório de Assinatura', { x: M, y, size: 18, font: fontBold, color: dark });
    y -= 30;
    page.drawLine({ start: { x: M, y }, end: { x: 545, y }, thickness: 1, color: rgb(0.85, 0.85, 0.9) });
    y -= 24;

    const linha = (label, valor, size = 10) => {
      page.drawText(label, { x: M, y, size, font: fontBold, color: dark });
      const w = fontBold.widthOfTextAtSize(label, size);
      page.drawText(' ' + (valor || ''), { x: M + w, y, size, font, color: gray });
      y -= 17;
    };

    linha('Documento:', documentoNome);
    linha('Hash do documento original (SHA-256):', hashOriginal.slice(0, 48) + '...');
    y -= 10;
    linha('Signatário:', signer.nome);
    linha('CPF:', signer.cpf);
    linha('Data/hora da assinatura:', dataAssinatura);
    linha('Localização (geo):', geoTexto || 'Não informada');
    linha('Dispositivo:', (userAgent || '').slice(0, 80));
    linha('Endereço IP:', ip || '');
    // por qual porta o cliente assinou. Quem lê o contrato meses depois
    // precisa saber se veio do app ou de um link mandado no WhatsApp.
    if (meio) linha('Meio de assinatura:', meio);
    y -= 8;

    // Código de verificação em destaque (caixa)
    if (codigoVerificacao) {
      const boxH = 30;
      page.drawRectangle({ x: M, y: y - boxH, width: 300, height: boxH, color: rgb(0.93, 0.94, 1), borderColor: azul, borderWidth: 1 });
      page.drawText('Código de verificação:', { x: M + 10, y: y - 12, size: 8, font: fontBold, color: gray });
      page.drawText(codigoVerificacao, { x: M + 10, y: y - 24, size: 13, font: fontBold, color: azul });
      y -= (boxH + 18);
    }

    // foto (selfie) embutida
    if (selfieBuf) {
      try {
        const selfieClean = new Uint8Array(selfieBuf); // evita bug de offset de pool do Buffer do Node
        const img = await doc.embedJpg(selfieClean);
        const w = 140, h = (img.height / img.width) * 140;
        page.drawImage(img, { x: M, y: y - h, width: w, height: h });
        // "assinatura" estilizada (nome em itálico), ao lado da foto
        page.drawText(signer.nome, { x: M + w + 30, y: y - h / 2, size: 20, font: fontItalic, color: dark });
        page.drawLine({ start: { x: M + w + 30, y: y - h / 2 - 8 }, end: { x: M + w + 220, y: y - h / 2 - 8 }, thickness: 0.5, color: gray });
        page.drawText(signer.nome + ' - CPF ' + signer.cpf, { x: M + w + 30, y: y - h / 2 - 22, size: 8, font, color: gray });
        y -= (h + 24);
      } catch (e) { /* selfie não é JPEG válido - segue sem foto */ }
    }

    // Selo visual de autenticidade
    const seloY = Math.max(y - 10, 90);
    const seloW = 495, seloH = 54;
    page.drawRectangle({ x: M, y: seloY - seloH, width: seloW, height: seloH, color: rgb(0.231, 0.243, 0.847), opacity: 0.06, borderColor: azul, borderWidth: 1.2 });
    // check vetorial (✓ desenhado com 2 linhas, evita problema de encoding da fonte)
    page.drawLine({ start: { x: M + 16, y: seloY - 21 }, end: { x: M + 20, y: seloY - 25 }, thickness: 1.6, color: azul });
    page.drawLine({ start: { x: M + 20, y: seloY - 25 }, end: { x: M + 27, y: seloY - 15 }, thickness: 1.6, color: azul });
    page.drawText('DOCUMENTO ASSINADO ELETRONICAMENTE', { x: M + 34, y: seloY - 22, size: 11, font: fontBold, color: azul });
    page.drawText('MoviOn Internet - Allison Costa de Souza-ME · CNPJ 18.757.155/0001-32 · Ato Anatel 7.025', { x: M + 16, y: seloY - 36, size: 7.5, font, color: gray });
    page.drawText('Autenticado por selfie com documento, hash SHA-256, IP e registro de data/hora.', { x: M + 16, y: seloY - 47, size: 7.5, font, color: gray });

    page.drawLine({ start: { x: M, y: 40 }, end: { x: 545, y: 40 }, thickness: 0.5, color: rgb(0.9, 0.9, 0.93) });
    page.drawText('MoviOn Internet - assinatura eletrônica registrada internamente' + (codigoVerificacao ? '  ·  Verificação: ' + codigoVerificacao : ''), { x: M, y: 28, size: 8, font, color: gray });

    return Buffer.from(await doc.save());
  }

  /* Cidade e UF vêm do IXC como id numérico quando a tradução ainda não
     alcançou o cadastro. "1161" não é cidade: melhor em branco. */
  function soNomeDeLugar(v) {
    const s = String(v == null ? '' : v).trim();
    return /^\d+$/.test(s) ? '' : s;
  }

  async function r2SignedUrl(key, expiresIn = 3600) {
    if (!key) return null;
    const url = new URL(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
    url.searchParams.set('X-Amz-Expires', String(expiresIn));
    const signed = await r2.sign(new Request(url, { method: 'GET' }), { aws: { signQuery: true } });
    return signed.url;
  }

  /* ═══════════ MOTOR DE ASSINATURA — uma porta só ═══════════
     O MoviApp e o link do WhatsApp chamam ISTO. O que muda entre os dois é
     como o cliente prova que é ele antes de chegar aqui (sessão do app x
     token do link); o que acontece com o documento — selfie no R2, PDF
     refeito com o certificado, hash do original e do assinado, carimbo de
     IP/hora/geo — é exatamente o mesmo. Um contrato assinado não pode
     depender de por qual porta o cliente entrou. */
  async function assinarLote({ loteId, clienteId, dados, selfieBase64, geo, origem }) {
    const lote = await sb(`assinatura_lotes?id=eq.${loteId}&select=id,status,codigo_verificacao`);
    if (!lote.ok || !lote.data?.length) return { erro: 'Lote não encontrado', status: 404 };
    if (lote.data[0].status === 'assinado') {
      return { ja_assinado: true, codigo_verificacao: lote.data[0].codigo_verificacao };
    }

    // 1) sobe a selfie
    const selfieKey = `assinaturas/selfies/${clienteId}/${loteId}_${Date.now()}.jpg`;
    const selfieBuf = Buffer.from(selfieBase64, 'base64');
    const upSelfie = await r2Upload(selfieKey, selfieBuf, 'image/jpeg');
    if (!upSelfie.ok) return { erro: upSelfie.error, status: 500 };

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;
    const agora = new Date();
    const dataAssinaturaFmt = agora.toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }) + ' (Horário de Brasília)';

    // código de verificação único e legível: MOV-AAAA-XXXX-XXXX
    const cod = lote.data[0].codigo_verificacao || gerarCodigoVerificacao(agora);

    // geolocalização (opcional, veio do navegador com consentimento)
    const geoLat = (geo && typeof geo.lat === 'number') ? geo.lat : null;
    const geoLng = (geo && typeof geo.lng === 'number') ? geo.lng : null;
    const geoPrec = (geo && typeof geo.precisao === 'number') ? geo.precisao : null;
    const geoTexto = (geoLat !== null && geoLng !== null)
      ? `${geoLat.toFixed(6)}, ${geoLng.toFixed(6)}` + (geoPrec ? ` (±${Math.round(geoPrec)}m)` : '')
      : 'Não informada pelo dispositivo';

    // 2) para cada documento do lote: baixa o original, gera o PDF final com certificado, sobe
    const docs = await sb(`contratos_assinatura?lote_id=eq.${loteId}&select=id,documento_nome,documento_url`);
    for (const d of (docs.data || [])) {
      if (!d.documento_url) continue;
      const originalBytes = await r2Get(d.documento_url);
      if (!originalBytes) continue;
      const hashOriginal = crypto.createHash('sha256').update(originalBytes).digest('hex');

      const finalBytes = await gerarPdfAssinado({
        originalBytes, hashOriginal, documentoNome: d.documento_nome,
        signer: { nome: dados.nome, cpf: dados.cpf },
        dataAssinatura: dataAssinaturaFmt, ip, userAgent: ua, selfieBuf,
        codigoVerificacao: cod, geoTexto,
        meio: origem === 'link_whatsapp'
          ? 'Link pessoal enviado por WhatsApp, aberto no navegador do cliente'
          : 'Aplicativo MoviApp, com o cliente logado na própria conta'
      });

      // hash do PDF FINAL assinado (detecta adulteração posterior)
      const hashAssinado = crypto.createHash('sha256').update(finalBytes).digest('hex');

      const assinadoKey = `assinaturas/contratos-assinados/${clienteId}/${loteId}_${d.id}.pdf`;
      const upFinal = await r2Upload(assinadoKey, finalBytes, 'application/pdf');
      if (upFinal.ok) {
        await sb(`contratos_assinatura?id=eq.${d.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ documento_assinado_url: assinadoKey, hash_original: hashOriginal, hash_assinado: hashAssinado, status: 'assinado', assinado_em: agora.toISOString() })
        });
      }
    }

    // 3) marca o lote como assinado. O link, se houve um, morre junto: expirar
    //    no mesmo instante é o que impede o endereço de circular no WhatsApp
    //    depois de assinado, abrindo o contrato para quem receber o repasse.
    const updLote = await sb(`assinatura_lotes?id=eq.${loteId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'assinado', dados_confirmados: { ...dados, origem: origem || 'moviapp' }, selfie_url: selfieKey,
        ip, user_agent: ua, assinado_em: agora.toISOString(),
        codigo_verificacao: cod, geo_lat: geoLat, geo_lng: geoLng, geo_precisao: geoPrec,
        link_expira_em: agora.toISOString()
      })
    });
    if (!updLote.ok) return { erro: 'Falha ao atualizar lote', status: 500 };

    return { codigo_verificacao: cod };
  }

  /* Token do link: 32 bytes de aleatoriedade criptográfica em base64url. É a
     única credencial que o cliente apresenta, então tem que ser grande demais
     para ser adivinhado e curto o suficiente para caber numa mensagem. */
  function gerarTokenLink() {
    return crypto.randomBytes(32).toString('base64url');
  }

  const LINK_DIAS = Number(process.env.ASSINATURA_LINK_DIAS || 30);

  /* De onde sai o endereço que o cliente vai ver.

     ASSINATURA_BASE_URL manda em tudo, e é por ela que se troca o domínio
     sem tocar em código: apontado um "assinar.movion.com.br" para o
     projeto, o link deixa de dizer "movicontrol" para todo cliente que
     recebe um contrato. Sem essa variável o endereço herda o host de quem
     pediu — que é o painel do atendente, ou seja, o domínio do sistema. */
  function baseDoLink() {
    if (process.env.ASSINATURA_BASE_URL) return String(process.env.ASSINATURA_BASE_URL).replace(/\/+$/, '');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host) return `https://${host}`;
    return 'https://movicontrol.vercel.app';
  }

  try {
    // ══════════════ LINK PÚBLICO (WhatsApp) ══════════════
    // Sem sessão, sem app, sem cadastro: o cliente clica no endereço que
    // recebeu e assina. O token é a credencial — vale para UM lote, tem
    // prazo e morre no instante em que a assinatura é registrada.
    if (acaoPublica) {
      const lt = String(req.body.link_token || '').trim();
      // 43 chars é o tamanho de 32 bytes em base64url. Recusar antes de ir ao
      // banco evita transformar a rota num varredor de tokens.
      if (!lt || lt.length < 20 || lt.length > 80 || !/^[A-Za-z0-9_-]+$/.test(lt)) {
        return res.status(404).json({ ok: false, error: 'Link inválido.' });
      }

      const lr = await sb(`assinatura_lotes?link_token=eq.${encodeURIComponent(lt)}&select=id,cliente_id,status,codigo_verificacao,assinado_em,link_expira_em,link_aberto_em`);
      if (!lr.ok || !lr.data?.length) return res.status(404).json({ ok: false, error: 'Link inválido ou já encerrado.' });
      const lote = lr.data[0];

      if (lote.status === 'assinado') {
        return res.status(200).json({
          ok: true, ja_assinado: true,
          codigo_verificacao: lote.codigo_verificacao, assinado_em: lote.assinado_em
        });
      }
      if (lote.link_expira_em && new Date(lote.link_expira_em) < new Date()) {
        return res.status(410).json({ ok: false, expirado: true, error: 'Este link expirou. Peça um novo para o atendimento.' });
      }

      if (action === 'link_abrir') {
        // primeiro clique fica registrado: é a prova de que o documento foi
        // aberto antes de assinado, e é o que o atendente vê no painel
        if (!lote.link_aberto_em) {
          await sb(`assinatura_lotes?id=eq.${lote.id}`, {
            method: 'PATCH', prefer: 'return=minimal',
            body: JSON.stringify({ link_aberto_em: new Date().toISOString() })
          });
        }
        const [cli, docs] = await Promise.all([
          sb(`clientes?id=eq.${lote.cliente_id}&select=nome,cnpj,endereco,numero,bairro,cidade,uf,cep`),
          sb(`contratos_assinatura?lote_id=eq.${lote.id}&select=id,documento_nome,conteudo_html_final&order=id.asc`),
        ]);
        const c = cli.data?.[0] || {};
        return res.status(200).json({
          ok: true,
          lote: { id: lote.id, status: lote.status },
          // só o que a tela precisa mostrar e o cliente vai confirmar — o
          // cadastro inteiro não tem por que atravessar um link público
          cliente: {
            nome: c.nome || '', cpf: c.cnpj || '',
            endereco: [c.endereco, c.numero].filter(Boolean).join(', '),
            // id do IXC nunca sobe como cidade: o cliente está conferindo os
            // dados que vão para a assinatura dele
            bairro: c.bairro || '', cidade: soNomeDeLugar(c.cidade),
            uf: soNomeDeLugar(c.uf), cep: c.cep || '',
          },
          documentos: docs.data || [],
        });
      }

      if (action === 'link_assinar') {
        const { dados_confirmados, selfie_base64, geo } = req.body;
        if (!dados_confirmados || !selfie_base64) {
          return res.status(400).json({ ok: false, error: 'Confirme seus dados e envie a selfie.' });
        }
        const r = await assinarLote({
          loteId: lote.id, clienteId: lote.cliente_id, dados: dados_confirmados,
          selfieBase64: selfie_base64, geo, origem: 'link_whatsapp'
        });
        if (r.erro) return res.status(r.status || 500).json({ ok: false, error: r.erro });
        return res.status(200).json({ ok: true, ja_assinado: !!r.ja_assinado, codigo_verificacao: r.codigo_verificacao });
      }

      // Trava: uma ação pública que caia daqui seguiria para os ramos que
      // esperam userId — e userId é null quando não houve login. Se alguém um
      // dia acrescentar um nome a ACOES_PUBLICAS sem tratar aqui, para nesta
      // linha em vez de entrar sem sessão onde a sessão é obrigatória.
      return res.status(400).json({ ok: false, error: 'Ação desconhecida: ' + action });
    }

    // ══════════════ TARGET: CLIENTE (MoviApp) ══════════════
    if (target === 'cliente') {
      const ca = await sb(`clientes_app?id=eq.${userId}&select=cliente_id`);
      if (!ca.ok || !ca.data || !ca.data.length) return res.status(403).json({ ok: false, error: 'Cliente não vinculado' });
      const clienteId = ca.data[0].cliente_id;

      if (action === 'meus_lotes') {
        const r = await sb(`assinatura_lotes?cliente_id=eq.${clienteId}&select=id,status,criado_em,assinado_em&order=criado_em.desc`);
        return res.status(200).json({ ok: true, lotes: r.data || [] });
      }

      if (action === 'lote_detalhe') {
        const { lote_id } = req.body;
        if (!lote_id) return res.status(400).json({ ok: false, error: 'lote_id obrigatório' });
        const lote = await sb(`assinatura_lotes?id=eq.${lote_id}&cliente_id=eq.${clienteId}&select=*`);
        if (!lote.ok || !lote.data?.length) return res.status(404).json({ ok: false, error: 'Lote não encontrado' });
        const docs = await sb(`contratos_assinatura?lote_id=eq.${lote_id}&select=id,documento_nome,conteudo_html_final,documento_url,status`);
        return res.status(200).json({ ok: true, lote: lote.data[0], documentos: docs.data || [] });
      }

      if (action === 'confirmar_assinatura') {
        const { lote_id, dados_confirmados, selfie_base64, geo } = req.body;
        if (!lote_id || !dados_confirmados || !selfie_base64) return res.status(400).json({ ok: false, error: 'lote_id, dados_confirmados e selfie_base64 obrigatórios' });

        // o lote tem que ser DESTE cliente: a sessão do app diz quem ele é
        const meu = await sb(`assinatura_lotes?id=eq.${lote_id}&cliente_id=eq.${clienteId}&select=id`);
        if (!meu.ok || !meu.data?.length) return res.status(404).json({ ok: false, error: 'Lote não encontrado' });

        const r = await assinarLote({
          loteId: lote_id, clienteId, dados: dados_confirmados,
          selfieBase64: selfie_base64, geo, origem: 'moviapp'
        });
        if (r.erro) return res.status(r.status || 500).json({ ok: false, error: r.erro });
        if (r.ja_assinado) return res.status(200).json({ ok: true, ja_assinado: true, codigo_verificacao: r.codigo_verificacao });
        return res.status(200).json({ ok: true, codigo_verificacao: r.codigo_verificacao });
      }

      return res.status(400).json({ ok: false, error: 'Ação inválida para cliente' });
    }

    // ══════════════ TARGET: EQUIPE (MoviControl e MoviTalk) ══════════════
    // O MoviTalk entra por aqui com x-target:atendimento. Ele usa o MESMO motor
    // de assinatura do MoviControl — mesma tabela, mesmo PDF, mesmo certificado,
    // mesmo bucket — porque um contrato assinado não pode depender de por qual
    // tela da casa ele foi gerado.
    const perfil = await sb(`perfis?id=eq.${userId}&select=perfil,atendimento`);
    const p0 = perfil.data?.[0];
    const ehGestor = !!p0 && ['admin', 'operador'].includes(p0.perfil);
    if (!perfil.ok || !p0) return res.status(403).json({ ok: false, error: 'Perfil não encontrado' });
    if (target === 'atendimento') {
      // mesma regra do login do MoviTalk: quem atende, assina.
      if (!p0.atendimento && !ehGestor) {
        return res.status(403).json({ ok: false, error: 'Usuário sem acesso ao Centro de Atendimento' });
      }
    } else if (!ehGestor) {
      return res.status(403).json({ ok: false, error: 'Acesso restrito a administradores' });
    }

    // O MoviTalk só conhece o cliente pelo id do IXC (é o que fica gravado na
    // conversa). O MoviControl conhece pelo id local. Os dois entram aqui.
    async function resolverClienteId(b) {
      if (b.cliente_id) return { id: Number(b.cliente_id) };
      const ixc = String(b.cliente_ixc_id ?? '').trim();
      if (!ixc) return { erro: 'cliente_id ou cliente_ixc_id obrigatório' };
      const r = await sb(`clientes?ixc_id=eq.${encodeURIComponent(ixc)}&select=id,nome&limit=1`);
      if (!r.ok) return { erro: 'Falha ao consultar o cadastro' };
      if (!r.data?.length) return { erro: `Cliente do IXC #${ixc} ainda não foi importado para o MoviOne` };
      return { id: r.data[0].id, nome: r.data[0].nome };
    }

    // Uma chamada só devolve tudo que a tela de assinatura precisa. São três
    // consultas que sempre andam juntas e, numa função serverless que acabou de
    // acordar, três idas e voltas custam mais que a soma das três queries.
    if (action === 'painel_assinatura') {
      const alvo = await resolverClienteId(req.body || {});
      if (alvo.erro) return res.status(400).json({ ok: false, error: alvo.erro });
      const [cli, mods, equips] = await Promise.all([
        sb(`clientes?id=eq.${alvo.id}&select=id,nome,cnpj,ie,endereco,numero,bairro,cidade,uf,cep,cep_full,whatsapp,tel1,ixc_id`),
        sb('modelos_documento?ativo=eq.true&assinavel=eq.true&select=id,nome,categoria,conteudo_html&order=ordem.asc'),
        sb(`campo_comodato?cliente_id=eq.${alvo.id}&status=eq.ativo&select=id,serial,mac,modelo,status,campo_estoque(nome,categoria)`),
      ]);
      const equipamentos = (equips.data || []).map(e => ({
        tipo: e.campo_estoque?.categoria || 'Equipamento',
        nome: e.campo_estoque?.nome || '',
        modelo: e.modelo || '', serial: e.serial || '', mac: e.mac || '',
      }));
      return res.status(200).json({
        ok: true, cliente: cli.data?.[0] || null,
        modelos: mods.data || [], equipamentos,
      });
    }

    if (action === 'listar_lotes') {
      const alvo = await resolverClienteId(req.body || {});
      if (alvo.erro) return res.status(400).json({ ok: false, error: alvo.erro });
      const cliente_id = alvo.id;
      const lotes = await sb(`assinatura_lotes?cliente_id=eq.${cliente_id}&select=*&order=criado_em.desc`);
      if (!lotes.ok) return res.status(500).json({ ok: false, error: 'Erro ao consultar lotes' });
      const out = [];
      for (const l of (lotes.data || [])) {
        const docs = await sb(`contratos_assinatura?lote_id=eq.${l.id}&select=id,documento_nome,documento_url,documento_assinado_url,status`);
        const docsComLink = [];
        for (const d of (docs.data || [])) {
          const chaveParaLink = d.documento_assinado_url || d.documento_url;
          docsComLink.push({ ...d, documento_url: await r2SignedUrl(chaveParaLink), assinado_final: !!d.documento_assinado_url });
        }
        // o token do link não sobe para a tela: quem precisa do endereço pede
        // por gerar_link. O que o painel mostra é o ESTADO do link — se existe
        // e se o cliente já abriu — que é o que responde "ele recebeu?"
        const { link_token, ...semSegredo } = l;
        out.push({
          ...semSegredo, selfie_url: await r2SignedUrl(l.selfie_url), documentos: docsComLink,
          link_ativo: !!link_token && (!l.link_expira_em || new Date(l.link_expira_em) > new Date()),
        });
      }
      return res.status(200).json({ ok: true, lotes: out });
    }

    /* Link de assinatura para mandar no WhatsApp. Existe porque o MoviApp
       ainda não está na mão de todo cliente: quem não tem o app precisa de um
       caminho que funcione com o que ele já tem, que é o navegador do celular.
       Chamar duas vezes NÃO gera dois links — devolve o mesmo, com a validade
       renovada. Dois endereços vivos para o mesmo contrato seria o atendente
       reenviando o link e matando o que o cliente já tinha aberto. */
    if (action === 'gerar_link') {
      const loteId = Number(req.body.lote_id);
      if (!loteId) return res.status(400).json({ ok: false, error: 'lote_id obrigatório' });
      const lr = await sb(`assinatura_lotes?id=eq.${loteId}&select=id,status,link_token,link_expira_em,link_aberto_em`);
      if (!lr.ok || !lr.data?.length) return res.status(404).json({ ok: false, error: 'Lote não encontrado' });
      const lote = lr.data[0];
      if (lote.status === 'assinado') return res.status(400).json({ ok: false, error: 'Este lote já foi assinado.' });

      const agora = new Date();
      const expira = new Date(agora.getTime() + LINK_DIAS * 86400000);
      const tokenLink = lote.link_token || gerarTokenLink();
      const patch = { link_token: tokenLink, link_expira_em: expira.toISOString(), link_enviado_em: agora.toISOString() };
      if (!lote.link_criado_em) patch.link_criado_em = agora.toISOString();
      const up = await sb(`assinatura_lotes?id=eq.${loteId}`, {
        method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch)
      });
      if (!up.ok) return res.status(500).json({ ok: false, error: 'Falha ao gerar o link' });

      return res.status(200).json({
        ok: true,
        // /a/<token>: o endereço vai ser lido em voz alta, digitado errado e
        // olhado com desconfiança por quem recebe um contrato. Quanto menos
        // ele parecer um link de rastreio, melhor. A forma antiga
        // (/assinar?t=…) continua funcionando para links já enviados.
        url: `${baseDoLink()}/a/${tokenLink}`,
        expira_em: expira.toISOString(),
        reaproveitado: !!lote.link_token,
        aberto_em: lote.link_aberto_em || null,
      });
    }

    if (action === 'upload_pdf') {
      const { nome_arquivo, pdf_base64 } = req.body;
      if (!nome_arquivo || !pdf_base64) return res.status(400).json({ ok: false, error: 'nome_arquivo e pdf_base64 obrigatórios' });
      const alvo = await resolverClienteId(req.body || {});
      if (alvo.erro) return res.status(400).json({ ok: false, error: alvo.erro });
      const cliente_id = alvo.id;
      const key = `assinaturas/contratos/${cliente_id}/${Date.now()}_${nome_arquivo.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const buf = Buffer.from(pdf_base64, 'base64');
      const up = await r2Upload(key, buf, 'application/pdf');
      if (!up.ok) return res.status(500).json({ ok: false, error: up.error });
      return res.status(200).json({ ok: true, path: key, bytes: buf.length });
    }

    if (action === 'criar_lote') {
      const { ixc_contrato_id, documentos } = req.body;
      if (!Array.isArray(documentos) || !documentos.length) {
        return res.status(400).json({ ok: false, error: 'documentos[] obrigatório' });
      }
      const alvo = await resolverClienteId(req.body || {});
      if (alvo.erro) return res.status(400).json({ ok: false, error: alvo.erro });
      const cliente_id = alvo.id;
      const lote = await sb('assinatura_lotes', {
        method: 'POST',
        body: JSON.stringify({ cliente_id, ixc_contrato_id: ixc_contrato_id || null, status: 'pendente', codigo_verificacao: gerarCodigoVerificacao(new Date()) })
      });
      if (!lote.ok || !lote.data?.[0]?.id) return res.status(500).json({ ok: false, error: 'Falha ao criar lote' });
      const loteId = lote.data[0].id;

      for (const doc of documentos) {
        await sb('contratos_assinatura', {
          method: 'POST',
          body: JSON.stringify({
            cliente_id, ixc_contrato_id: ixc_contrato_id || null, lote_id: loteId,
            documento_nome: doc.nome || null,
            conteudo_html_final: doc.conteudo_html_final || null,
            documento_url: doc.documento_url || null,
            status: 'pendente'
          })
        });
      }
      return res.status(200).json({ ok: true, lote_id: loteId });
    }

    return res.status(400).json({ ok: false, error: 'Ação desconhecida: ' + action });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Erro interno: ' + (e.message || e) });
  }
}
