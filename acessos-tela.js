/* ═══════════ REGISTRO DE ACESSOS — a tela de cada sistema ══════════════════

   Cada sistema mostra só as entradas dele:
     MoviOne   → Sistema › Acessos
     moviTec   → Campo › Acessos (no MoviOne, onde os técnicos são geridos)
     MoviTalk  → Configurações › Acessos
     MoviFiber → Gerenciamento › Acessos
   Os dados vêm de /api/acessos, que confere quem pode ver cada sistema e grava
   o IP e o local pelo servidor (o navegador não informa nada disso).

   Uso:
     AcessosTela.montar(elemento, {
       sistema: 'movitalk',                 // movione | movitec | movitalk | movifiber
       token:   async () => '...',          // token do Supabase de quem está logado
       escuro:  () => true/false,           // o sistema está no tema escuro?
       cartao:  true,                       // moldura própria (quando a página não tem)
     });
   A tela pode ser remontada à vontade (os filtros e a última lista ficam
   guardados por sistema) e acompanha a troca de tema enquanto está aberta.
*/
(function () {
  if (window.AcessosTela) return;
  const TZ = 'America/Fortaleza';   // horário de Mossoró
  const SIS = {
    movione:   { nome: 'MoviOne',   logo: '/movione-icon.svg' },
    movitec:   { nome: 'moviTec',   logo: '/movitec-icon.svg' },
    movitalk:  { nome: 'MoviTalk',  logo: '/movitalk-icon.svg' },
    movifiber: { nome: 'MoviFiber', logo: '/movifiber-icon.svg' },
  };
  const EVENTOS = {
    login:       ['Entrou com senha', 'login'],
    sessao:      ['Abriu já conectado', 'sessao'],
    saida:       ['Saiu', 'saida'],
    inatividade: ['Saiu por inatividade', 'inativ'],
  };
  const estados = {};   // por sistema: filtros, última lista, pedido em andamento

  const CSS = `
.acs-tela{--acs-mudo:#5b6475;--acs-borda:rgba(15,23,42,.14);--acs-linha:rgba(15,23,42,.08);--acs-fundo2:rgba(15,23,42,.04);--acs-cartao:#fff;
  --acs-verde:#166534;--acs-verde-bg:#dcfce7;--acs-azul:#1d4ed8;--acs-azul-bg:#dbeafe;--acs-verm:#b91c1c;--acs-verm-bg:#fee2e2;
  --acs-cinza:#334155;--acs-cinza-bg:#f1f5f9;--acs-amar:#6e4b05;--acs-amar-bg:#fff1c2;--acs-amar-borda:#f0d58c;--acs-link:#1d4ed8;
  color-scheme:light;font-size:13px;line-height:1.45;color:inherit;text-align:left}
.acs-tela.escuro{--acs-mudo:#9aa4b5;--acs-borda:rgba(255,255,255,.14);--acs-linha:rgba(255,255,255,.08);--acs-fundo2:rgba(255,255,255,.05);--acs-cartao:rgba(255,255,255,.03);
  --acs-verde:#86efac;--acs-verde-bg:rgba(34,197,94,.16);--acs-azul:#93c5fd;--acs-azul-bg:rgba(59,130,246,.18);--acs-verm:#fca5a5;--acs-verm-bg:rgba(239,68,68,.16);
  --acs-cinza:#cbd5e1;--acs-cinza-bg:rgba(148,163,184,.14);--acs-amar:#ffd27a;--acs-amar-bg:rgba(255,200,60,.14);--acs-amar-borda:rgba(255,200,60,.35);--acs-link:#93c5fd;
  color-scheme:dark}
.acs-tela.cartao{background:var(--acs-cartao);border:1px solid var(--acs-borda);border-radius:14px;overflow:hidden}
.acs-tela *{box-sizing:border-box}
.acs-topo{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 18px;border-bottom:1px solid var(--acs-borda)}
.acs-tit{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:700}
.acs-tit img{width:26px;height:26px;border-radius:7px;display:block;flex-shrink:0}
.acs-topo p{margin:5px 0 0;font-size:12px;color:var(--acs-mudo);max-width:640px}
.acs-btn{font:inherit;font-size:12.5px;font-weight:600;padding:7px 13px;border-radius:9px;border:1px solid var(--acs-borda);background:transparent;color:inherit;cursor:pointer;white-space:nowrap}
.acs-btn:hover{background:var(--acs-fundo2)}
.acs-btn:focus-visible,.acs-sel:focus-visible,.acs-mapa:focus-visible{outline:2px solid var(--acs-link);outline-offset:2px}
.acs-filtros{display:flex;gap:8px;flex-wrap:wrap;padding:12px 18px 0}
/* a página pode dar 100% de largura a todo select (o MoviFiber dá): aqui não */
.acs-tela .acs-sel{font:inherit;font-size:12.5px;padding:6px 9px;border-radius:8px;border:1px solid var(--acs-borda);background:transparent;color:inherit;width:auto;max-width:100%;height:auto;margin:0}
.acs-sel option{color:initial}
.acs-resumo{display:flex;gap:8px;flex-wrap:wrap;padding:12px 18px}
.acs-num{display:inline-flex;align-items:baseline;gap:6px;background:var(--acs-fundo2);border:1px solid var(--acs-borda);border-radius:10px;padding:6px 11px;font-size:12px}
.acs-num b{font-size:15px}
.acs-num span{color:var(--acs-mudo)}
.acs-num.alerta{background:var(--acs-amar-bg);border-color:var(--acs-amar-borda)}
.acs-num.alerta b,.acs-num.alerta span{color:var(--acs-amar)}
.acs-rola{overflow-x:auto}
.acs-tab{width:100%;border-collapse:collapse;font-size:13px}
.acs-tab th{text-align:left;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--acs-mudo);padding:9px 12px;border-bottom:1px solid var(--acs-borda);background:var(--acs-fundo2);white-space:nowrap}
.acs-tab td{padding:10px 12px;border-bottom:1px solid var(--acs-linha);vertical-align:middle}
.acs-tab tr:last-child td{border-bottom:none}
.acs-tab th:first-child,.acs-tab td:first-child{padding-left:18px}
.acs-quando{white-space:nowrap;font-variant-numeric:tabular-nums}
.acs-pessoa{font-weight:600}
.acs-email{font-size:11.5px;color:var(--acs-mudo)}
.acs-ev{display:inline-block;font-size:11px;font-weight:600;padding:3px 8px;border-radius:20px;white-space:nowrap}
.acs-ev.login{background:var(--acs-verde-bg);color:var(--acs-verde)}
.acs-ev.sessao{background:var(--acs-azul-bg);color:var(--acs-azul)}
.acs-ev.saida{background:var(--acs-cinza-bg);color:var(--acs-cinza)}
.acs-ev.inativ{background:var(--acs-verm-bg);color:var(--acs-verm)}
.acs-novo{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:20px;background:var(--acs-amar-bg);color:var(--acs-amar);border:1px solid var(--acs-amar-borda);margin-left:4px;white-space:nowrap}
.acs-tab tr.novo td{background:color-mix(in srgb,#FFD84D 9%,transparent)}
.acs-ip{font-family:'DM Mono','JetBrains Mono',ui-monospace,monospace;font-size:12px;white-space:nowrap}
.acs-mapa{font-size:11.5px;font-weight:600;color:var(--acs-link);text-decoration:none;margin-left:4px;white-space:nowrap}
.acs-mapa:hover{text-decoration:underline}
.acs-mudo{color:var(--acs-mudo)}
.acs-vazio{padding:22px 18px!important;text-align:center;color:var(--acs-mudo)}
.acs-erro{padding:18px!important;color:var(--acs-verm)}
.acs-aviso{padding:10px 18px 14px;font-size:12px;color:var(--acs-mudo)}
.acs-aviso:empty{display:none}
@media (max-width:600px){.acs-topo,.acs-filtros,.acs-resumo{padding-left:12px;padding-right:12px}.acs-tab th:first-child,.acs-tab td:first-child{padding-left:12px}}
`;
  function injetarCss() {
    if (document.getElementById('acs-tela-css')) return;
    const st = document.createElement('style'); st.id = 'acs-tela-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const diaDe = d => d.toLocaleDateString('en-CA', { timeZone: TZ });   // AAAA-MM-DD em Mossoró
  function quando(iso) {
    const d = new Date(iso), hoje = new Date();
    const hora = d.toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
    if (diaDe(d) === diaDe(hoje)) return 'hoje · ' + hora;
    if (diaDe(d) === diaDe(new Date(hoje.getTime() - 864e5))) return 'ontem · ' + hora;
    const sem = d.toLocaleDateString('pt-BR', { timeZone: TZ, weekday: 'short' }).replace('.', '');
    const dm = d.toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', ...(d.getFullYear() !== hoje.getFullYear() ? { year: 'numeric' } : {}) });
    return `${sem} ${dm} · ${hora}`;
  }
  const quandoCompleto = iso => new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'full', timeStyle: 'medium' });
  function pais(cod) { if (!cod) return ''; try { return new Intl.DisplayNames(['pt-BR'], { type: 'region' }).of(cod) || cod; } catch (e) { return cod; } }
  function local(a) {
    const lugar = [a.cidade, a.uf].filter(Boolean).join(' · ');
    if (!lugar && !a.pais) return '<span class="acs-mudo">—</span>';
    const p = a.pais && a.pais !== 'BR' ? (lugar ? ' · ' : '') + pais(a.pais) : '';
    const mapa = a.latitude != null && a.longitude != null
      ? ` <a class="acs-mapa" href="https://www.google.com/maps?q=${encodeURIComponent(a.latitude + ',' + a.longitude)}" target="_blank" rel="noopener" title="Posição aproximada, pelo IP">mapa</a>` : '';
    return esc(lugar) + esc(p) + mapa;
  }
  function aparelho(a) {
    const ico = a.aparelho === 'computador' ? '💻' : (a.aparelho ? '📱' : '');
    const txt = [a.navegador, a.so].filter(Boolean).join(' · ') || '—';
    return `<span title="${esc(a.user_agent || '')}">${ico ? ico + ' ' : ''}${esc(txt)}</span>`;
  }
  // local novo: a primeira entrada da pessoa num lugar, quando ela já tinha
  // entrado de outro lugar antes (dentro do período que está na tela)
  function marcarNovos(lista) {
    const vistos = {};
    [...lista].reverse().forEach(a => {
      if (a.evento !== 'login' && a.evento !== 'sessao') return;
      if (!a.cidade && !a.uf && !a.pais) return;
      const quem = a.usuario_id || a.usuario_email, onde = [a.cidade, a.uf, a.pais].join('|');
      if (!vistos[quem]) { vistos[quem] = new Set([onde]); return; }
      if (!vistos[quem].has(onde)) { a._novo = true; vistos[quem].add(onde); }
    });
  }
  const opc = (v, txt, atual) => `<option value="${esc(v)}"${String(v) === String(atual) ? ' selected' : ''}>${esc(txt)}</option>`;

  function esqueleto(op, st) {
    const s = SIS[op.sistema] || { nome: op.sistema, logo: '' };
    return `<div class="acs-tela${op.cartao ? ' cartao' : ''}" data-sistema="${esc(op.sistema)}">
      <div class="acs-topo">
        <div>
          <div class="acs-tit">${s.logo ? `<img src="${s.logo}" alt="" width="26" height="26">` : ''}<span>Entradas no ${esc(s.nome)}</span></div>
          <p>Quem entrou, quando e de onde. O local é aproximado, pelo IP da internet: no celular com dados móveis pode aparecer a cidade da operadora.</p>
        </div>
        <button type="button" class="acs-btn" data-acs="atualizar">↻ Atualizar</button>
      </div>
      <div class="acs-filtros">
        <select class="acs-sel" data-acs="dias" aria-label="Período">
          ${opc(1, 'Últimas 24 horas', st.dias)}${opc(7, 'Últimos 7 dias', st.dias)}${opc(30, 'Últimos 30 dias', st.dias)}${opc(90, 'Últimos 90 dias', st.dias)}
        </select>
        <select class="acs-sel" data-acs="pessoa" aria-label="Pessoa">${opc('', 'Todas as pessoas', st.pessoa)}</select>
        <select class="acs-sel" data-acs="evento" aria-label="O que aconteceu">
          ${opc('', 'Entradas e saídas', st.evento)}${Object.entries(EVENTOS).map(([k, v]) => opc(k, v[0], st.evento)).join('')}
        </select>
      </div>
      <div class="acs-resumo" data-acs="resumo"></div>
      <div class="acs-rola">
        <table class="acs-tab">
          <thead><tr><th>Quando</th><th>Pessoa</th><th>O que aconteceu</th><th>Local</th><th>IP</th><th>Aparelho</th></tr></thead>
          <tbody data-acs="corpo"><tr><td colspan="6" class="acs-vazio">Carregando…</td></tr></tbody>
        </table>
      </div>
      <div class="acs-aviso" data-acs="aviso"></div>
    </div>`;
  }
  const parte = (raiz, nome) => raiz.querySelector(`[data-acs="${nome}"]`);

  function pintar(st) {
    const raiz = st.raiz, j = st.dados;
    if (!raiz || !raiz.isConnected || !j) return;
    const sel = parte(raiz, 'pessoa');
    sel.innerHTML = opc('', 'Todas as pessoas', st.pessoa)
      + (j.pessoas || []).map(p => opc(p.id, p.nome || p.email || p.id, st.pessoa)).join('');
    const lista = (j.acessos || []).map(a => ({ ...a }));
    marcarNovos(lista);
    const entradas = lista.filter(a => a.evento === 'login' || a.evento === 'sessao');
    const pessoas = new Set(lista.map(a => a.usuario_id || a.usuario_email)).size;
    const locais = new Set(entradas.filter(a => a.cidade || a.uf || a.pais).map(a => [a.cidade, a.uf, a.pais].join('|'))).size;
    const novos = lista.filter(a => a._novo).length, inativ = lista.filter(a => a.evento === 'inatividade').length;
    const n = (q, um, varios, mais = '') => `<b>${q}</b> <span>${q === 1 ? um : varios}${mais}</span>`;
    parte(raiz, 'resumo').innerHTML =
      `<span class="acs-num">${n(entradas.length, 'entrada', 'entradas')}</span>`
      + `<span class="acs-num">${n(pessoas, 'pessoa', 'pessoas')}</span>`
      + `<span class="acs-num">${n(locais, 'local', 'locais')}</span>`
      + (inativ ? `<span class="acs-num">${n(inativ, 'saída', 'saídas', ' por inatividade')}</span>` : '')
      + (novos ? `<span class="acs-num alerta" title="Primeira entrada da pessoa num lugar diferente, no período">${n(novos, 'local novo', 'locais novos')}</span>` : '');
    parte(raiz, 'corpo').innerHTML = lista.length ? lista.map(a => {
      const ev = EVENTOS[a.evento] || [a.evento, ''];
      return `<tr${a._novo ? ' class="novo"' : ''}>
        <td class="acs-quando" title="${esc(quandoCompleto(a.criado_em))}">${esc(quando(a.criado_em))}</td>
        <td><div class="acs-pessoa">${esc(a.usuario_nome || a.usuario_email || '—')}</div><div class="acs-email">${esc(a.usuario_email || '')}</div></td>
        <td><span class="acs-ev ${ev[1]}">${esc(ev[0])}</span></td>
        <td>${local(a)}${a._novo ? '<span class="acs-novo" title="Primeira entrada desta pessoa neste lugar, no período">local novo</span>' : ''}</td>
        <td class="acs-ip">${esc(a.ip || '—')}</td>
        <td>${aparelho(a)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="acs-vazio">Nenhum acesso registrado com estes filtros.</td></tr>';
    parte(raiz, 'aviso').textContent = lista.length >= j.limite
      ? `Mostrando os ${j.limite} mais recentes. Use os filtros para ver um período ou uma pessoa.` : '';
  }

  async function carregar(st) {
    const raiz = st.raiz, op = st.op, pedido = ++st.pedido;
    if (raiz && raiz.isConnected) {
      parte(raiz, 'corpo').innerHTML = '<tr><td colspan="6" class="acs-vazio">Carregando…</td></tr>';
      parte(raiz, 'resumo').innerHTML = '';
      parte(raiz, 'aviso').textContent = '';
    }
    let j;
    try {
      const token = await op.token();
      const r = await fetch('/api/acessos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') },
        body: JSON.stringify({ acao: 'listar', sistema: op.sistema, dias: st.dias, usuario_id: st.pessoa || undefined, evento: st.evento || undefined }),
      });
      j = await r.json().catch(() => ({ ok: false, erro: 'resposta inválida do servidor (' + r.status + ')' }));
      if (!r.ok || !j.ok) throw new Error(j.erro || ('erro ' + r.status));
    } catch (e) {
      if (pedido !== st.pedido) return;
      st.dados = null; st.quando = 0;
      const rz = st.raiz;
      if (rz && rz.isConnected) parte(rz, 'corpo').innerHTML = `<tr><td colspan="6" class="acs-erro">Não foi possível carregar os acessos: ${esc(e.message)}</td></tr>`;
      return;
    }
    if (pedido !== st.pedido) return;   // chegou a resposta de um filtro antigo
    st.dados = j; st.quando = Date.now();
    pintar(st);
  }

  function montar(el, op) {
    if (!el || !op || !SIS[op.sistema]) return;
    injetarCss();
    const st = estados[op.sistema] || (estados[op.sistema] = { dias: 7, pessoa: '', evento: '', dados: null, quando: 0, pedido: 0 });
    st.op = op;
    el.innerHTML = esqueleto(op, st);
    const raiz = st.raiz = el.querySelector('.acs-tela');
    // acompanha o tema do sistema enquanto a tela está aberta
    const tema = () => raiz.classList.toggle('escuro', !!(op.escuro && op.escuro()));
    tema();
    if (st.obs) st.obs.disconnect();
    st.obs = new MutationObserver(() => { if (!raiz.isConnected) { st.obs.disconnect(); return; } tema(); });
    st.obs.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    st.obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    parte(raiz, 'atualizar').onclick = () => carregar(st);
    parte(raiz, 'dias').onchange = e => { st.dias = +e.target.value || 7; carregar(st); };
    parte(raiz, 'pessoa').onchange = e => { st.pessoa = e.target.value; carregar(st); };
    parte(raiz, 'evento').onchange = e => { st.evento = e.target.value; carregar(st); };
    // remontou logo depois (a página redesenhou): reaproveita a lista em vez de pedir de novo
    if (st.dados && Date.now() - st.quando < 60000) pintar(st); else carregar(st);
  }

  window.AcessosTela = { montar };
})();
