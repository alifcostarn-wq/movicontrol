export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-ixc-url, x-ixc-token, x-ixc-user, x-ixc-endpoint, x-ixc-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ixcUrl    = req.headers['x-ixc-url'];
  const ixcToken  = req.headers['x-ixc-token'];
  const ixcUser   = req.headers['x-ixc-user'] || '';
  const ixcSecret = req.headers['x-ixc-secret'] || '';
  const endpoint  = req.headers['x-ixc-endpoint'];
  const params    = req.body?.params || {};
  const rp        = req.body?.rp || params.rp || '100';

  if (!ixcUrl || !ixcToken || !endpoint) {
    return res.status(400).json({ error: 'Missing required headers' });
  }

  const base = ixcUrl.replace(/\/$/, '').replace(/\/adm\.php$/, '');

  const apiBody = JSON.stringify({
    qtype:     params.qtype     || '',
    query:     params.query     || '',
    oper:      params.oper      || '=',
    page:      params.page      || '1',
    rp:        String(rp),
    sortname:  params.sortname  || 'id',
    sortorder: params.sortorder || 'desc',
  });

  const urlCandidates = [
    `${base}/webservice/v1/${endpoint}`,
    `${base}/adm.php/webservice/v1/${endpoint}`,
  ];

  const authCandidates = [];
  if (ixcUser) authCandidates.push({ label: 'Basic user:token',   value: `Basic ${Buffer.from(`${ixcUser}:${ixcToken}`).toString('base64')}` });
  authCandidates.push({
