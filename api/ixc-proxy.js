export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ixc-url, x-ixc-token, x-ixc-user, x-ixc-endpoint, x-ixc-secret, x-ixc-method, x-target');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ============================================================
  // SUPABASE ADMIN - cria o tecnico INTEIRAMENTE no servidor.
  // Nenhum signUp roda no navegador => a sessao do admin nunca e afetada.
  // Acionado pelo header x-target: supabase-admin
  // Requer a variavel de ambiente SUPABASE_SERVICE_ROLE_KEY (Vercel).
  // ============================================================
  if ((req.headers['x-target'] || '').toLowerCase() === 'supabase-admin') {
    const SUPA_URL = process.env.SUPABASE_URL || 'https://mgtetsmcswdtvsgewcen.supabase.co';
    const SRV = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!SRV) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY nao configurada no servidor (Vercel > Settings > Environment Variables).' });
    const b = req.body || {};
    const srvH = { 'apikey': SRV, 'Authorization': `Bearer ${SRV}`, 'Content-Type': 'application/json' };

    // 1) Valida que o solicitante e admin/operador (protege o endpoint)
    const token = (b.access_token || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')) || '';
    if (!token) return res.status(401).json({ error: 'Token do solicitante ausente.' });
    let callerId = null;
    try {
      const rv = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { 'apikey': SRV, 'Authorization': `Bearer ${token}` } });
      if (!rv.ok) return res.status(401).json({ error: 'Sessao do solicitante invalida.' });
      const vu = await rv.json();
      callerId = vu.id;
    } catch (e) { return res.status(401).json({ error: 'Falha ao validar solicitante.' }); }
    let callerPerfil = null;
    try {
      const rp = await fetch(`${SUPA_URL}/rest/v1/perfis?id=eq.${callerId}&select=perfil`, { headers: srvH });
      const pj = await rp.json();
      callerPerfil = Array.isArray(pj) && pj[0] ? pj[0].perfil : null;
    } catch (e) {}
    if (!['admin', 'operador'].includes(callerPerfil)) {
      return res.status(403).json({ error: 'Apenas administradores podem cadastrar tecnicos.' });
    }

    if (b.action === 'criar_tecnico') {
      const email = (b.email || '').trim().toLowerCase();
      const senha = b.senha || '';
      const nome  = (b.nome || '').trim();
      const telefone = b.telefone || null;
      const status = b.status || 'ativo';
      if (!email || !senha || !nome) return res.status(400).json({ error: 'Informe nome, e-mail e senha.' });
      if (senha.length < 6) return res.status(400).json({ error: 'A senha precisa ter ao menos 6 caracteres.' });

      // 2) Cria o login via Admin API (no servidor — nao mexe em sessao alguma)
      let userId = null;
      try {
        const ru = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
          method: 'POST', headers: srvH,
          body: JSON.stringify({ email, password: senha, email_confirm: true, user_metadata: { nome } })
        });
        const tu = await ru.text(); let du; try { du = JSON.parse(tu); } catch { du = {}; }
        if (!ru.ok) {
          const msg = du.msg || du.message || du.error_description || tu.slice(0, 200);
          if (/already|exist|registered|duplicate/i.test(msg)) {
            return res.status(409).json({ error: 'Este e-mail ja esta cadastrado. Use outro e-mail.' });
          }
          return res.status(ru.status).json({ error: 'Falha ao criar login: ' + msg });
        }
        userId = du.id || (du.user && du.user.id);
      } catch (e) { return res.status(502).json({ error: 'Erro ao criar login: ' + e.message }); }
      if (!userId) return res.status(502).json({ error: 'Login criado sem ID retornado.' });

      // 3) Perfil = tecnico (upsert; o gatilho ja cria perfil='user')
      try {
        await fetch(`${SUPA_URL}/rest/v1/perfis?on_conflict=id`, {
          method: 'POST', headers: { ...srvH, 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({ id: userId, nome, perfil: 'tecnico', email })
        });
      } catch (e) {}

      // 4) Registro em campo_tecnicos
      try {
        const rt = await fetch(`${SUPA_URL}/rest/v1/campo_tecnicos`, {
          method: 'POST', headers: { ...srvH, 'Prefer': 'return=representation' },
          body: JSON.stringify({ nome, telefone, status, user_id: userId })
        });
        const tt = await rt.text(); let dt; try { dt = JSON.parse(tt); } catch { dt = {}; }
        if (!rt.ok) return res.status(rt.status).json({ error: 'Login criado, mas falhou em campo_tecnicos: ' + (dt.message || tt.slice(0, 200)) });
        return res.status(200).json({ ok: true, user_id: userId, tecnico: Array.isArray(dt) ? dt[0] : dt });
      } catch (e) { return res.status(502).json({ error: 'Erro ao registrar tecnico: ' + e.message }); }
    }

    return res.status(400).json({ error: 'Acao desconhecida.' });
  }

  // ============================================================
  // EVOTRIX - envio de WhatsApp via template (CLOUD API)
  // ============================================================
  // GROQ - analises de IA (Llama 3.3 70B)
  // Acionado pelo header x-target: groq
  // A chave fica SOMENTE no servidor (variavel de ambiente GROQ_API_KEY)
  // Body: { messages:[{role,content},...], model?, temperature?, max_tokens? }
  // ============================================================
  if ((req.headers['x-target'] || '').toLowerCase() === 'groq') {
    const groqKey = process.env.GROQ_API_KEY || '';
    if (!groqKey) {
      return res.status(500).json({ error: 'GROQ_API_KEY nao configurada no servidor (Vercel > Settings > Environment Variables).' });
    }
    const b = req.body || {};
    if (!Array.isArray(b.messages) || !b.messages.length) {
      return res.status(400).json({ error: 'Campo obrigatorio: messages (array).' });
    }
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: b.model || 'llama-3.3-70b-versatile',
          messages: b.messages.slice(0, 20),
          temperature: typeof b.temperature === 'number' ? b.temperature : 0.4,
          max_tokens: Math.min(parseInt(b.max_tokens) || 900, 2000),
        }),
      });
      const data = await r.json().catch(() => ({}));
      console.log(`[groq] ${r.status}`);
      if (r.status >= 200 && r.status < 300) {
        return res.status(200).json({ ok: true, texto: data?.choices?.[0]?.message?.content || '', usage: data?.usage || null });
      }
      return res.status(r.status).json({ ok: false, groq: data });
    } catch (e) {
      console.log(`[groq] ERRO ${e.message}`);
      return res.status(502).json({ error: 'Falha ao consultar a IA (Groq).', detail: e.message });
    }
  }

  // Acionado pelo header x-target: evotrix
  // A chave fica SOMENTE no servidor (variavel de ambiente EVOTRIX_API_KEY)
  // ============================================================
  if ((req.headers['x-target'] || '').toLowerCase() === 'evotrix') {
    const apiKey = process.env.EVOTRIX_API_KEY || '';
    if (!apiKey) {
      return res.status(500).json({ error: 'EVOTRIX_API_KEY nao configurada no servidor (Vercel > Settings > Environment Variables).' });
    }
    const b = req.body || {};
    // Retrocompatibilidade: aceita tanto {channel,recipient,body} quanto o formato
    // legado {numero,mensagem} usado pelo MoviControl (credenciais + regua de cobranca).
    // O canal padrao vem da env EVOTRIX_CHANNEL (fallback: canal principal MoviOn).
    const payload = {
      channel:   b.channel   || process.env.EVOTRIX_CHANNEL || '67127520ecb37a364cc5e36d',
      recipient: b.recipient || String(b.numero || '').replace(/\D/g, ''),
      body:      typeof b.body === 'string' && b.body ? b.body : (typeof b.mensagem === 'string' ? b.mensagem : ''),
      campaign:  b.campaign  || 'os_notificacao',
    };
    if (!payload.channel || !payload.recipient || !payload.body) {
      return res.status(400).json({ error: 'Faltam campos: channel, recipient ou body (ou numero/mensagem).' });
    }
    // Endpoint e autenticacao confirmados em producao (Bearer)
    const evoUrl = 'https://api.evotrix.com.br/v1/services/whatsapp/notifications/text';
    try {
      const r = await fetch(evoUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
      console.log(`[evotrix] ${r.status} ${text.slice(0, 160)}`);
      if (r.status >= 200 && r.status < 300) {
        return res.status(200).json({ ok: true, evotrix: data });
      }
      return res.status(r.status).json({ ok: false, evotrix: data });
    } catch (e) {
      console.log(`[evotrix] ERRO ${e.message}`);
      return res.status(502).json({ error: 'Falha ao enviar pela Evotrix.', detail: e.message });
    }
  }

  const ixcUrl    = req.headers['x-ixc-url'];
  const ixcToken  = req.headers['x-ixc-token'];
  const ixcUser   = req.headers['x-ixc-user'] || '';
  const ixcSecret = req.headers['x-ixc-secret'] || '';
  const endpoint  = req.headers['x-ixc-endpoint'];
  const ixcMethod = (req.headers['x-ixc-method'] || 'GET').toUpperCase();
  const params    = req.body?.params || {};
  const rp        = req.body?.rp || params.rp || '100';
  if (!ixcUrl || !ixcToken || !endpoint) {
    return res.status(400).json({ error: 'Missing required headers' });
  }
  const base = ixcUrl.replace(/\/$/, '').replace(/\/adm\.php$/, '');

  // ===== Autenticacao (mesma logica de descoberta, reutilizada por listagem e edicao) =====
  const authCandidates = [];
  if (ixcUser) authCandidates.push({ label: 'Basic user:token',   value: `Basic ${Buffer.from(`${ixcUser}:${ixcToken}`).toString('base64')}` });
  authCandidates.push({             label: 'Basic token:',        value: `Basic ${Buffer.from(`${ixcToken}:`).toString('base64')}` });
  if (ixcUser && ixcSecret) authCandidates.push({ label: 'Basic user:secret', value: `Basic ${Buffer.from(`${ixcUser}:${ixcSecret}`).toString('base64')}` });

  const urlCandidates = [
    `${base}/webservice/v1/${endpoint}`,
    `${base}/adm.php/webservice/v1/${endpoint}`,
  ];

  // ============================================================
  // IXC DOC (ADITIVO) - boleto em PDF e PIX copia-e-cola
  // Acionado pelo header x-target: ixc-doc
  //
  // Por que rota propria: a branch padrao de listagem monta um corpo
  // FIXO (qtype/query/oper/page/rp/sortname/sortorder) e descartaria
  // 'boletos', 'base64', 'tipo_boleto' e 'id_areceber'. Aqui o params
  // vai inteiro para o IXC.
  //
  // Somente leitura: ixcsoft 'listar'. Lista branca de endpoints para
  // nao virar um passthrough generico.
  // ============================================================
  if ((req.headers['x-target'] || '').toLowerCase() === 'ixc-doc') {
    const DOC_PERMITIDOS = ['get_boleto', 'get_pix'];
    if (!DOC_PERMITIDOS.includes(endpoint)) {
      return res.status(400).json({ error: 'Endpoint nao permitido nesta rota.', permitidos: DOC_PERMITIDOS });
    }
    const docBody = JSON.stringify(params);
    const docResults = [];
    for (const url of urlCandidates) {
      for (const { label, value } of authCandidates) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': value,
              'Content-Type': 'application/json',
              'ixcsoft': 'listar',
            },
            body: docBody,
          });
          const text   = await response.text();
          const isHtml = text.trim().startsWith('<');
          docResults.push({ url, auth: label, status: response.status, isHtml, preview: text.slice(0, 200) });
          if (!isHtml && response.status >= 200 && response.status < 400) {
            try {
              const data = JSON.parse(text);
              return res.status(200).json({ ...data, _workingUrl: url, _auth: label });
            } catch {
              // algumas versoes devolvem o base64 cru, fora de JSON
              return res.status(200).json({ raw: text, _workingUrl: url, _auth: label });
            }
          }
        } catch (e) {
          docResults.push({ url, auth: label, error: e.message });
        }
      }
    }
    const got401d = docResults.find(r => r.status === 401 && !r.isHtml);
    const hintD = got401d
      ? `Endpoint correto (${got401d.url}) mas credenciais invalidas. Verifique o token.`
      : docResults.find(r => !r.isHtml)?.preview || 'Nenhum endpoint respondeu como API.';
    return res.status(401).json({ error: 'Consulta de boleto/PIX falhou.', hint: hintD, results: docResults });
  }

  // ============================================================
  // EDICAO (PUT) - ex: limpar MAC do login (ixcsoft: 'editar')
  // O endpoint ja vem com o id: ex "cliente_login/1234"
  // ============================================================
  if (ixcMethod === 'PUT') {
    const editBody = JSON.stringify(params); // payload completo do registro
    const results = [];
    for (const url of urlCandidates) {
      for (const { label, value } of authCandidates) {
        try {
          const response = await fetch(url, {
            method: 'PUT',
            headers: {
              'Authorization': value,
              'Content-Type': 'application/json',
              'ixcsoft': 'editar',
            },
            body: editBody,
          });
          const text   = await response.text();
          const isHtml = text.trim().startsWith('<');
          results.push({ url, auth: label, status: response.status, isHtml, preview: text.slice(0, 200) });
          if (!isHtml && response.status >= 200 && response.status < 400) {
            try {
              const data = JSON.parse(text);
              return res.status(200).json({ ...data, _workingUrl: url, _auth: label });
            } catch { /* not valid JSON */ }
          }
        } catch (e) {
          results.push({ url, auth: label, error: e.message });
        }
      }
    }
    const got401e = results.find(r => r.status === 401 && !r.isHtml);
    const hintE = got401e
      ? `Endpoint correto (${got401e.url}) mas credenciais invalidas. Verifique o token.`
      : results.find(r => !r.isHtml)?.preview || 'Nenhum endpoint respondeu como API.';
    return res.status(401).json({ error: 'Edicao IXC falhou.', hint: hintE, results });
  }

  // ============================================================
  // INCLUSAO (INSERT) - ex: enviar SMS (ixcsoft: 'incluir')
  // POST no endpoint da tabela com o corpo do registro
  // ============================================================
  if (ixcMethod === 'INSERT') {
    const insBody = JSON.stringify(params); // campos do novo registro
    const results = [];
    for (const url of urlCandidates) {
      for (const { label, value } of authCandidates) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': value,
              'Content-Type': 'application/json',
              'ixcsoft': 'incluir',
            },
            body: insBody,
          });
          const text   = await response.text();
          const isHtml = text.trim().startsWith('<');
          results.push({ url, auth: label, status: response.status, isHtml, preview: text.slice(0, 200) });
          if (!isHtml && response.status >= 200 && response.status < 400) {
            try {
              const data = JSON.parse(text);
              return res.status(200).json({ ...data, _workingUrl: url, _auth: label });
            } catch { /* not valid JSON */ }
          }
        } catch (e) {
          results.push({ url, auth: label, error: e.message });
        }
      }
    }
    const got401i = results.find(r => r.status === 401 && !r.isHtml);
    const hintI = got401i
      ? `Endpoint correto (${got401i.url}) mas credenciais invalidas. Verifique o token.`
      : results.find(r => !r.isHtml)?.preview || 'Nenhum endpoint respondeu como API.';
    return res.status(401).json({ error: 'Inclusao IXC falhou.', hint: hintI, results });
  }

  // ============================================================
  // R2 UPLOAD - recebe foto do técnico e salva no Cloudflare R2
  // Acionado pelo header x-target: r2-upload
  // Espera body: { os_id, tecnico_id, foto_base64, extensao, access_token }
  // ============================================================
  if ((req.headers['x-target'] || '').toLowerCase() === 'r2-upload') {
    const R2_ACCOUNT  = process.env.R2_ACCOUNT_ID        || '';
    const R2_KEY      = process.env.R2_ACCESS_KEY_ID     || '';
    const R2_SECRET   = process.env.R2_SECRET_ACCESS_KEY || '';
    const R2_BUCKET   = process.env.R2_BUCKET_NAME       || 'movionfotos';
    const R2_ENDPOINT = process.env.R2_ENDPOINT          || `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`;

    if (!R2_KEY || !R2_SECRET) return res.status(500).json({ error: 'Credenciais R2 não configuradas no Vercel.' });

    const b = req.body || {};
    const { os_id, tecnico_id, foto_base64, extensao = 'jpg', access_token } = b;
    if (!os_id || !foto_base64) return res.status(400).json({ error: 'os_id e foto_base64 são obrigatórios.' });

    // Decodifica base64
    const base64Data = foto_base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const ext = (extensao || 'jpg').toLowerCase().replace(/[^a-z]/g, '');
    const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

    // Nome do arquivo: fotos/OS_{id}/{timestamp}_{random}.{ext}
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const key = `fotos/OS_${os_id}/${ts}_${rand}.${ext}`;

    // Assina a requisição com AWS Signature V4 (compatível com R2)
    const now = new Date();
    const dateStr  = now.toISOString().slice(0,10).replace(/-/g,'');   // YYYYMMDD
    const timeStr  = now.toISOString().replace(/[-:]/g,'').slice(0,15) + 'Z'; // YYYYMMDDTHHmmssZ
    const region   = 'auto';
    const service  = 's3';
    const host     = `${R2_ACCOUNT}.r2.cloudflarestorage.com`;
    const url      = `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;

    // Função de hash/hmac via crypto (Node built-in)
    const crypto = await import('crypto');
    const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
    const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

    const payloadHash = hash(buffer);
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timeStr}\n`;
    const signedHeaders    = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = `PUT\n/${R2_BUCKET}/${key}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credScope = `${dateStr}/${region}/${service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${timeStr}\n${credScope}\n${hash(canonicalRequest)}`;
    const sigKey = hmac(hmac(hmac(hmac(`AWS4${R2_SECRET}`, dateStr), region), service), 'aws4_request');
    const signature = hmac(sigKey, stringToSign).toString('hex');
    const authHeader = `AWS4-HMAC-SHA256 Credential=${R2_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    try {
      const r2Res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type':          contentType,
          'x-amz-date':            timeStr,
          'x-amz-content-sha256':  payloadHash,
          'Authorization':         authHeader,
          'Content-Length':        String(buffer.length),
        },
        body: buffer,
      });

      if (!r2Res.ok) {
        const txt = await r2Res.text();
        return res.status(502).json({ error: 'Falha no upload R2', detail: txt.slice(0, 300) });
      }

      return res.status(200).json({ ok: true, key, url: `${R2_ENDPOINT}/${R2_BUCKET}/${key}` });
    } catch (e) {
      return res.status(500).json({ error: 'Erro ao enviar para R2: ' + e.message });
    }
  }

  // ============================================================
  // R2 LIST - lista fotos de uma OS
  // Acionado pelo header x-target: r2-list
  // Espera body: { os_id }
  // ============================================================
  if ((req.headers['x-target'] || '').toLowerCase() === 'r2-list') {
    const R2_ACCOUNT  = process.env.R2_ACCOUNT_ID        || '';
    const R2_KEY      = process.env.R2_ACCESS_KEY_ID     || '';
    const R2_SECRET   = process.env.R2_SECRET_ACCESS_KEY || '';
    const R2_BUCKET   = process.env.R2_BUCKET_NAME       || 'movionfotos';
    const R2_ENDPOINT = process.env.R2_ENDPOINT          || `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`;

    const b = req.body || {};
    const { os_id } = b;
    if (!os_id) return res.status(400).json({ error: 'os_id obrigatório.' });

    const prefix = `fotos/OS_${os_id}/`;
    const crypto = await import('crypto');
    const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
    const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

    const now = new Date();
    const dateStr = now.toISOString().slice(0,10).replace(/-/g,'');
    const timeStr = now.toISOString().replace(/[-:]/g,'').slice(0,15) + 'Z';
    const region = 'auto'; const service = 's3';
    const host = `${R2_ACCOUNT}.r2.cloudflarestorage.com`;
    const queryStr = `list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const listUrl  = `${R2_ENDPOINT}/${R2_BUCKET}?${queryStr}`;

    const payloadHash = hash('');
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timeStr}\n`;
    const signedHeaders    = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = `GET\n/${R2_BUCKET}\n${queryStr}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credScope = `${dateStr}/${region}/${service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${timeStr}\n${credScope}\n${hash(canonicalRequest)}`;
    const sigKey = hmac(hmac(hmac(hmac(`AWS4${R2_SECRET}`, dateStr), region), service), 'aws4_request');
    const signature = hmac(sigKey, stringToSign).toString('hex');
    const authHeader = `AWS4-HMAC-SHA256 Credential=${R2_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    try {
      const r2Res = await fetch(listUrl, {
        headers: {
          'host': host,
          'x-amz-date': timeStr,
          'x-amz-content-sha256': payloadHash,
          'Authorization': authHeader,
        }
      });
      const xml = await r2Res.text();
      // Extrai as keys do XML
      const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
      const fotos = keys.map(k => ({
        key: k,
        url: `${R2_ENDPOINT}/${R2_BUCKET}/${k}`,
        nome: k.split('/').pop(),
      }));
      return res.status(200).json({ ok: true, fotos });
    } catch(e) {
      return res.status(500).json({ error: 'Erro ao listar R2: ' + e.message });
    }
  }

  // ============================================================
  // SPEEDTEST DOWNLOAD — gera payload aleatório e envia ao cliente
  // Acionado pelo header x-target: speedtest-down
  // Query param: ?bytes=N (default 5MB, max 20MB)
  // ============================================================
  if ((req.headers['x-target'] || '').toLowerCase() === 'speedtest-down') {
    const bytes = Math.min(20 * 1024 * 1024, Math.max(1024, parseInt(req.query?.bytes || req.body?.bytes || 5 * 1024 * 1024)));
    // Gera buffer aleatório (não compressível — evita distorção por compressão de rede)
    const buf = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 4) buf.writeUInt32BE(Math.random() * 0xFFFFFFFF | 0, i);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(bytes));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Speedtest-Bytes', String(bytes));
    return res.status(200).send(buf);
  }

  // ============================================================
  // SPEEDTEST UPLOAD — recebe payload e responde com tamanho + tempo
  // Acionado pelo header x-target: speedtest-up
  // ============================================================
  if ((req.headers['x-target'] || '').toLowerCase() === 'speedtest-up') {
    const received = req.body ? (Buffer.isBuffer(req.body) ? req.body.length : JSON.stringify(req.body).length) : 0;
    return res.status(200).json({ ok: true, bytes: received, ts: Date.now() });
  }

  const apiBody = JSON.stringify({
    qtype:     params.qtype     || '',
    query:     params.query     || '',
    oper:      params.oper      || '=',
    page:      params.page      || '1',
    rp:        String(rp),
    sortname:  params.sortname  || 'id',
    sortorder: params.sortorder || 'desc',
  });
  const results = [];
  for (const rawUrl of urlCandidates) {
    const url = rawUrl;
    for (const { label, value } of authCandidates) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': value,
            'Content-Type': 'application/json',
            'ixcsoft': 'listar',
          },
          body: apiBody,
        });
        const text   = await response.text();
        const isHtml = text.trim().startsWith('<');
        results.push({ url, auth: label, status: response.status, isHtml, preview: text.slice(0, 200) });
        if (!isHtml && response.status >= 200 && response.status < 400) {
          try {
            const data = JSON.parse(text);
            return res.status(200).json({ ...data, _workingUrl: url, _auth: label });
          } catch { /* not valid JSON */ }
        }
      } catch (e) {
        results.push({ url, auth: label, error: e.message });
      }
    }
  }
  const got401 = results.find(r => r.status === 401 && !r.isHtml);
  const hint = got401
    ? `Endpoint correto (${got401.url}) mas credenciais invalidas. Verifique o token.`
    : results.find(r => !r.isHtml)?.preview || 'Nenhum endpoint respondeu como API.';
  return res.status(401).json({ error: 'Autenticacao falhou.', hint, results });
}
