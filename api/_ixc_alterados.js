// ============================================================================
// CADASTROS ALTERADOS NO IXC → cópia do MoviOne e OS em aberto do moviTec
// ----------------------------------------------------------------------------
// Roda na rodada de 2 min das OS (api/ixc-sync.js), ANTES de trazer OS nova:
// o cadastro que o escritório mexeu no IXC (cliente.ultima_atualizacao) entra
// na cópia — com a localização — e a OS que chega ao celular já nasce com o
// dado novo. Caso que trouxe isto: Raissa (26/11/2026). Localização mudada no
// IXC às 14:57, OS no moviTec às 15:00 com o ponto antigo, porque só a cópia
// completa (de 30 em 30 min) ou a manual do MoviOne levavam a localização.
//
// A localização fixada pelo técnico (coord_fixada) continua intocada, como na
// cópia completa; a que difere do IXC só é contada (fixadas_diferentes).
// Na OS em aberto troca-se só o que tinha vindo do cadastro: nome, telefone e
// o endereço e a referência da casa quando a OS não tinha os seus. O moviTec lê a localização
// direto da cópia, então ela não precisa ser copiada para a OS.
// O resultado guarda ids e contas: nada de nome, telefone, endereço ou ponto.
// ============================================================================
import { ALTERADOS_RP, desdeDoMarco, marcoDepois, gravarClientesAlterados, idValido } from './_ixc_espelho.js';
import { enderecoDoCliente, textoIxc } from './_ixc_os.js';

const FINAIS = ['finalizada', 'concluida', 'cancelada'];
const provisorio = ixcId => `Cliente IXC #${ixcId}`;
const telDe = c => (c && (c.tel1 || c.whatsapp)) || null;
const refDe = c => (c && textoIxc(c.referencia)) || null;

/* As OS que ainda não terminaram dos clientes cujo cadastro mudou.
   mudancas: [{ ixc_id, antes }] (a linha da cópia como estava). */
export async function refrescarOsDosClientes(io, mudancas) {
  const r = { os_atualizadas: 0 };
  const antesPorIxc = new Map((mudancas || []).filter(m => m && idValido(m.ixc_id)).map(m => [String(m.ixc_id), m.antes || null]));
  const ixcIds = [...antesPorIxc.keys()];
  if (!ixcIds.length) return r;
  // como os cadastros ficaram (o banco já traduziu a cidade)
  const novos = await io.sb(`clientes?ixc_id=in.(${ixcIds.join(',')})&select=id,ixc_id,nome,tel1,whatsapp,endereco,numero,complemento,bairro,cidade,uf,referencia`) || [];
  if (!novos.length) return r;
  const porLocal = new Map(novos.map(c => [String(c.id), c]));
  const porIxc = new Map(novos.map(c => [String(c.ixc_id), c]));
  // pelo id local; e pelo do IXC a OS que chegou antes do cliente estar na cópia
  const chaves = [...new Set([...porLocal.keys(), ...ixcIds])];
  const abertas = await io.sb(`campo_os?cliente_id=in.(${chaves.join(',')})&status=not.in.(${FINAIS.join(',')})&select=id,cliente_id,cliente,telefone,endereco,referencia`) || [];
  for (const os of abertas) {
    const chave = String(os.cliente_id ?? '');
    // o mesmo número pode ser o id do IXC de um cliente e o id local de outro:
    // pelo id do IXC, só a OS com o nome provisório que a importação põe
    const peloIxc = porIxc.has(chave) && os.cliente === provisorio(chave);
    const novo = peloIxc ? porIxc.get(chave) : porLocal.get(chave);
    if (!novo) continue;
    const antes = antesPorIxc.get(String(novo.ixc_id)) || null;
    const p = {};
    if (peloIxc && String(novo.id) !== chave) p.cliente_id = String(novo.id);
    // troca o que tinha vindo da cópia: o valor antigo dela, o provisório ou vazio
    if (novo.nome && os.cliente !== novo.nome && (peloIxc || !antes || os.cliente === antes.nome)) p.cliente = novo.nome;
    const telNovo = telDe(novo);
    if (telNovo && os.telefone !== telNovo && (peloIxc || !os.telefone || os.telefone === telDe(antes))) p.telefone = telNovo;
    // endereço: só o que era o do cadastro (a OS com endereço próprio fica com o dela)
    const endNovo = enderecoDoCliente(novo);
    if (endNovo && os.endereco !== endNovo && (!os.endereco || (antes && os.endereco === enderecoDoCliente(antes)))) p.endereco = endNovo;
    // referência da casa: a que veio do cadastro troca (o cadastro que ficou sem
    // referência limpa a que tinha vindo dele); a vazia só é preenchida quando o
    // endereço da OS é o do cadastro — OS com endereço próprio pode ser outra casa
    const refNova = refDe(novo);
    const doCadastro = antes && os.referencia && os.referencia === refDe(antes);
    const vaziaNoEnderecoDoCadastro = !os.referencia && (p.endereco || os.endereco) === endNovo;
    if ((os.referencia || null) !== refNova && (doCadastro || vaziaNoEnderecoDoCadastro)) p.referencia = refNova;
    if (!Object.keys(p).length) continue;
    await io.sb(`campo_os?id=eq.${Number(os.id)}&status=not.in.(${FINAIS.join(',')})`, { method: 'PATCH', prefer: 'return=minimal', body: p });
    r.os_atualizadas++;
  }
  return r;
}

/* io: { ixcListar(tabela, filtro, { paginas, rp }) -> { registros }, sb, sbRpc }.
   Devolve { resumo, marco }: o resumo vai para o resultado da rodada (que
   aparece na tela) e o marco é gravado pelo chamador — só se a rodada deu certo. */
export async function copiarClientesAlterados(io, { marco = null, agora = new Date() } = {}) {
  const desde = desdeDoMarco(marco, agora.getTime());
  const v = await io.ixcListar('cliente', { qtype: 'cliente.ultima_atualizacao', query: desde, oper: '>=',
    sortname: 'cliente.ultima_atualizacao', sortorder: 'desc' }, { paginas: 1, rp: ALTERADOS_RP });
  const regs = (v && v.registros) || [];
  const g = await gravarClientesAlterados(io, regs, { coordenadas: true });
  const os = g.mudancas.length ? await refrescarOsDosClientes(io, g.mudancas) : { os_atualizadas: 0 };
  return {
    resumo: {
      desde, lidos: regs.length, gravados: g.gravados, coordenadas: g.coordenadas, os_atualizadas: os.os_atualizadas,
      ...(g.fixadas_diferentes ? { fixadas_diferentes: g.fixadas_diferentes } : {}),
      ...(regs.length >= ALTERADOS_RP ? { cortado: true } : {}),
      ids: g.ids,
    },
    marco: marcoDepois(regs, { marco, desde, agoraMs: agora.getTime() }),
  };
}
