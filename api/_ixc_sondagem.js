// ============================================================================
// SONDAGEM DO IXC (só leitura, só estrutura)
// ----------------------------------------------------------------------------
// Para descobrir onde o IXC guarda uma informação sem trazer dado de cliente:
// para cada tabela pedida, o total de registros e os NOMES dos campos do
// primeiro registro; com `contar`, quantos registros têm cada código curto num
// campo técnico (ex.: tipo_produtos_plano = P/C). Campo sensível ou que pode ter
// dado pessoal nunca é contado. O pedido fica em ixc_sync_config.sondagem_pedido
// e o resultado em sondagem_resultado (a rodada das OS atende e limpa o pedido).
// ============================================================================
import { CAMPO_SENSIVEL } from './_ixc_espelho.js';

// mesmos nomes de campo que a localização trata como pessoais
const PESSOAL = /cpf|cnpj|rg|identidade|ie_|inscricao|^im$|fone|telefone|celular|whatsapp|ramal|email|skype|facebook|website|nome|razao|fantasia|contato|responsavel|endereco|numero|bairro|cep|complemento|referencia|bloco|apartamento|cidade|uf|nascimento|pai|mae|conjuge|dependentes|representante|titular|contador|ref_|emp_|profissao|nacionalidade|naturalidade|sexo|estado_civil|moradia|obs|alerta|conta|agencia|deb_|^pis$|foto|idx|indicado|crm|latitude|longitude|login|cif|mensagem|descricao|historico|linha_digitavel|codigo_barras|nosso_numero|pix/i;
const TABELA = /^[a-z][a-z0-9_]{2,40}$/;
export const MAX_TABELAS = 6;
const MAX_PAGINAS = 5;                  // 5 mil registros por tabela no máximo

// nomes técnicos que esbarram na lista de pessoais ("onu_numero" tem "numero")
const TECNICOS = new Set(['onu_numero']);
export const podeContar = campo => typeof campo === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(campo) && (TECNICOS.has(campo) || (!PESSOAL.test(campo) && !CAMPO_SENSIVEL.test(campo)));
// só código curto aparece como chave da contagem; o resto vira "(outro)"
const codigo = v => { const s = v == null ? '' : String(v).trim(); return /^[A-Za-z0-9_.,-]{0,12}$/.test(s) ? s : '(outro)'; };
// o formato do valor, sem o valor: letra vira A, dígito vira 9 ("0/1/3" → "9/9/9")
export const formato = v => { const s = v == null ? '' : String(v).trim(); return s.replace(/[A-Za-zÀ-ÿ]/g, 'A').replace(/\d/g, '9').slice(0, 24); };
const maiores = (m, n) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n));

/* A grade "ONUs não autorizadas" devolve linhas { id, cell: [...] }: o id é um
   mapa do PHP em base64 (ID da OLT, SLOT, PON, MAC...). Daqui saem só os NOMES
   das chaves e o formato de cada célula. */
export function chavesDoIdDaGrade(id) {
  try {
    const txt = Buffer.from(String(id || ''), 'base64').toString('utf8');
    return [...new Set([...txt.matchAll(/s:\d+:"([^"]{1,30})";/g)].map(m => m[1]).filter(k => /^[A-Z_]{2,20}$/.test(k)))].slice(0, 30);
  } catch { return []; }
}
async function sondarPendentes(io, olt) {
  if (!/^[1-9]\d{0,8}$/.test(String(olt || ''))) return { erro: 'OLT inválida' };
  if (typeof io.ixcGrade !== 'function') return { erro: 'leitura da grade indisponível' };
  const d = await io.ixcGrade('fh_onu_nao_autorizadas', { olt: String(olt) });
  const linhas = Array.isArray(d && d.registros) ? d.registros : Array.isArray(d && d.rows) ? d.rows : Array.isArray(d) ? d : [];
  const r = { chaves_da_resposta: d && typeof d === 'object' && !Array.isArray(d) ? Object.keys(d).sort() : [], tipo: (d && d.type) || null,
    total: d && d.total != null ? String(d.total).slice(0, 8) : null, linhas: linhas.length,
    mensagem: d && d.message ? String(d.message).replace(/<[^>]+>/g, ' ').replace(/\d{6,}/g, '(número)').slice(0, 160) : null };
  const l = linhas[0];
  if (l && typeof l === 'object') {
    r.campos = Object.keys(l).sort();
    if (Array.isArray(l.cell)) { r.celulas = l.cell.length; r.formato_celulas = l.cell.map(formato); r.chaves_do_id = chavesDoIdDaGrade(l.id); }
    else r.formatos = Object.fromEntries(Object.keys(l).filter(podeContar).slice(0, 30).map(k => [k, formato(l[k])]));
  }
  return r;
}

/* Onde está a localização de uma OS: no próprio chamado, no login dela ou no
   cadastro do cliente, e qual delas o moviTec mostra (a cópia do cadastro, com
   a marca de "fixada pelo técnico"). Sai só a DISTÂNCIA em metros entre os
   pontos, a origem do endereço (código curto) e as horas de atualização:
   nenhuma coordenada, nenhum endereço. */
const coordDe = r => {
  const la = Number(String((r && r.latitude) ?? '').replace(',', '.')), lo = Number(String((r && r.longitude) ?? '').replace(',', '.'));
  return Number.isFinite(la) && Number.isFinite(lo) && la !== 0 && lo !== 0 && Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? { la, lo } : null;
};
const metros = (a, b) => {
  if (!a || !b) return null;
  const t = x => x * Math.PI / 180, dLa = t(b.la - a.la), dLo = t(b.lo - a.lo);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(t(a.la)) * Math.cos(t(b.la)) * Math.sin(dLo / 2) ** 2;
  return Math.round(2 * 6371e3 * Math.asin(Math.sqrt(h)));
};
const horaIxc = r => { const s = String((r && r.ultima_atualizacao) || '').trim(); return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) && !s.startsWith('0000') ? s : null; };
export async function sondarLocalizacaoDaOs(io, osId) {
  const idOk = v => /^[1-9]\d{0,9}$/.test(String(v ?? ''));
  if (!idOk(osId)) return { erro: 'OS inválida' };
  const um = async (t, id) => {
    if (!idOk(id)) return null;
    const v = await io.ixcListar(t, { qtype: `${t}.id`, query: String(id), oper: '=' }, { paginas: 1, rp: 1 });
    return (v && v.registros && v.registros[0]) || null;
  };
  const os = await um('su_oss_chamado', osId);
  if (!os) return { erro: 'OS não encontrada no IXC' };
  const [login, cli] = await Promise.all([um('radusuarios', os.id_login).catch(() => null), um('cliente', os.id_cliente).catch(() => null)]);
  let copia = null;
  if (typeof io.sb === 'function' && idOk(os.id_cliente)) {
    const l = await io.sb(`clientes?ixc_id=eq.${String(os.id_cliente)}&select=latitude,longitude,coord_fixada&limit=1`).catch(() => null);
    copia = (Array.isArray(l) && l[0]) || null;
  }
  const p = { os: coordDe(os), login: coordDe(login), cliente: coordDe(cli), copia: coordDe(copia) };
  return {
    origem_endereco: codigo(os.origem_endereco), status: codigo(os.status),
    tem: { os: !!p.os, login: !!p.login, cliente: !!p.cliente, copia: !!p.copia, login_achado: !!login },
    copia_fixada: copia ? copia.coord_fixada === true : null,
    distancias_m: {
      os_login: metros(p.os, p.login), os_cliente: metros(p.os, p.cliente), login_cliente: metros(p.login, p.cliente),
      copia_os: metros(p.copia, p.os), copia_login: metros(p.copia, p.login), copia_cliente: metros(p.copia, p.cliente),
    },
    atualizado: { os: horaIxc(os), login: horaIxc(login), cliente: horaIxc(cli) },
  };
}

/* Caixas e contas do financeiro do IXC (tabela "contas"), para conferir com o
   MoviOne: de cada uma só o que a identifica — nome, se está ativa, tipo e
   banco — e quanto recebeu nos últimos dias (títulos baixados em fn_areceber).
   O registro do IXC traz também agência, número da conta, CNPJ, endereço e a
   credencial de integração do banco: passa só pela memória e é reduzido aqui
   aos campos desta lista. Do título só sai a soma por conta.
   Atenção: em fn_movim_finan o id_conta é a conta do PLANO DE CONTAS (ids na
   casa das centenas/milhares), não o caixa — conferido em 18/11/2026. */
// campos do título que podem apontar o caixa/conta da baixa (o primeiro que bater com um id de "contas" vale)
const CAMPOS_CONTA_DA_BAIXA = ['conta_recebimento', 'id_conta'];
const nomeDaConta = v => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!s) return '';
  return /^[\d\s.\-/xX]+$/.test(s) ? '(número)' : s.replace(/\d{5,}/g, '(número)');   // nome que é número de conta não sai
};
const valor = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const reais = n => Math.round(n * 100) / 100;
export async function sondarContasFinanceiro(io, { dias = 30, agora = new Date() } = {}) {
  const d = Math.min(Math.max(parseInt(dias, 10) || 30, 1), 120);
  const v = await io.ixcListar('contas', { qtype: 'contas.id', query: '0', oper: '>', sortorder: 'asc' }, { paginas: 1, rp: 200 });
  const regs = (v && v.registros) || [];
  const desde = new Date(agora.getTime() - d * 864e5).toISOString().slice(0, 10);
  const ids = new Set(regs.map(r => String(r.id ?? '').trim()).filter(id => /^\d{1,9}$/.test(id)));
  // títulos baixados no período: a soma vai para o caixa/conta que o título aponta
  let titulos = [], erroRec = null;
  try {
    const m = await io.ixcListar('fn_areceber', { qtype: 'fn_areceber.pagamento_data', query: desde, oper: '>=', sortorder: 'asc' }, { paginas: MAX_PAGINAS, rp: 1000 });
    titulos = (m && m.registros) || [];
  } catch (err) { erroRec = String((err && err.message) || err).replace(/\d{6,}/g, '(número)').slice(0, 160); }
  const uso = new Map(), campo_da_conta = { nenhum: 0 };
  for (const c of CAMPOS_CONTA_DA_BAIXA) campo_da_conta[c] = 0;
  for (const tt of titulos) {
    if (!['R', 'P'].includes(String(tt.status || '').toUpperCase())) continue;     // recebido ou parcial
    const campo = CAMPOS_CONTA_DA_BAIXA.find(c => ids.has(String(tt[c] ?? '').trim()));
    if (!campo) { campo_da_conta.nenhum++; continue; }
    campo_da_conta[campo]++;
    const id = String(tt[campo]).trim();
    const u = uso.get(id) || { recebimentos: 0, recebido: 0, ultimo: null };
    u.recebimentos++; u.recebido += valor(tt.valor_recebido) || valor(tt.pagamento_valor);
    const dt = String(tt.pagamento_data || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dt) && (!u.ultimo || dt > u.ultimo)) u.ultimo = dt;
    uso.set(id, u);
  }
  const contas = regs.map(r => {
    const id = String(r.id ?? '').trim();
    const u = uso.get(id) || { recebimentos: 0, recebido: 0, ultimo: null };
    const aberta = String(r.data_abertura || '');
    return { id: /^\d{1,9}$/.test(id) ? id : '?', nome: nomeDaConta(r.conta), ativo: String(r.ativo || '').toUpperCase() === 'S',
      tipo_conta: codigo(r.tipo_conta), modalidade: codigo(r.modalidade_conta), cod_banco: codigo(r.cod_banco), banco: nomeDaConta(r.razao_banco),
      filial_padrao: codigo(r.filial_padrao), aberta_em: /^\d{4}-\d{2}-\d{2}/.test(aberta) && !aberta.startsWith('0000') ? aberta.slice(0, 10) : null,
      recebimentos: u.recebimentos, recebido: reais(u.recebido), ultimo_recebimento: u.ultimo };
  }).sort((a, b) => (b.ativo - a.ativo) || (b.recebimentos - a.recebimentos) || (Number(a.id) - Number(b.id)));
  return { total: v && v.total != null ? Number(v.total) || regs.length : regs.length, ativas: contas.filter(c => c.ativo).length,
    recebimentos_desde: desde, titulos_lidos: titulos.length, campo_da_conta, erro_recebimentos: erroRec, contas };
}

/* Pedido: [{ tabela, contar?: [campos], filtro?: { qtype, query, oper } }]
   ou { contas_financeiro: true, dias? } para os caixas e contas do financeiro. */
export async function sondarIxc(io, pedido, { agora = new Date() } = {}) {
  const itens = (Array.isArray(pedido) ? pedido : []).slice(0, MAX_TABELAS);
  const tabelas = {};
  for (const it of itens) {
    if (it && it.contas_financeiro === true) {
      try { tabelas.contas_financeiro = await sondarContasFinanceiro(io, { dias: it.dias, agora }); }
      catch (err) { tabelas.contas_financeiro = { erro: String((err && err.message) || err).replace(/\d{6,}/g, '(número)').slice(0, 200) }; }
      continue;
    }
    if (it && it.localizacao_os != null) {
      const k = `localizacao_os_${String(it.localizacao_os).replace(/\D/g, '').slice(0, 10)}`;
      try { tabelas[k] = await sondarLocalizacaoDaOs(io, it.localizacao_os); }
      catch (err) { tabelas[k] = { erro: String((err && err.message) || err).replace(/\d{6,}/g, '(número)').slice(0, 200) }; }
      continue;
    }
    if (it && it.pendentes_olt != null) {
      try { tabelas[`onus_pendentes_olt_${String(it.pendentes_olt).slice(0, 9)}`] = await sondarPendentes(io, it.pendentes_olt); }
      catch (err) { tabelas[`onus_pendentes_olt_${String(it.pendentes_olt).slice(0, 9)}`] = { erro: String((err && err.message) || err).replace(/\d{6,}/g, '(número)').slice(0, 200) }; }
      continue;
    }
    const t = String((it && it.tabela) || '');
    if (!TABELA.test(t)) { tabelas[t || '?'] = { erro: 'nome de tabela inválido' }; continue; }
    const f = it.filtro && typeof it.filtro === 'object' ? it.filtro : null;
    const filtro = f && /^[a-z0-9_.]{3,80}$/.test(String(f.qtype || '')) && ['=', '>', '<', '>=', '<=', '!=', 'L'].includes(f.oper || '=')
      ? { qtype: String(f.qtype), query: String(f.query ?? '').slice(0, 40), oper: f.oper || '=' }
      : { qtype: `${t}.id`, query: '0', oper: '>' };
    const contar = (Array.isArray(it.contar) ? it.contar : []).filter(podeContar).slice(0, 10);
    // combinações de campos técnicos (ex.: OLT × perfil × VLAN) e formato dos valores
    const cruzar = (Array.isArray(it.cruzar) ? it.cruzar : []).map(g => (Array.isArray(g) ? g : []).filter(podeContar).slice(0, 5)).filter(g => g.length >= 2).slice(0, 4);
    const formatos = (Array.isArray(it.formatos) ? it.formatos : []).filter(podeContar).slice(0, 10);
    const tudo = contar.length || cruzar.length || formatos.length || it.preenchidos === true;
    try {
      const v = await io.ixcListar(t, { ...filtro, sortorder: 'asc' }, { paginas: tudo ? MAX_PAGINAS : 1, rp: tudo ? 1000 : 1 });
      const regs = (v && v.registros) || [];
      const r = { total: v ? v.total : 0, lidos: regs.length, campos: regs[0] ? Object.keys(regs[0]).sort() : [] };
      if (contar.length) {
        r.contagem = {};
        for (const c of contar) {
          const m = {};
          for (const reg of regs) { const k = codigo(reg[c]); m[k] = (m[k] || 0) + 1; }
          r.contagem[c] = m;
        }
        const ignorados = (Array.isArray(it.contar) ? it.contar : []).filter(c => !podeContar(c));
        if (ignorados.length) r.nao_contados = ignorados.map(String).slice(0, 10);
      }
      if (cruzar.length) {
        r.cruzado = {};
        for (const g of cruzar) {
          const m = {};
          for (const reg of regs) { const k = g.map(c => codigo(reg[c])).join(' | '); m[k] = (m[k] || 0) + 1; }
          r.cruzado[g.join(' | ')] = maiores(m, 60);
        }
      }
      if (formatos.length) {
        r.formatos = {};
        for (const c of formatos) {
          const m = {};
          for (const reg of regs) { const k = formato(reg[c]); m[k] = (m[k] || 0) + 1; }
          r.formatos[c] = maiores(m, 12);
        }
      }
      // em quantos registros cada campo vem preenchido (só o nome do campo e a conta)
      if (it.preenchidos === true) {
        r.preenchidos = {};
        for (const c of r.campos) r.preenchidos[c] = regs.filter(reg => reg[c] != null && String(reg[c]).trim() !== '' && String(reg[c]).trim() !== '0').length;
      }
      tabelas[tabelas[t] ? `${t}#${Object.keys(tabelas).length}` : t] = r;
    } catch (err) {
      tabelas[t] = { erro: String((err && err.message) || err).replace(/\d{6,}/g, '(número)').slice(0, 200) };
    }
  }
  return { em: agora.toISOString(), tabelas };
}
