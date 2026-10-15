import { test as base, expect, type Page } from '@playwright/test';

/**
 * Headless Chromium crashes when SpeechRecognition.available({ processLocally: true })
 * is called (no on-device speech component). The app guards against that crash (see
 * e2e/speech-probe.spec.ts); other tests start with the check already recorded as
 * unsupported so they exercise the app instead of the browser defect.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem('tinigturo:ondevice-probe')) {
        localStorage.setItem('tinigturo:ondevice-probe', JSON.stringify({ inFlight: null, results: { 'en-US': { status: 'unsupported', at: Date.now() } } }));
      }
    });
    await use(page);
  },
});
export { expect };

/** Loads the app and waits until the service worker controls the page (app installed for offline use). */
export async function installApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (registration.active?.state !== 'activated') {
      await new Promise<void>((resolve) => registration.active?.addEventListener('statechange', () => resolve()));
    }
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

export async function addReader(page: Page, name: string, avatar = 'Owl'): Promise<void> {
  await page.goto('/learners');
  const add = page.getByRole('button', { name: 'Add a reader' }).first();
  await add.click();
  const dialog = page.getByRole('dialog', { name: 'Add a reader' });
  await dialog.getByLabel('First name or nickname').fill(name);
  await dialog.getByText(avatar, { exact: false }).first().click();
  await dialog.getByRole('button', { name: 'Add reader' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`Hi, ${name}!`) })).toBeVisible();
}

export async function switchReader(page: Page, name: string): Promise<void> {
  await page.goto('/learners');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`Hi, ${name}!`) })).toBeVisible();
}

export async function openStory(page: Page, title: string, mode: 'Read aloud' | 'Listen' = 'Read aloud'): Promise<void> {
  await page.goto('/stories');
  const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title }) });
  await card.getByRole('link', { name: mode }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

export async function hasNoHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
