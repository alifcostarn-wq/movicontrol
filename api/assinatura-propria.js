// api/assinatura-propria.js — Sistema PRÓPRIO de assinatura eletrônica
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

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ ok: false, error: 'Token ausente' });
  const target = req.headers['x-target'] || 'admin';

  let userId = null;
  try {
    const uResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_KEY }
    });
    if (!uResp.ok) return res.status(401).json({ ok: false, error: 'Token inválido' });
    userId = (await uResp.json()).id;
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Falha na validação do token' });
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

  // Upload direto (PUT) via aws4fetch — assina e envia numa chamada só
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
  async function gerarPdfAssinado({ originalBytes, hashOriginal, documentoNome, signer, dataAssinatura, ip, userAgent, selfieBuf }) {
    const doc = await PDFDocument.load(originalBytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);

    const page = doc.addPage([595.28, 841.89]); // A4
    const M = 50;
    let y = 780;
    const gray = rgb(0.35, 0.35, 0.4);
    const dark = rgb(0.1, 0.1, 0.18);

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
    linha('Dispositivo:', (userAgent || '').slice(0, 80));
    linha('Endereço IP:', ip || '');
    y -= 20;

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
        page.drawText(signer.nome + ' — CPF ' + signer.cpf, { x: M + w + 30, y: y - h / 2 - 22, size: 8, font, color: gray });
        y -= (h + 20);
      } catch (e) { /* selfie não é JPEG válido — segue sem foto */ }
    }

    page.drawLine({ start: { x: M, y: 40 }, end: { x: 545, y: 40 }, thickness: 0.5, color: rgb(0.9, 0.9, 0.93) });
    page.drawText('MoviOn Internet — assinatura eletrônica registrada internamente', { x: M, y: 28, size: 8, font, color: gray });

    return Buffer.from(await doc.save());
  }

  async function r2SignedUrl(key, expiresIn = 3600) {
    if (!key) return null;
    const url = new URL(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`);
    url.searchParams.set('X-Amz-Expires', String(expiresIn));
    const signed = await r2.sign(new Request(url, { method: 'GET' }), { aws: { signQuery: true } });
    return signed.url;
  }

  try {
    // ══════════════ TARGET: CLIENTE (MoviApp) ══════════════
    if (target === 'cliente') {
      const ca = await sb(`clientes_app?user_id=eq.${userId}&select=cliente_id`);
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
        const { lote_id, dados_confirmados, selfie_base64 } = req.body;
        if (!lote_id || !dados_confirmados || !selfie_base64) return res.status(400).json({ ok: false, error: 'lote_id, dados_confirmados e selfie_base64 obrigatórios' });

        const lote = await sb(`assinatura_lotes?id=eq.${lote_id}&cliente_id=eq.${clienteId}&select=id,status`);
        if (!lote.ok || !lote.data?.length) return res.status(404).json({ ok: false, error: 'Lote não encontrado' });
        if (lote.data[0].status === 'assinado') return res.status(200).json({ ok: true, ja_assinado: true });

        // 1) sobe a selfie
        const selfieKey = `assinaturas/selfies/${clienteId}/${lote_id}_${Date.now()}.jpg`;
        const selfieBuf = Buffer.from(selfie_base64, 'base64');
        const upSelfie = await r2Upload(selfieKey, selfieBuf, 'image/jpeg');
        if (!upSelfie.ok) return res.status(500).json({ ok: false, error: upSelfie.error });

        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
        const ua = req.headers['user-agent'] || null;
        const agora = new Date();
        const dataAssinaturaFmt = agora.toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }) + ' (Horário de Brasília)';

        // 2) para cada documento do lote: baixa o original, gera o PDF final com certificado, sobe
        const docs = await sb(`contratos_assinatura?lote_id=eq.${lote_id}&select=id,documento_nome,documento_url`);
        for (const d of (docs.data || [])) {
          if (!d.documento_url) continue;
          const originalBytes = await r2Get(d.documento_url);
          if (!originalBytes) continue;
          const hashOriginal = crypto.createHash('sha256').update(originalBytes).digest('hex');

          const finalBytes = await gerarPdfAssinado({
            originalBytes, hashOriginal, documentoNome: d.documento_nome,
            signer: { nome: dados_confirmados.nome, cpf: dados_confirmados.cpf },
            dataAssinatura: dataAssinaturaFmt, ip, userAgent: ua, selfieBuf
          });

          const assinadoKey = `assinaturas/contratos-assinados/${clienteId}/${lote_id}_${d.id}.pdf`;
          const upFinal = await r2Upload(assinadoKey, finalBytes, 'application/pdf');
          if (upFinal.ok) {
            await sb(`contratos_assinatura?id=eq.${d.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ documento_assinado_url: assinadoKey, hash_original: hashOriginal, status: 'assinado', assinado_em: agora.toISOString() })
            });
          }
        }

        // 3) marca o lote como assinado
        const updLote = await sb(`assinatura_lotes?id=eq.${lote_id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'assinado', dados_confirmados, selfie_url: selfieKey,
            ip, user_agent: ua, assinado_em: agora.toISOString()
          })
        });
        if (!updLote.ok) return res.status(500).json({ ok: false, error: 'Falha ao atualizar lote' });

        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ ok: false, error: 'Ação inválida para cliente' });
    }

    // ══════════════ TARGET: ADMIN (MoviControl) ══════════════
    const perfil = await sb(`perfis?id=eq.${userId}&select=perfil`);
    if (!perfil.ok || !perfil.data?.length || !['admin', 'operador'].includes(perfil.data[0].perfil)) {
      return res.status(403).json({ ok: false, error: 'Acesso restrito a administradores' });
    }

    if (action === 'listar_lotes') {
      const { cliente_id } = req.body;
      if (!cliente_id) return res.status(400).json({ ok: false, error: 'cliente_id obrigatório' });
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
        out.push({ ...l, selfie_url: await r2SignedUrl(l.selfie_url), documentos: docsComLink });
      }
      return res.status(200).json({ ok: true, lotes: out });
    }

    if (action === 'upload_pdf') {
      const { cliente_id, nome_arquivo, pdf_base64 } = req.body;
      if (!cliente_id || !nome_arquivo || !pdf_base64) return res.status(400).json({ ok: false, error: 'cliente_id, nome_arquivo e pdf_base64 obrigatórios' });
      const key = `assinaturas/contratos/${cliente_id}/${Date.now()}_${nome_arquivo.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const buf = Buffer.from(pdf_base64, 'base64');
      const up = await r2Upload(key, buf, 'application/pdf');
      if (!up.ok) return res.status(500).json({ ok: false, error: up.error });
      return res.status(200).json({ ok: true, path: key, bytes: buf.length });
    }

    if (action === 'criar_lote') {
      const { cliente_id, ixc_contrato_id, documentos } = req.body;
      if (!cliente_id || !Array.isArray(documentos) || !documentos.length) {
        return res.status(400).json({ ok: false, error: 'cliente_id e documentos[] obrigatórios' });
      }
      const lote = await sb('assinatura_lotes', {
        method: 'POST',
        body: JSON.stringify({ cliente_id, ixc_contrato_id: ixc_contrato_id || null, status: 'pendente' })
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
