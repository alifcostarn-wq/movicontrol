// ════════════════════════════════════════════════════════════════
// MoviApp Service Worker — recebe e exibe notificações push
// Arquivo: /sw.js (na raiz do domínio)
// ════════════════════════════════════════════════════════════════

const CACHE_NAME = 'moviapp-v1';

// ── Instalação ──────────────────────────────────────────────────
self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// ── Receber Push ────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch(err) {
    data = { title: 'MoviON', body: e.data ? e.data.text() : '' };
  }

  const title   = data.title   || 'MoviON';
  const options = {
    body:    data.body    || '',
    icon:    data.icon    || '/icon-192.png',
    badge:   '/icon-72.png',
    vibrate: [200, 100, 200],
    data:    data.data    || {},
    actions: data.actions || [],
    requireInteraction: data.requireInteraction || false,
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// ── Click na notificação ────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();

  const url = e.notification.data?.url || '/moviapp.html';
  const tab = e.notification.data?.tab || '';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Se o app já está aberto, focar e navegar para a aba correta
      for (const client of windowClients) {
        if (client.url.includes('moviapp') && 'focus' in client) {
          client.focus();
          if (tab) client.postMessage({ type: 'navigate', tab });
          return;
        }
      }
      // Senão, abrir o app
      return clients.openWindow(url + (tab ? `#${tab}` : ''));
    })
  );
});

// ── Push subscription change ────────────────────────────────────
self.addEventListener('pushsubscriptionchange', e => {
  // Re-subscribe automaticamente se a subscription expirar
  e.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: e.oldSubscription?.options?.applicationServerKey,
    }).then(sub => {
      // Notificar o app para atualizar a subscription no servidor
      return clients.matchAll().then(cls => {
        cls.forEach(cl => cl.postMessage({ type: 'resubscribe', subscription: sub.toJSON() }));
      });
    })
  );
});
