import { registerSW } from 'virtual:pwa-register';
import { updateStore } from './updateStore';

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateStore.markNeedRefresh();
    },
    onOfflineReady() {
      updateStore.markOfflineReady();
    },
    onRegisterError(error: unknown) {
      updateStore.markError(error instanceof Error ? error.message : String(error));
    },
    onRegisteredSW(_url: string, registration: ServiceWorkerRegistration | undefined) {
      // Check for updates hourly while the app is open.
      if (registration) setInterval(() => void registration.update().catch(() => undefined), 60 * 60 * 1000);
    },
  });
  updateStore.attach(updateSW);
}
