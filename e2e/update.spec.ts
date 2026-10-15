import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, addReader, installApp, openStory } from './helpers';

/**
 * Publishes a "new version" by changing the deployed service worker while the app is
 * open, then asks the browser to check for updates. The new worker downloads and
 * waits; the app must not activate it during a recording.
 */
test('a service-worker update waits until the active recording is finished', async ({ page }) => {
  const swPath = 'dist/sw.js';
  const original = readFileSync(swPath, 'utf8');
  try {
    await installApp(page);
    await addReader(page, 'Ana');
    await openStory(page, 'Pip and the Puddle');
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByText('Recording', { exact: true })).toBeVisible();

    appendFileSync(swPath, `\n// test update ${Date.now()}\n`);
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
    await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting)), { timeout: 20_000 }).toBe(true);

    // The update is downloaded but not applied: no prompt, no reload, still recording.
    await page.waitForTimeout(1000);
    await expect(page.getByRole('button', { name: 'Update now' })).toHaveCount(0);
    await expect(page.getByText('Recording', { exact: true })).toBeVisible();
    expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true);

    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByText('Practice saved—word assessment unavailable.')).toBeVisible();
    // Only now is the update offered; the attempt was saved first.
    await expect(page.getByRole('button', { name: 'Update now' })).toBeVisible();
  } finally {
    writeFileSync(swPath, original);
  }
});
