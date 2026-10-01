// ============================================================================
// ACS (TR-069) — o MoviControl conversando com o GenieACS
// ----------------------------------------------------------------------------
// O GenieACS roda no POP: é ele que os roteadores e ONUs procuram a cada 5
// minutos (o "contato"), e é por ele que mandamos trocar a senha do Wi-Fi,
// reiniciar ou testar a conexão. Daqui falamos só com a API dele (NBI), que
// fica atrás de um proxy com token — ver infra/acs/LEIA-ME.md.
//
// Arquivo com "_" na frente: a Vercel não o publica como função. É biblioteca
// de api/atendimento.js.
//
// Os equipamentos falam dois "dialetos":
//   TR-098  InternetGatewayDevice.*  — a maioria das ONUs (Huawei, ZTE, FiberHome)
//   TR-181  Device.*                 — roteadores mais novos (Intelbras, TP-Link…)
// E cada fabricante ainda guarda a senha e o sinal da fibra num lugar. Tudo
// o que depende disso mora aqui, num lugar só.
// ============================================================================

export function acsConfig(env = process.env) {
  return {
    url: String(env.ACS_NBI_URL || '').trim().replace(/\/$/, ''),
    token: String(env.ACS_NBI_TOKEN || '').trim(),
    // arquivo para o teste de velocidade (servidor do próprio provedor, de
    // preferência dentro da rede: mede o enlace do cliente, não a internet)
    downloadUrl: String(env.ACS_TESTE_DOWNLOAD_URL || '').trim(),
    pingHost: String(env.ACS_PING_HOST || '8.8.8.8').trim(),
  };
}
export const acsLigado = cfg => !!(cfg && cfg.url);

async function nbi(cfg, caminho, { method = 'GET', body, ms = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  let r;
  try {
    r = await fetch(cfg.url + caminho, {
      method,
      headers: {
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('O servidor ACS não respondeu a tempo.');
    const c = err.cause || {};
    throw new Error('Não consegui falar com o servidor ACS: ' + String(c.code || c.errors?.[0]?.code || c.message || err.message));
  } finally { clearTimeout(t); }
  const txt = await r.text();
  if (r.status === 401 || r.status === 403) throw new Error('O servidor ACS recusou o token do MoviControl (ACS_NBI_TOKEN).');
  if (!r.ok) throw new Error(`ACS ${r.status}: ${txt.slice(0, 200)}`);
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  return { status: r.status, data };
}

// O id do GenieACS leva o modelo escapado ("W5%2D1200F"): vai inteiro, codificado
const caminhoDev = id => `/devices/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------- leitura
/* O documento do GenieACS é uma árvore em que cada folha tem _value,
   _timestamp e _writable. Achatado vira { 'a.b.c': {v, ts, w} } — é assim
   que o resto do código consulta. */
export function achatar(doc) {
  const out = {};
  (function andar(o, pre) {
    for (const [k, v] of Object.entries(o || {})) {
      if (k.startsWith('_') || !v || typeof v !== 'object') continue;
      const p = pre + k;
      if ('_value' in v || ('_writable' in v && v._object === false)) {
        out[p] = { v: v._value, ts: v._timestamp ? Date.parse(v._timestamp) : 0, w: !!v._writable };
      }
      andar(v, p + '.');
    }
  })(doc, '');
  return out;
}

const val = (f, p) => (f[p] ? f[p].v : undefined);
const indices = (f, re) => [...new Set(Object.keys(f).map(k => (k.match(re) || [])[1]).filter(Boolean))].sort((a, b) => a - b);
const sim = v => v === true || v === 1 || v === '1' || v === 'true';

export function modeloDados(f) {
  return Object.keys(f).some(k => k.startsWith('Device.')) && !Object.keys(f).some(k => k.startsWith('InternetGatewayDevice.'))
    ? 'TR-181' : 'TR-098';
}

/* Sinal da fibra (dBm recebido na ONU). Faixas usadas por provedor GPON:
   acima de -8 satura o receptor; até -25 é bom; -25 a -27 pede atenção;
   abaixo de -27 está perto do limite (classe B+: -28) e cai. */
export function classificarSinal(dbm) {
  if (dbm == null || !isFinite(dbm)) return null;
  if (dbm > -8) return 'forte_demais';
  if (dbm >= -25) return 'bom';
  if (dbm >= -27) return 'atencao';
  return 'ruim';
}

function redesWifi(f) {
  const redes = [];
  if (modeloDados(f) === 'TR-181') {
    for (const i of indices(f, /^Device\.WiFi\.AccessPoint\.(\d+)\./)) {
      const ap = `Device.WiFi.AccessPoint.${i}.`;
      const ssidRef = String(val(f, ap + 'SSIDReference') || `Device.WiFi.SSID.${i}`).replace(/\.$/, '');
      const radioRef = String(val(f, ssidRef + '.LowerLayers') || '').split(',')[0].trim().replace(/\.$/, '');
      const banda = String(val(f, radioRef + '.OperatingFrequencyBand') || '');
      redes.push({
        indice: Number(i),
        banda: /5/.test(banda) ? '5GHz' : /6/.test(banda) ? '6GHz' : '2.4GHz',
        ssid: val(f, ssidRef + '.SSID') ?? null,
        ativa: val(f, ssidRef + '.Enable') == null ? true : sim(val(f, ssidRef + '.Enable')),
        canal: val(f, radioRef + '.Channel') ?? null,
        aparelhos: val(f, ap + 'AssociatedDeviceNumberOfEntries') ?? null,
        caminhoSsid: f[ssidRef + '.SSID'] ? ssidRef + '.SSID' : null,
        caminhoSenha: f[ap + 'Security.KeyPassphrase']?.w ? ap + 'Security.KeyPassphrase' : null,
      });
    }
    return redes;
  }
  for (const i of indices(f, /^InternetGatewayDevice\.LANDevice\.1\.WLANConfiguration\.(\d+)\./)) {
    const w = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}.`;
    const padrao = String(val(f, w + 'Standard') || '');
    const freq = String(val(f, w + 'OperatingFrequencyBand') || '');
    // Sem campo de frequência: "ac"/"a" no padrão é 5 GHz; na Huawei as
    // redes 5 a 8 são as de 5 GHz
    const banda = freq ? (/5/.test(freq) ? '5GHz' : '2.4GHz')
      : (/ac|ax|(^|\/)a(\/|$)/i.test(padrao) && !/b|g/i.test(padrao)) || /ac/i.test(padrao) ? '5GHz'
      : Number(i) >= 5 ? '5GHz' : '2.4GHz';
    // onde mora a senha, na ordem em que os fabricantes costumam usar
    const caminhoSenha = [w + 'KeyPassphrase', w + 'PreSharedKey.1.KeyPassphrase', w + 'PreSharedKey.1.PreSharedKey']
      .find(p => f[p] && f[p].w) || null;
    redes.push({
      indice: Number(i), banda,
      ssid: val(f, w + 'SSID') ?? null,
      ativa: sim(val(f, w + 'Enable')),
      canal: val(f, w + 'Channel') ?? null,
      aparelhos: val(f, w + 'TotalAssociations') ?? null,
      caminhoSsid: f[w + 'SSID'] ? w + 'SSID' : null,
      caminhoSenha,
    });
  }
  return redes;
}

function aparelhos(f) {
  const lista = [];
  if (modeloDados(f) === 'TR-181') {
    for (const i of indices(f, /^Device\.Hosts\.Host\.(\d+)\./)) {
      const h = `Device.Hosts.Host.${i}.`;
      const l1 = String(val(f, h + 'Layer1Interface') || '');
      lista.push({
        nome: val(f, h + 'HostName') || null, ip: val(f, h + 'IPAddress') || null,
        mac: val(f, h + 'PhysAddress') || null, ativo: sim(val(f, h + 'Active')),
        via: /WiFi/i.test(l1) ? 'wifi' : l1 ? 'cabo' : null,
      });
    }
  } else {
    for (const i of indices(f, /^InternetGatewayDevice\.LANDevice\.1\.Hosts\.Host\.(\d+)\./)) {
      const h = `InternetGatewayDevice.LANDevice.1.Hosts.Host.${i}.`;
      const l2 = String(val(f, h + 'Layer2Interface') || val(f, h + 'InterfaceType') || '');
      lista.push({
        nome: val(f, h + 'HostName') || null, ip: val(f, h + 'IPAddress') || null,
        mac: val(f, h + 'MACAddress') || null, ativo: sim(val(f, h + 'Active')),
        via: /WLAN|802\.11|wi-?fi/i.test(l2) ? 'wifi' : l2 ? 'cabo' : null,
      });
    }
  }
  return lista;
}

function conexao(f) {
  if (modeloDados(f) === 'TR-181') {
    const i = indices(f, /^Device\.PPP\.Interface\.(\d+)\.Username$/)[0];
    const ips = Object.keys(f).filter(k => /^Device\.IP\.Interface\.\d+\.IPv4Address\.\d+\.IPAddress$/.test(k))
      .map(k => val(f, k)).filter(ip => ip && !/^(192\.168|10\.0\.0|127\.)/.test(ip));
    return {
      login: i ? val(f, `Device.PPP.Interface.${i}.Username`) : null,
      estado: i ? val(f, `Device.PPP.Interface.${i}.Status`) : null,
      ip: ips[0] || null,
      ultimoErro: i ? val(f, `Device.PPP.Interface.${i}.LastConnectionError`) || null : null,
    };
  }
  const chave = Object.keys(f).find(k => /WANPPPConnection\.\d+\.Username$/.test(k) && val(f, k));
  const base = chave ? chave.replace(/Username$/, '') : null;
  return {
    login: base ? val(f, base + 'Username') : null,
    estado: base ? val(f, base + 'ConnectionStatus') : null,
    ip: base ? val(f, base + 'ExternalIPAddress') || null : null,
    conectadoHaSeg: base ? Number(val(f, base + 'Uptime')) || null : null,
    ultimoErro: base ? val(f, base + 'LastConnectionError') || null : null,
  };
}

/* O resumo que o painel mostra. "Online" = fez contato dentro de duas voltas
   do intervalo (5 min) e mais um minuto de folga: um contato perdido não
   derruba ninguém, dois sim. */
export function resumir(doc, agora = Date.now()) {
  const f = achatar(doc);
  const raiz = modeloDados(f) === 'TR-181' ? 'Device.' : 'InternetGatewayDevice.';
  const intervalo = Number(val(f, raiz + 'ManagementServer.PeriodicInformInterval')) || 300;
  const ultimo = doc._lastInform ? Date.parse(doc._lastInform) : 0;
  const sinalTxt = val(f, 'VirtualParameters.sinal_rx');
  const sinal = sinalTxt === '' || sinalTxt == null ? null : Number(sinalTxt);
  const di = doc._deviceId || {};
  return {
    id: doc._id,
    modeloDados: modeloDados(f),
    fabricante: val(f, raiz + 'DeviceInfo.Manufacturer') || di._Manufacturer || null,
    modelo: val(f, raiz + 'DeviceInfo.ModelName') || di._ProductClass || null,
    serial: val(f, raiz + 'DeviceInfo.SerialNumber') || di._SerialNumber || null,
    firmware: val(f, raiz + 'DeviceInfo.SoftwareVersion') || null,
    ligadoHaSeg: Number(val(f, raiz + 'DeviceInfo.UpTime')) || null,
    ultimoContato: doc._lastInform || null,
    online: !!ultimo && agora - ultimo <= (intervalo * 2 + 60) * 1000,
    intervaloSeg: intervalo,
    sinal: { rxDbm: isFinite(sinal) ? sinal : null, situacao: classificarSinal(isFinite(sinal) ? sinal : null) },
    conexao: conexao(f),
    wifi: redesWifi(f).map(({ caminhoSenha, caminhoSsid, ...r }) => ({ ...r, podeTrocarSenha: !!caminhoSenha })),
    aparelhos: aparelhos(f),
  };
}

// ---------------------------------------------------------------- busca
async function umDoc(cfg, query) {
  const { data } = await nbi(cfg, `/devices/?query=${encodeURIComponent(JSON.stringify(query))}`);
  return Array.isArray(data) && data.length ? data : [];
}

/* Equipamento do cliente: pelo login PPPoE (o mesmo do IXC). Num cliente com
   ONU em ponte e roteador atrás, o login está no roteador — e a ONU só se
   acha pelo número de série, vinculado à mão no painel. */
export async function acharPorLogin(cfg, login) {
  const l = String(login || '').trim().toLowerCase();
  if (!l) return [];
  return umDoc(cfg, { 'VirtualParameters.pppoe_login._value': l });
}
export async function acharPorId(cfg, id) {
  return (await umDoc(cfg, { _id: String(id) }))[0] || null;
}
export async function acharPorSerial(cfg, serial) {
  const s = String(serial || '').trim();
  if (!s) return [];
  // o serial da ONU às vezes vem em hexadecimal (48575443…) e às vezes legível (HWTC…)
  return umDoc(cfg, { '_deviceId._SerialNumber': { $regex: `^${s.replace(/[^\w-]/g, '')}$`, $options: 'i' } });
}

// Lista para o monitoramento: só os campos leves, a base inteira de uma vez
export async function listar(cfg, { limite = 5000 } = {}) {
  const proj = ['_id', '_lastInform', '_deviceId', 'VirtualParameters',
    'InternetGatewayDevice.ManagementServer.PeriodicInformInterval', 'Device.ManagementServer.PeriodicInformInterval',
    'InternetGatewayDevice.DeviceInfo.ModelName', 'Device.DeviceInfo.ModelName',
    'InternetGatewayDevice.DeviceInfo.UpTime', 'Device.DeviceInfo.UpTime'].join(',');
  const { data } = await nbi(cfg, `/devices/?projection=${encodeURIComponent(proj)}&limit=${limite}`, { ms: 30000 });
  const agora = Date.now();
  return (data || []).map(d => {
    const r = resumir(d, agora);
    return {
      id: r.id, modelo: r.modelo, fabricante: r.fabricante, serial: r.serial,
      login: val(achatar(d), 'VirtualParameters.pppoe_login') || null,
      online: r.online, ultimoContato: r.ultimoContato, ligadoHaSeg: r.ligadoHaSeg, sinal: r.sinal,
    };
  });
}

// ---------------------------------------------------------------- ações
/* Toda ação vai com connection_request: o ACS "acorda" o equipamento na hora.
   200 = o equipamento atendeu e fez; 202 = não atendeu (desligado, fora de
   alcance) e o pedido fica na fila até o próximo contato. */
async function tarefa(cfg, id, corpo, ms = 20000) {
  const { status, data } = await nbi(cfg,
    `${caminhoDev(id)}/tasks?connection_request&timeout=${Math.max(3000, ms - 4000)}`,
    { method: 'POST', body: corpo, ms });
  const tarefaId = data && data._id ? String(data._id) : null;
  if (status === 202 && tarefaId) {
    /* 202 também é o que vem quando o equipamento ATENDEU mas recusou (valor
       que o firmware não aceita, por exemplo). Aí o GenieACS guarda a falha e
       repete a tarefa a cada contato, para sempre — e o painel diria "na fila".
       Se houve falha: cancela a tarefa e conta o motivo. */
    const falhaId = `${id}:task_${tarefaId}`;
    const { data: falhas } = await nbi(cfg, `/faults/?query=${encodeURIComponent(JSON.stringify({ _id: falhaId }))}`);
    const f = Array.isArray(falhas) && falhas[0];
    if (f) {
      await nbi(cfg, `/faults/${encodeURIComponent(falhaId)}`, { method: 'DELETE' }).catch(() => {});
      throw new Error('O equipamento recusou o pedido: ' + traduzirFalha(f));
    }
  }
  return { aplicado: status === 200, naFila: status === 202, tarefa: tarefaId };
}

function traduzirFalha(f) {
  const d = f.detail || {};
  const sub = Array.isArray(d.setParameterValuesFault) && d.setParameterValuesFault[0];
  const cod = String((sub && sub.faultCode) || d.faultCode || f.code || '').replace(/^cwmp\./, '');
  const m = {
    9001: 'o equipamento negou o acesso',
    9002: 'erro interno do equipamento',
    9003: 'o equipamento não aceitou os valores',
    9004: 'o equipamento está sem recurso para isso agora',
    9005: 'este modelo não tem esse campo',
    9006: 'tipo de valor errado para este modelo',
    9007: 'valor não aceito por este modelo (tente sem símbolos ou com outro tamanho)',
    9008: 'este campo é só de leitura neste modelo',
  };
  return (m[cod] || f.message || 'falha ' + cod) + (cod ? ` (código ${cod})` : '');
}

const SENHA_WIFI = /^[\x20-\x7e]{8,63}$/;   // WPA2: 8 a 63 caracteres imprimíveis

export function planoWifi(doc, { senha, ssid, bandas } = {}) {
  const f = achatar(doc);
  if (senha != null && senha !== '') {
    if (!SENHA_WIFI.test(senha)) throw new Error('A senha do Wi-Fi precisa ter de 8 a 63 caracteres, sem acentos.');
  }
  if (ssid != null && ssid !== '' && (Buffer.byteLength(String(ssid)) > 32 || !String(ssid).trim())) {
    throw new Error('O nome da rede (SSID) pode ter no máximo 32 caracteres.');
  }
  if (!senha && !ssid) throw new Error('Informe a nova senha ou o novo nome da rede.');

  let redes = redesWifi(f);
  const querBandas = Array.isArray(bandas) && bandas.length ? bandas : null;
  if (querBandas) redes = redes.filter(r => querBandas.includes(r.banda));
  // só as redes ligadas: redes de visitante desligadas ficam como estão
  let alvo = redes.filter(r => r.ativa);
  if (!alvo.length) alvo = redes.filter(r => r.indice === Math.min(...redes.map(x => x.indice)));
  if (!alvo.length) throw new Error('Este equipamento ainda não informou as redes Wi-Fi. Clique em "Atualizar" e tente de novo.');
  if (senha && !alvo.some(r => r.caminhoSenha)) {
    throw new Error('Ainda não sei onde este modelo guarda a senha do Wi-Fi. Clique em "Atualizar" e tente de novo em 1 minuto.');
  }

  const parametros = [];
  for (const r of alvo) {
    if (ssid && r.caminhoSsid) {
      // a rede de 5 GHz ganha o sufixo, para o cliente distinguir as duas
      const nome = r.banda === '5GHz' && alvo.some(x => x.banda !== '5GHz') ? `${String(ssid).slice(0, 29)}_5G` : String(ssid);
      parametros.push([r.caminhoSsid, nome, 'xsd:string']);
    }
    if (senha && r.caminhoSenha) parametros.push([r.caminhoSenha, senha, 'xsd:string']);
  }
  return { parametros, redes: alvo.map(r => ({ banda: r.banda, indice: r.indice })) };
}

/* O GenieACS guarda o último valor que leu ou gravou e PULA a gravação quando
   acha que o equipamento já tem aquele valor. Só que o equipamento pode ter
   mudado sem o ACS saber: o cliente trocou a senha pelo próprio roteador, ou
   o roteador reiniciou e esqueceu o endereço do teste de ping. Então, antes de
   gravar, relê do equipamento os campos que o ACS "acha" que já estão certos. */
async function gravar(cfg, id, parametros, doc) {
  const f = doc ? achatar(doc) : {};
  const iguais = parametros.filter(([p, v]) => f[p] && String(f[p].v) === String(v)).map(([p]) => p);
  if (iguais.length) {
    const r = await tarefa(cfg, id, { name: 'getParameterValues', parameterNames: iguais });
    if (!r.aplicado) {
      // desligado: a releitura fica na fila e a gravação vai logo atrás dela
      await tarefa(cfg, id, { name: 'setParameterValues', parameterValues: parametros }, 6000).catch(() => {});
      return r;
    }
  }
  return tarefa(cfg, id, { name: 'setParameterValues', parameterValues: parametros });
}

export async function aplicarWifi(cfg, id, plano, doc) {
  return gravar(cfg, id, plano.parametros, doc);
}
export async function reiniciar(cfg, id) {
  return tarefa(cfg, id, { name: 'reboot' });
}
// "Atualizar agora": um pedido leve que faz o equipamento conversar — e na
// conversa a provision renova Wi-Fi, aparelhos, sinal e conexão
export async function atualizar(cfg, id, raiz = 'InternetGatewayDevice') {
  return tarefa(cfg, id, { name: 'getParameterValues', parameterNames: [`${raiz}.DeviceInfo.UpTime`] });
}

// ---------------------------------------------------------------- diagnóstico
const DIAG = {
  'TR-098': {
    ping: 'InternetGatewayDevice.IPPingDiagnostics.',
    velocidade: 'InternetGatewayDevice.DownloadDiagnostics.',
    rota: 'InternetGatewayDevice.TraceRouteDiagnostics.',
  },
  'TR-181': {
    ping: 'Device.IP.Diagnostics.IPPing.',
    velocidade: 'Device.IP.Diagnostics.DownloadDiagnostics.',
    rota: 'Device.IP.Diagnostics.TraceRoute.',
  },
};
export const TIPOS_DIAGNOSTICO = ['ping', 'velocidade', 'rota'];

export function planoDiagnostico(doc, tipo, cfg) {
  const f = achatar(doc);
  const base = DIAG[modeloDados(f)][tipo];
  if (!base) throw new Error('Diagnóstico desconhecido.');
  const destino = cfg.pingHost || '8.8.8.8';
  if (!/^[\w.:-]{1,253}$/.test(destino)) throw new Error('Endereço de teste inválido.');
  if (!f[base + 'DiagnosticsState']) {
    throw new Error('Este equipamento ainda não informou se faz este teste. Clique em "Atualizar" e tente de novo em 1 minuto.');
  }
  // Parâmetro que o modelo não tem derruba o pedido inteiro (erro 9005):
  // os opcionais só vão se o equipamento os informou
  const parametros = [];
  const se = (nome, valor, tipoXsd) => { if (f[base + nome]) parametros.push([base + nome, valor, tipoXsd]); };
  if (tipo === 'ping') {
    parametros.push([base + 'Host', destino, 'xsd:string']);
    se('NumberOfRepetitions', 4, 'xsd:unsignedInt');
    se('Timeout', 2000, 'xsd:unsignedInt');
  } else if (tipo === 'velocidade') {
    if (!/^https?:\/\//.test(cfg.downloadUrl || '')) {
      throw new Error('Teste de velocidade sem arquivo configurado (ACS_TESTE_DOWNLOAD_URL na Vercel).');
    }
    parametros.push([base + 'DownloadURL', cfg.downloadUrl, 'xsd:string']);
  } else {
    parametros.push([base + 'Host', destino, 'xsd:string']);
    se('MaxHopCount', 20, 'xsd:unsignedInt');
  }
  // DiagnosticsState por último: é ele que dispara o teste no equipamento
  parametros.push([base + 'DiagnosticsState', 'Requested', 'xsd:string']);
  return { base, parametros };
}

export async function iniciarDiagnostico(cfg, id, plano, doc) {
  return gravar(cfg, id, plano.parametros, doc);
}

/* Lê o resultado. Só vale o que chegou DEPOIS do pedido: o equipamento guarda
   o último teste, e sem comparar o horário o painel mostraria o de ontem. */
export function lerDiagnostico(doc, tipo, desde = 0) {
  const f = achatar(doc);
  const base = DIAG[modeloDados(f)][tipo];
  const estadoP = f[base + 'DiagnosticsState'];
  const estado = estadoP ? estadoP.v : null;
  if (!estado || estado === 'Requested' || estadoP.ts < desde) return { pronto: false, estado: estado || null };
  if (!/^Complete/.test(estado)) return { pronto: true, ok: false, estado, erro: traduzirErroDiag(estado) };
  const n = p => Number(val(f, base + p));
  if (tipo === 'ping') {
    return { pronto: true, ok: n('SuccessCount') > 0, estado,
      enviados: n('SuccessCount') + n('FailureCount'), respondidos: n('SuccessCount'),
      mediaMs: n('AverageResponseTime'), minMs: n('MinimumResponseTime'), maxMs: n('MaximumResponseTime') };
  }
  if (tipo === 'velocidade') {
    const ini = Date.parse(val(f, base + 'BOMTime')), fim = Date.parse(val(f, base + 'EOMTime'));
    const bytes = n('TestBytesReceived') || n('TotalBytesReceived');
    const seg = (fim - ini) / 1000;
    const mbps = seg > 0 && bytes > 0 ? Math.round((bytes * 8 / seg / 1e6) * 10) / 10 : null;
    return { pronto: true, ok: mbps != null, estado, mbps, segundos: seg > 0 ? Math.round(seg * 10) / 10 : null, bytes: bytes || null };
  }
  const saltos = indices(f, new RegExp('^' + base.replace(/\./g, '\\.') + 'RouteHops\\.(\\d+)\\.'))
    .map(i => ({
      ip: val(f, `${base}RouteHops.${i}.HopHostAddress`) || val(f, `${base}RouteHops.${i}.HopHost`) || null,
      ms: String(val(f, `${base}RouteHops.${i}.HopRTTimes`) || '').split(',').map(Number).filter(isFinite)[0] ?? null,
    }));
  return { pronto: true, ok: saltos.length > 0, estado, saltos, totalMs: n('ResponseTime') || null };
}

function traduzirErroDiag(estado) {
  const m = {
    Error_CannotResolveHostName: 'o equipamento não conseguiu resolver o endereço (DNS)',
    Error_Internal: 'erro interno do equipamento',
    Error_Other: 'o equipamento não concluiu o teste',
    Error_InitConnectionFailed: 'não conseguiu abrir a conexão de teste',
    Error_NoResponse: 'o servidor de teste não respondeu',
    Error_TransferFailed: 'a transferência falhou no meio',
    Error_Timeout: 'o teste passou do tempo',
    Error_MaxHopCountExceeded: 'o destino está longe demais (saltos demais)',
  };
  return m[estado] || `o equipamento respondeu "${estado}"`;
}

export { val as _val };
