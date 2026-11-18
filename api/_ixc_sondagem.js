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

/* Caixas e contas do financeiro do IXC (tabela "contas"), para conferir com o
   MoviOne: de cada uma só o que a identifica — nome, se está ativa, tipo e
   banco — e quanto movimentou nos últimos dias (fn_movim_finan por id_conta).
   O registro do IXC traz também agência, número da conta, CNPJ, endereço e a
   credencial de integração do banco: passa só pela memória e é reduzido aqui
   aos campos desta lista. */
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
  let movs = [], erroMov = null;
  try {
    const m = await io.ixcListar('fn_movim_finan', { qtype: 'fn_movim_finan.data', query: desde, oper: '>=', sortorder: 'asc' }, { paginas: MAX_PAGINAS, rp: 1000 });
    movs = (m && m.registros) || [];
  } catch (err) { erroMov = String((err && err.message) || err).replace(/\d{6,}/g, '(número)').slice(0, 160); }
  const uso = new Map();
  for (const m of movs) {
    const id = String(m.id_conta ?? '').trim();
    if (!/^\d{1,9}$/.test(id)) continue;
    const u = uso.get(id) || { movimentos: 0, entradas: 0, saidas: 0, ultimo: null };
    u.movimentos++; u.entradas += valor(m.credito); u.saidas += valor(m.debito);
    const dt = String(m.data || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dt) && (!u.ultimo || dt > u.ultimo)) u.ultimo = dt;
    uso.set(id, u);
  }
  const ids = new Set();
  const contas = regs.map(r => {
    const id = String(r.id ?? '').trim(); ids.add(id);
    const u = uso.get(id) || { movimentos: 0, entradas: 0, saidas: 0, ultimo: null };
    const aberta = String(r.data_abertura || '');
    return { id: /^\d{1,9}$/.test(id) ? id : '?', nome: nomeDaConta(r.conta), ativo: String(r.ativo || '').toUpperCase() === 'S',
      tipo_conta: codigo(r.tipo_conta), modalidade: codigo(r.modalidade_conta), cod_banco: codigo(r.cod_banco), banco: nomeDaConta(r.razao_banco),
      filial_padrao: codigo(r.filial_padrao), aberta_em: /^\d{4}-\d{2}-\d{2}/.test(aberta) && !aberta.startsWith('0000') ? aberta.slice(0, 10) : null,
      movimentos: u.movimentos, entradas: reais(u.entradas), saidas: reais(u.saidas), ultimo_movimento: u.ultimo };
  }).sort((a, b) => (b.ativo - a.ativo) || (b.movimentos - a.movimentos) || (Number(a.id) - Number(b.id)));
  // movimento numa conta que não está no cadastro (só o id e quantos)
  const sem_cadastro = Object.fromEntries([...uso].filter(([id]) => !ids.has(id)).map(([id, u]) => [id, u.movimentos]).slice(0, 20));
  return { total: v && v.total != null ? Number(v.total) || regs.length : regs.length, ativas: contas.filter(c => c.ativo).length,
    movimentos_desde: desde, movimentos_lidos: movs.length, erro_movimentos: erroMov, contas, sem_cadastro };
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
