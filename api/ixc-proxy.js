export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ixc-url, x-ixc-token, x-ixc-user, x-ixc-endpoint, x-ixc-secret, x-ixc-method');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
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
  // LISTAGEM (GET) - logica original, intacta
  // ============================================================
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
