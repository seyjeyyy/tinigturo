/*
 * Optional Background Sync support, imported into the generated service worker.
 * When the browser fires the sync event (connectivity returned), open app windows are
 * asked to run their normal foreground sync. Without an open window nothing is sent:
 * the service worker never holds learner data or credentials itself.
 */
self.addEventListener('sync', (event) => {
  if (event.tag !== 'tinigturo-sync') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) client.postMessage({ type: 'tinigturo-sync' });
    }),
  );
});
