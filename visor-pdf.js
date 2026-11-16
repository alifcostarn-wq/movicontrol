/* Visor de PDF na própria tela (MoviOne e MoviTalk).
   O PDF era aberto num link/iframe: no celular o navegador não mostra PDF
   embutido e manda baixar. Aqui as páginas são desenhadas na tela (pdf.js),
   então o contrato se lê sem baixar nada, em qualquer aparelho.

   abrirVisorPdf({ nome, obter, baixar })
     obter  → função que devolve { base64 } (ou a string base64) do PDF
     baixar → opcional: função chamada pelo botão "⬇ Baixar" */
(function () {
  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  var carregando = null;
  function carregarPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (carregando) return carregando;
    carregando = new Promise(function (ok, erro) {
      var s = document.createElement('script');
      s.src = PDFJS + 'pdf.min.js';
      s.onload = function () {
        if (!window.pdfjsLib) return erro(new Error('leitor de PDF não carregou'));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
        ok(window.pdfjsLib);
      };
      s.onerror = function () { carregando = null; erro(new Error('não consegui carregar o leitor de PDF (sem internet?)')); };
      document.head.appendChild(s);
    });
    return carregando;
  }
  function css() {
    if (document.getElementById('mv-visor-css')) return;
    var st = document.createElement('style');
    st.id = 'mv-visor-css';
    st.textContent =
      '.mv-visor{position:fixed;inset:0;z-index:100000;background:rgba(10,18,26,.96);display:flex;flex-direction:column;font-family:inherit}' +
      '.mv-visor-topo{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0f1c28;color:#fff;flex-shrink:0}' +
      '.mv-visor-t{flex:1;min-width:0;font-size:13.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.mv-visor-pg{font-size:11.5px;opacity:.75;white-space:nowrap}' +
      '.mv-visor-bt{font-family:inherit;font-size:13px;font-weight:700;background:rgba(255,255,255,.12);color:#fff;border:0;border-radius:8px;padding:7px 11px;cursor:pointer;white-space:nowrap}' +
      '.mv-visor-bt:hover{background:rgba(255,255,255,.22)}' +
      '.mv-visor-corpo{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:12px 8px 30px;text-align:center}' +
      '.mv-visor-corpo canvas{display:block;margin:0 auto 12px;background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.45);max-width:none}' +
      '.mv-visor-msg{color:#fff;font-size:13.5px;padding:50px 20px;line-height:1.5}' +
      '.mv-visor-msg b{display:block;font-size:12px;font-weight:400;opacity:.8;margin-top:6px;word-break:break-word}';
    document.head.appendChild(st);
  }
  function bytesDe(base64) {
    var bin = atob(String(base64 || '').replace(/\s+/g, ''));
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  window.abrirVisorPdf = function (opc) {
    opc = opc || {};
    css();
    document.querySelectorAll('.mv-visor').forEach(function (x) { x.remove(); });
    var v = document.createElement('div');
    v.className = 'mv-visor';
    v.innerHTML =
      '<div class="mv-visor-topo">' +
        '<span class="mv-visor-t"></span><span class="mv-visor-pg"></span>' +
        '<button type="button" class="mv-visor-bt" data-z="-1" title="Diminuir">−</button>' +
        '<button type="button" class="mv-visor-bt" data-z="1" title="Aumentar">+</button>' +
        (opc.baixar ? '<button type="button" class="mv-visor-bt" data-baixar title="Baixar o PDF">⬇</button>' : '') +
        '<button type="button" class="mv-visor-bt" data-fechar title="Fechar (Esc)">✕</button>' +
      '</div><div class="mv-visor-corpo"><div class="mv-visor-msg">Abrindo o documento…</div></div>';
    v.querySelector('.mv-visor-t').textContent = '📄 ' + (opc.nome || 'Documento');
    var corpo = v.querySelector('.mv-visor-corpo'), pg = v.querySelector('.mv-visor-pg');
    var vivo = true, pdf = null, zoom = 1, vez = 0;
    function fechar() { vivo = false; document.removeEventListener('keydown', tecla, true); v.remove(); if (pdf && pdf.destroy) pdf.destroy(); }
    function tecla(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); fechar(); } }
    document.addEventListener('keydown', tecla, true);
    v.querySelector('[data-fechar]').onclick = fechar;
    var bx = v.querySelector('[data-baixar]');
    if (bx) bx.onclick = function () { try { opc.baixar(); } catch (e) { /* quem baixa avisa */ } };
    function erro(msg) {
      if (!vivo) return;
      corpo.innerHTML = '<div class="mv-visor-msg">Não consegui mostrar o documento.<b></b></div>';
      corpo.querySelector('b').textContent = msg || '';
    }
    async function desenhar() {
      var minha = ++vez;
      var larguraUtil = Math.max(240, corpo.clientWidth - 16);
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var frag = document.createDocumentFragment();
      for (var n = 1; n <= pdf.numPages; n++) {
        var pagina = await pdf.getPage(n);
        if (!vivo || minha !== vez) return;
        var base = pagina.getViewport({ scale: 1 });
        // cabe na largura da tela (até 900px), vezes o zoom escolhido
        var escala = Math.min(larguraUtil, 900) / base.width * zoom;
        var vp = pagina.getViewport({ scale: escala * dpr });
        var c = document.createElement('canvas');
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        c.style.width = Math.floor(vp.width / dpr) + 'px'; c.style.height = Math.floor(vp.height / dpr) + 'px';
        await pagina.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        if (!vivo || minha !== vez) return;
        frag.appendChild(c);
      }
      corpo.innerHTML = ''; corpo.appendChild(frag);
      pg.textContent = pdf.numPages + (pdf.numPages === 1 ? ' página' : ' páginas');
    }
    v.querySelectorAll('[data-z]').forEach(function (b) {
      b.onclick = function () {
        if (!pdf) return;
        zoom = Math.min(3, Math.max(0.5, zoom + Number(b.dataset.z) * 0.25));
        desenhar().catch(function (e) { erro(e.message); });
      };
    });
    document.body.appendChild(v);
    (async function () {
      try {
        var r = await Promise.all([carregarPdfJs(), opc.obter()]);
        if (!vivo) return;
        var b64 = r[1] && typeof r[1] === 'object' ? r[1].base64 : r[1];
        if (!b64) throw new Error('o servidor não devolveu o arquivo');
        pdf = await r[0].getDocument({ data: bytesDe(b64) }).promise;
        if (!vivo) return;
        await desenhar();
      } catch (e) { erro(e && e.message); }
    })();
    return v;
  };
})();
