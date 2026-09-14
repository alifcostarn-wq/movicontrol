/* ═══════════ VERSÃO NOVA NO SERVIDOR ═══════════════════════════════════════

   Aba aberta o dia inteiro roda o código do dia em que foi aberta. Quando uma
   correção sobe, quem já está com a aba aberta continua com o defeito — e ele
   reaparece num print, sem que ninguém tenha errado. Aconteceu no MoviTalk:
   a correção subiu às 9h58 e o print do problema é das 10h07, da aba que já
   estava aberta desde antes.

   Então a página confere sozinha, de vez em quando, se o arquivo que ela
   carregou ainda é o que o servidor entrega. A conferência é um HEAD
   comparando o ETag — não baixa a página de novo, e o Vercel manda um ETag de
   conteúdo em todo arquivo estático.

   Ela OFERECE o recarregar, nunca recarrega por conta própria: no meio de um
   cadastro ou de um projeto de rede, recarregar sozinha jogaria fora o
   trabalho de alguém.

   Uso:
     <script src="/versao.js" data-app="MoviOne" data-canto="centro" defer></script>

   data-app    nome que aparece no aviso
   data-canto  "centro" (padrão) ou "direita" — onde o aviso encosta, para não
               cair em cima do que a página já usa naquele canto

   A página pode definir window.versaoAntesDeAtualizar = fn para salvar o que
   estiver em memória antes da recarga (o MoviTalk faz isso com os rascunhos,
   na cópia própria dele, que é anterior a este arquivo).

   Se o servidor não mandar ETag nem Last-Modified, o vigia desiste em
   silêncio: sem assinatura não há o que comparar, e um aviso falso a cada
   dez minutos seria pior que aviso nenhum. */
(function () {
  var script = document.currentScript || document.querySelector('script[src*="versao.js"]');
  var APP   = (script && script.dataset && script.dataset.app)   || 'sistema';
  var CANTO = (script && script.dataset && script.dataset.canto) || 'centro';
  var INTERVALO = 10 * 60 * 1000;

  var assinatura = null;
  var avisado = false;

  function estilo() {
    if (document.getElementById('mv-versao-css')) return;
    var st = document.createElement('style');
    st.id = 'mv-versao-css';
    st.textContent =
      '.mv-versao{position:fixed;bottom:22px;z-index:100000;pointer-events:none;}' +
      '.mv-versao.centro{left:50%;transform:translateX(-50%);}' +
      '.mv-versao.direita{right:22px;}' +
      '.mv-versao .cx{display:flex;align-items:center;gap:12px;pointer-events:auto;' +
        'background:#0f172a;color:#fff;font-family:inherit;font-size:13px;font-weight:600;' +
        'padding:9px 10px 9px 18px;border-radius:11px;box-shadow:0 10px 30px rgba(0,0,0,.30);' +
        'max-width:min(92vw,460px);line-height:1.4;' +
        'transform:translateY(130px);transition:transform .25s ease;}' +
      '.mv-versao.show .cx{transform:none;}' +
      '.mv-versao button{background:#00A651;color:#fff;border:0;border-radius:8px;padding:8px 15px;' +
        'font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap;}' +
      '.mv-versao button:hover{filter:brightness(1.08);}' +
      '@media(prefers-reduced-motion:reduce){.mv-versao .cx{transition:none;}}';
    document.head.appendChild(st);
  }

  async function assinaturaDoServidor() {
    try {
      var r = await fetch(location.pathname, { method: 'HEAD', cache: 'no-store' });
      if (!r.ok) return null;
      return r.headers.get('etag') || r.headers.get('last-modified') || null;
    } catch (e) { return null; }
  }

  function mostrarAviso() {
    if (avisado) return;
    avisado = true;
    estilo();
    var el = document.createElement('div');
    el.className = 'mv-versao ' + (CANTO === 'direita' ? 'direita' : 'centro');
    el.innerHTML = '<div class="cx"><span>✨ Tem uma versão nova do ' + APP +
      '</span><button type="button">Atualizar</button></div>';
    el.querySelector('button').onclick = function () {
      try {
        if (typeof window.versaoAntesDeAtualizar === 'function') window.versaoAntesDeAtualizar();
      } catch (e) {}
      location.reload();
    };
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
  }

  async function conferir() {
    if (avisado || document.hidden) return;
    var agora = await assinaturaDoServidor();
    if (agora && agora !== assinatura) mostrarAviso();
  }

  (async function vigiar() {
    assinatura = await assinaturaDoServidor();
    if (!assinatura) return;
    setInterval(conferir, INTERVALO);
    // voltar para a aba é o momento mais provável de ter perdido uma subida
    document.addEventListener('visibilitychange', function () { if (!document.hidden) conferir(); });
  })();
})();
