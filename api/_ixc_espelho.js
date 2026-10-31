// ============================================================================
// ESPELHO DO IXC — o cadastro do MoviOne atualizado pelo servidor
// ----------------------------------------------------------------------------
// O MoviOne guarda uma cópia do IXC (clientes, clientes_contratos e
// clientes_logins) que o resto do sistema lê: MoviTalk, cobrança, moviTec,
// Termo de Adesão. A cópia completa só andava quando alguém abria a aba
// Clientes no navegador. Aqui está a mesma cópia feita no servidor, para o
// agendador rodar sozinho (api/ixc-sync.js), e o mapeamento campo a campo
// que o MoviTalk (api/atendimento.js) usa para trazer os cadastros novos entre
// uma rodada e outra.
//
// O mapeamento é o do navegador (index.html: syncIXC e _SYNC_MAP). Os dois
// escrevem nas mesmas colunas e não podem discordar do significado — se um
// mudar, o outro muda junto.
// ============================================================================

// Datas do IXC: 'AAAA-MM-DD' (às vezes com hora) ou '0000-00-00' para vazio.
// Só passa adiante data de verdade: um valor estranho numa coluna date
// derrubaria a gravação do lote inteiro.
export function ixcData(v) {
  const t = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(t) && !t.startsWith('0000') ? t.slice(0, 10) : null;
}
export function ixcHora(v) {
  const t = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(t) && !t.startsWith('0000') ? t.slice(0, 19) : null;
}

// número com vírgula ou ponto; inválido vira 0 (o _numIXC do MoviOne)
export function numIxc(v) {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

// valor em dinheiro: zero ou inválido é "sem valor"
export function ixcNumero(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

// coordenada do IXC (pode vir vazia ou zero) em número válido ou null
export function ixcCoord(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  if (isNaN(n) || n === 0) return null;
  if (Math.abs(n) > 180) return null;
  return n;
}

/* 'ativo' do cliente no IXC vem como S/N. Mesma tradução do MoviOne — os dois
   escrevem na mesma coluna, não podem discordar do significado. */
export function ixcStatusCliente(ativo) {
  if (!ativo) return 'I';
  const v = String(ativo).toUpperCase();
  if (v === 'S' || v === '1' || v === 'TRUE') return 'A';
  if (v === 'N' || v === '0' || v === 'FALSE') return 'I';
  return v;
}

/* A velocidade não vem em campo próprio: está escrita no nome do plano
   ("PROMOÇÃO 500MEGA"). Mesma leitura do MoviOne. */
export function velocidadeDoPlano(nome) {
  const m = String(nome || '').match(/(\d+)\s*(g(?:iga)?|m(?:ega|b(?:ps?)?)?)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return m[2].toLowerCase().startsWith('g') ? n * 1000 : n;
}

/* Rótulo da situação de um contrato (status do contrato + status de acesso)
   e a situação do cliente pelos contratos dele: os do MoviOne
   (calcStatusContrato e agregarStatusCliente). */
export function calcStatusContrato(statusContrato, statusAcesso) {
  const sc = (statusContrato || '').toUpperCase();
  const sa = (statusAcesso || '').toUpperCase();
  if (sc === 'D' || sc === 'DS' || sc === 'C' || sc === 'EC') return 'Cancelado';
  if (sc === 'N') return 'Negativado';
  if (sc === 'I') return 'Inativo';
  if (sc === 'P' || sc === 'PC' || sc === 'CM' || sc === 'AB') return 'Pré-contrato';
  if (sc === 'A' || sc === 'AT') {
    if (['CM', 'S', 'SU', 'B'].includes(sa)) return 'Bloqueio Manual';
    if (sa === 'D' || sa === 'DM') return 'Bloqueio Manual';
    if (sa === 'CA' || sa === 'BL') return 'Bloqueio Automático';
    if (sa === 'FA') return 'Financeiro em Atraso';
    if (sa === 'AA') return 'Aguardando Assinatura';
    return 'Ativo';
  }
  if (sc === 'S') return 'Ativo';
  return sc || '—';
}
const PRIORIDADE_SITUACAO = ['Ativo', 'Financeiro em Atraso', 'Bloqueio Manual', 'Bloqueio Automático',
  'Aguardando Assinatura', 'Pré-contrato', 'Negativado', 'Inativo', 'Cancelado'];
export function agregarStatusCliente(contratos) {
  if (!contratos || !contratos.length) return null;
  const lista = contratos.map(c => calcStatusContrato(c.status_contrato, c.status_acesso));
  for (const p of PRIORIDADE_SITUACAO) if (lista.includes(p)) return p;
  return lista[0];
}

/* Wi-Fi pelo nome da chave (o _extrairWifi do MoviOne): cada IXC usa um nome.
   'radusuarios' é o login PPPoE — ali a chave 'senha' pura é a do PPPoE e
   nunca entra; 'radio' é a configuração da ONU, onde 'senha' pura é do Wi-Fi. */
export function extrairWifi(reg, contexto = 'radusuarios') {
  const ssids = [], senhas = [];
  for (const [k, v] of Object.entries(reg || {})) {
    if (v == null || v === '' || v === '0') continue;
    const kl = k.toLowerCase();
    const ehSenha = /senha|pass|pwd|key|chave/.test(kl);
    const ehWifi = /ssid|wifi|wlan|sem_fio/.test(kl);
    const ehRoteador = /roteador|router/.test(kl);
    const senhaWifiPura = contexto === 'radio' && ehSenha && !/pppoe|login|md5|hash/.test(kl);
    if (ehWifi || ehRoteador || (contexto === 'radio' && (kl === 'ssid' || /^ssid_/.test(kl))) || senhaWifiPura) {
      if (ehRoteador && !ehWifi) continue;          // usuário/senha do roteador não é Wi-Fi
      const val = String(v);
      if (ehSenha || senhaWifiPura) senhas.push(val);
      else if (/ssid/.test(kl)) ssids.push(val);
    }
  }
  return { ssid: [...new Set(ssids)].join(' · '), senha: [...new Set(senhas)].join(' · ') };
}

// planos de venda (vd_contratos): o contrato guarda só o NÚMERO do plano
export function planosDoIxc(regs) {
  return new Map((regs || []).map(p => [String(p.id), {
    nome: p.nome || p.descricao || '',
    valor: numIxc(p.valor_contrato || p.valor) || null,
  }]));
}

export function linhaClienteDoIxc(r) {
  const nome = r.fantasia || r.razao || '';
  return {
    ixc_id: String(r.id || ''),
    origem: 'ixc',
    ixc_status: ixcStatusCliente(r.ativo),
    ixc_login: r.login || null,
    ixc_senha: r.senha || null,
    nome,
    razao: r.razao || null,
    nome_social: r.fantasia || null,
    cnpj: r.cnpj_cpf || null,
    ie: r.ie || null,
    tipo_pessoa: r.tipo_pessoa || null,
    contato: r.contato || null,
    tel1: r.telefone_celular || r.telefone || null,
    tel2: r.telefone || null,
    whatsapp: r.whatsapp || r.telefone_celular || null,
    tel_residencial: r.fone1 || r.telefone || null,
    tel_comercial: r.fone2 || r.telefone_comercial || null,
    email: r.email || null,
    website: r.url || null,
    endereco: r.endereco || null,
    numero: r.numero || null,
    complemento: r.complemento || null,
    bairro: r.bairro || null,
    cep: r.cep || null,
    cep_full: r.cep || null,
    cidade: r.cidade || null,
    uf: r.uf || null,
    referencia: r.referencia || null,
    data_nasc: ixcData(r.data_nascimento),
    genero: r.sexo === 'M' ? 'Masculino' : r.sexo === 'F' ? 'Feminino' : null,
    estado_civil: r.estado_civil || null,
    nacionalidade: r.nacionalidade || null,
    naturalidade: r.naturalidade || null,
    profissao: r.profissao || null,
    rg_emissor: r.orgao_emissor || null,
    moradia: r.tipo_moradia || null,
    obs: r.obs || null,
    ativo: r.ativo === 'S',
    data_cadastro_ixc: ixcData(r.data_cadastro || r.data_cad || r.data_criacao),
    // datacad NÃO vai no corpo de propósito. No PostgREST, coluna ausente do
    // corpo fica fora do ON CONFLICT DO UPDATE — então reenviar um cliente
    // nunca reescreve a data de cadastro dele. Linha nova o banco preenche
    // sozinho (default current_date). Latitude e longitude ficam de fora pelo
    // mesmo motivo: a coordenada que o técnico capturou em campo é melhor que
    // a do IXC e não pode ser apagada por uma cópia.
  };
}

export function linhaContratoDoIxc(r, clienteIdLocal, planos) {
  const idPlano = String(r.id_vd_contrato || '');
  const pv = planos ? planos.get(idPlano) : null;
  // nome do plano: descrição auxiliar > plano de venda (vd_contratos) >
  // descrição do contrato > número. Sem o plano de venda, 9 em cada 10
  // contratos ficavam com o plano "31", "34"…
  const plano = r.descricao_aux_plano_venda || (pv && pv.nome) || r.contrato || r.descricao_aux || r.descricao || idPlano;
  return {
    ixc_id: String(r.id || ''),
    ixc_cliente_id: String(r.id_cliente || '') || null,
    cliente_id: clienteIdLocal || null,
    tipo: r.tipo || null,
    plano: plano || null,
    id_plano_venda: idPlano || null,
    velocidade_mbps: velocidadeDoPlano(plano) || null,
    descricao: r.descricao || null,
    status_contrato: r.status || null,
    status_acesso: r.status_internet || r.status_acesso || null,
    // o contrato raramente traz valor próprio: cai no valor do plano de venda
    valor: parseFloat(String(r.valor_servico || r.valor || r.mensalidade || '0').replace(',', '.')) || (pv && pv.valor) || null,
    data_ativacao: ixcData(r.data_ativacao),
    data_renovacao: ixcData(r.data_renovacao),
    // o campo do IXC é pago_ate_data — lendo só pago_ate, ficava vazio
    pago_ate: ixcData(r.pago_ate_data || r.pago_ate),
    data_expiracao: ixcData(r.data_expiracao),
    // o Termo de Adesão usa (nomes conferidos no catálogo ixc_campos)
    fidelidade_meses: parseInt(r.tempo_contrato || r.meses_contrato || r.fidelidade, 10) || null,
    id_carteira_cobranca: String(r.id_carteira_cobranca || '') || null,
    cartao_recorrente: !!String(r.credit_card_recorrente_bandeira_cartao || '').trim(),
    taxa_instalacao: r.taxa_instalacao == null || r.taxa_instalacao === '' ? null : numIxc(r.taxa_instalacao),
  };
}

/* O login (radusuarios). Plano e velocidade vêm do contrato do login. O Wi-Fi
   é o que o IXC trouxe; sem nada, fica o que já estava — a senha pode ter
   vindo da ONU ou sido anotada à mão, e uma cópia nunca a apaga. */
export function linhaLoginDoIxc(r, { clienteId = null, contratoId = null, contrato = null, atual = null } = {}) {
  const w = extrairWifi(r, 'radusuarios');
  return {
    ixc_id: String(r.id || ''),
    ixc_cliente_id: String(r.id_cliente || '') || null,
    ixc_contrato_id: String(r.id_contrato || '') || null,
    cliente_id: clienteId || null,
    contrato_id: contratoId || null,
    login: r.login || null,
    senha: r.senha || null,
    autenticacao: r.tipo_login || r.autenticacao || 'PPPoE',
    tipo_conexao: r.tipo_conexao || null,
    ativo: r.ativo === 'S',
    online: r.online === 'S',
    plano: (contrato && contrato.plano) || r.id_plano || null,
    velocidade_mbps: (contrato && contrato.velocidade_mbps) || null,
    ssid: w.ssid || (atual && atual.ssid) || null,
    senha_wifi: w.senha || (atual && atual.senha_wifi) || null,
    ip: r.ip || r.enderecoip || r.ultimo_ip || null,
    mac: r.mac || r.mac_address || r.onu_mac || null,
    ultima_conexao_ini: ixcHora(r.ultima_conexao_inicial),
    ultima_conexao_fim: ixcHora(r.ultima_conexao_final),
    // Termo de Adesão: grupo de velocidade, IP fixo (S) e equipamento (C comodato / P próprio)
    id_grupo: String(r.id_grupo || '') || null,
    fixar_ip: r.fixar_ip || null,
    tipo_equipamento: r.tipo_equipamento || null,
  };
}

// ---------------------------------------------------------------------------
// A cópia completa
// ---------------------------------------------------------------------------

export const COLUNAS_CLIENTE = Object.keys(linhaClienteDoIxc({})).filter(k => k !== 'ixc_id').concat('status_contrato');
export const COLUNAS_CONTRATO = Object.keys(linhaContratoDoIxc({})).filter(k => k !== 'ixc_id');
export const COLUNAS_LOGIN = Object.keys(linhaLoginDoIxc({})).filter(k => k !== 'ixc_id');

const NUMERICAS = new Set(['valor', 'taxa_instalacao', 'velocidade_mbps', 'fidelidade_meses', 'cliente_id', 'contrato_id']);

/* Mesmo valor, escrito de outro jeito, não é mudança: '' e null são "vazio";
   89.9 e "89.90" são o mesmo número. Sem isso toda rodada regravaria a base
   inteira — e cada linha regravada vira um aviso em tempo real para quem
   está com o MoviOne aberto, que relê a tabela. */
function igual(col, a, b) {
  const va = a === '' || a === undefined ? null : a;
  const vb = b === '' || b === undefined ? null : b;
  if (va === null || vb === null) return va === vb;
  if (NUMERICAS.has(col)) return Math.abs(Number(va) - Number(vb)) < 1e-9;
  if (typeof va === 'boolean' || typeof vb === 'boolean') return String(va) === String(vb);
  return String(va) === String(vb);
}
export function mudou(nova, atual, colunas) {
  return colunas.some(c => !igual(c, nova[c], atual[c]));
}

/* Lê o IXC inteiro (cliente, cliente_contrato, radusuarios e vd_contratos),
   compara com o que o banco tem e grava só o que mudou.

   io: { ixcTudo(tabela) -> registros,
         sbTudo(caminho) -> linhas,
         sbUpsert(tabela, linhas, { retornar }) -> [{ id, ixc_id }] quando retornar,
         sbRpc(nome, corpo) }

   O que NÃO acontece aqui, de propósito:
   - apagar: quem sumiu do IXC continua no MoviOne (é o que o navegador faz);
   - mexer em coordenada fixada, data de cadastro, site ou observação do login;
   - zerar a situação dos clientes quando a lista de contratos vier vazia ou
     pela metade (uma falha do IXC não pode virar "sem contrato" para todos). */
export async function sincronizarTudoDoIxc(io) {
  const inicio = Date.now();
  const avisos = [];
  const pedir = (tabela, obrigatoria) => io.ixcTudo(tabela).then(
    regs => ({ regs, ok: true }),
    err => {
      if (obrigatoria) throw err;
      avisos.push(`${tabela}: ${String(err.message || err).slice(0, 160)}`);
      return { regs: [], ok: false };
    });
  const [cli, ctr, log, pla] = await Promise.all([
    pedir('cliente', true), pedir('cliente_contrato'), pedir('radusuarios'), pedir('vd_contratos'),
  ]);

  const [cliDb, ctrDb, logDb] = await Promise.all([
    io.sbTudo(`clientes?select=id,ixc_id,latitude,longitude,coord_fixada,${COLUNAS_CLIENTE.join(',')}&ixc_id=not.is.null&order=id.asc`),
    io.sbTudo(`clientes_contratos?select=id,ixc_id,${COLUNAS_CONTRATO.join(',')}&ixc_id=not.is.null&order=id.asc`),
    io.sbTudo(`clientes_logins?select=id,ixc_id,${COLUNAS_LOGIN.join(',')}&ixc_id=not.is.null&order=id.asc`),
  ]);
  if (!cli.regs.length && cliDb.length) throw new Error('o IXC devolveu a lista de clientes vazia');

  // lista de contratos que não dá para confiar: vazia, ou menos da metade da
  // que já temos (o IXC não apaga contrato, cancela). Leitura que parou no
  // meio o ixcTudo já acusa pelo total que o próprio IXC informa; isto pega o
  // resto, com folga para contrato apagado no IXC não virar alarme eterno.
  let contratosOk = ctr.ok;
  if (contratosOk && ctrDb.length && (!ctr.regs.length || (ctrDb.length >= 20 && ctr.regs.length < ctrDb.length * 0.5))) {
    contratosOk = false;
    avisos.push(`cliente_contrato: o IXC trouxe ${ctr.regs.length} de ${ctrDb.length} contratos; contratos, logins e situação ficam para a próxima rodada`);
  }
  // sem os planos de venda, o nome do plano voltaria a ser o número dele
  const planosOk = pla.ok;
  if (!planosOk && contratosOk) avisos.push('sem os planos de venda: contratos e logins ficam para a próxima rodada');
  const planos = planosDoIxc(pla.regs);

  const porIxc = linhas => new Map(linhas.map(l => [String(l.ixc_id), l]));
  const cliAtual = porIxc(cliDb), ctrAtual = porIxc(ctrDb), logAtual = porIxc(logDb);
  const idCliente = new Map(cliDb.map(c => [String(c.ixc_id), c.id]));
  const idContrato = new Map(ctrDb.map(c => [String(c.ixc_id), c.id]));

  // ---- 1) clientes, com a situação calculada pelos contratos ----
  const situacaoDe = new Map();          // ixc do cliente -> contratos
  if (contratosOk) {
    const vistos = new Set();
    for (const r of ctr.regs) {
      const k = String(r.id_cliente || '');
      vistos.add(String(r.id || ''));
      if (!k) continue;
      if (!situacaoDe.has(k)) situacaoDe.set(k, []);
      situacaoDe.get(k).push({ status_contrato: r.status || null, status_acesso: r.status_internet || r.status_acesso || null });
    }
    // contrato que só o MoviOne ainda tem também conta (como no navegador)
    for (const c of ctrDb) {
      if (vistos.has(String(c.ixc_id)) || !c.ixc_cliente_id) continue;
      const k = String(c.ixc_cliente_id);
      if (!situacaoDe.has(k)) situacaoDe.set(k, []);
      situacaoDe.get(k).push(c);
    }
  }
  const colsCli = contratosOk ? COLUNAS_CLIENTE : COLUNAS_CLIENTE.filter(c => c !== 'status_contrato');
  const linhasCli = [], coords = [];
  let novosCli = 0;
  for (const r of cli.regs) {
    const linha = linhaClienteDoIxc(r);
    if (!linha.ixc_id) continue;
    if (contratosOk) linha.status_contrato = agregarStatusCliente(situacaoDe.get(linha.ixc_id) || []);
    const atual = cliAtual.get(linha.ixc_id);
    if (!atual) { novosCli++; linhasCli.push(linha); }
    else if (mudou(linha, atual, colsCli)) linhasCli.push(linha);
    // coordenada: só preenche ou corrige com a do IXC; a fixada pelo técnico fica
    const lat = ixcCoord(r.latitude), lng = ixcCoord(r.longitude);
    if (lat != null && lng != null && !(atual && atual.coord_fixada)
        && (!atual || !igual('valor', lat, atual.latitude) || !igual('valor', lng, atual.longitude))) {
      coords.push({ ixc_id: linha.ixc_id, lat, lng });
    }
  }
  if (linhasCli.length) {
    const voltou = await io.sbUpsert('clientes', linhasCli, { retornar: true });
    for (const c of voltou || []) idCliente.set(String(c.ixc_id), c.id);
  }
  if (coords.length) await io.sbRpc('atualizar_coords_ixc_lote', { p_dados: coords });

  // ---- 2) contratos ----
  let ctrMudados = 0, novosCtr = 0;
  const contratoPorIxc = new Map();       // para o plano e a velocidade do login
  for (const c of ctrDb) contratoPorIxc.set(String(c.ixc_id), c);
  if (contratosOk && planosOk) {
    const linhas = [];
    for (const r of ctr.regs) {
      const linha = linhaContratoDoIxc(r, idCliente.get(String(r.id_cliente || '')), planos);
      if (!linha.ixc_id) continue;
      contratoPorIxc.set(linha.ixc_id, linha);
      const atual = ctrAtual.get(linha.ixc_id);
      if (!atual) { novosCtr++; linhas.push(linha); }
      else if (mudou(linha, atual, COLUNAS_CONTRATO)) linhas.push(linha);
    }
    if (linhas.length) {
      const voltou = await io.sbUpsert('clientes_contratos', linhas, { retornar: true });
      for (const c of voltou || []) idContrato.set(String(c.ixc_id), c.id);
    }
    ctrMudados = linhas.length;
  }

  // ---- 3) logins ----
  let logMudados = 0, novosLog = 0;
  if (log.ok && contratosOk && planosOk) {
    const linhas = [];
    for (const r of log.regs) {
      const ixcCtr = String(r.id_contrato || '');
      const atual = logAtual.get(String(r.id || '')) || null;
      const linha = linhaLoginDoIxc(r, {
        clienteId: idCliente.get(String(r.id_cliente || '')),
        contratoId: idContrato.get(ixcCtr),
        contrato: contratoPorIxc.get(ixcCtr) || null,
        atual,
      });
      if (!linha.ixc_id) continue;
      if (!atual) { novosLog++; linhas.push(linha); }
      else if (mudou(linha, atual, COLUNAS_LOGIN)) linhas.push(linha);
    }
    if (linhas.length) await io.sbUpsert('clientes_logins', linhas, {});
    logMudados = linhas.length;
  }

  return {
    clientes: { ixc: cli.regs.length, novos: novosCli, atualizados: linhasCli.length - novosCli },
    contratos: { ixc: ctr.regs.length, novos: novosCtr, atualizados: ctrMudados - novosCtr, gravados: contratosOk && planosOk },
    logins: { ixc: log.regs.length, novos: novosLog, atualizados: logMudados - novosLog, gravados: log.ok && contratosOk && planosOk },
    coordenadas: coords.length,
    situacao_calculada: contratosOk,
    avisos,
    ms: Date.now() - inicio,
  };
}

/* Grupos de velocidade e carteiras de cobrança: tabelas pequenas do IXC que
   o Termo de Adesão usa. Das carteiras vão só id, descrição e tipo de
   recebimento — nunca conta, convênio, chave ou token (como no navegador). */
export async function sincronizarApoioDoIxc(io) {
  const [grupos, carteiras] = await Promise.all([
    io.ixcTudo('radgrupos').catch(() => []),
    io.ixcTudo('fn_carteira_cobranca').catch(() => []),
  ]);
  const agora = new Date().toISOString();
  if (grupos.length) {
    await io.sbUpsert('ixc_radgrupos', grupos.filter(g => g.id).map(g => ({
      id: String(g.id), grupo: g.grupo || null, download: g.download || null, upload: g.upload || null, atualizado_em: agora,
    })), { conflito: 'id' });
  }
  if (carteiras.length) {
    await io.sbUpsert('ixc_carteiras', carteiras.filter(c => c.id).map(c => ({
      id: String(c.id), descricao: c.descricao || null, tipo_recebimento: c.tipo_recebimento || null,
      ativo: c.ativo == null ? null : c.ativo === 'S', atualizado_em: agora,
    })), { conflito: 'id' });
  }
  return { grupos: grupos.length, carteiras: carteiras.length };
}
