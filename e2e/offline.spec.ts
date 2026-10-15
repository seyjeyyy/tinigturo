import { expect, test, addReader, installApp, openStory } from './helpers';

test('opens offline after installation, then reads, records and saves locally', async ({ page, context }) => {
  await installApp(page);
  await context.setOffline(true);
  await page.reload();

  // The app shell comes from the service worker; the offline state is explained.
  await expect(page.getByRole('heading', { name: 'Who is reading today?' })).toBeVisible();
  await expect(page.getByText(/You are offline\. Reading, recording and saved words still work/)).toBeVisible();

  await addReader(page, 'Ana');
  await openStory(page, 'Pip and the Puddle');

  // No speech recognizer is available offline here, and the app says so before starting.
  await expect(page.getByText(/Word checking is not available on this device/)).toBeVisible();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Recording', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start' })).toHaveCount(0); // no duplicate start
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Finish' }).click();

  await expect(page.getByText('Practice saved—word assessment unavailable.')).toBeVisible();
  await expect(page.getByText(/words per minute/i)).toHaveCount(0);
  await expect(page.locator('audio')).toBeVisible(); // the learner can play back their reading

  // Saved locally: visible in Progress, and still there after reloading while offline.
  await page.goto('/progress');
  await expect(page.getByRole('link', { name: 'Pip and the Puddle' })).toBeVisible();
  await expect(page.getByText('Words not checked')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Pip and the Puddle' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Badges for practicing' })).toBeVisible();
  await expect(page.getByText('First Steps')).toBeVisible();
  await expect(page.getByText(/waiting to be checked/).first()).toBeVisible();
});

test('the offline downloads screen reports content, speech availability and storage honestly', async ({ page }) => {
  await installApp(page);
  await addReader(page, 'Lito');
  await page.goto('/downloads');
  await expect(page.getByRole('heading', { name: 'Offline downloads' })).toBeVisible();
  await expect(page.getByText('Pip and the Puddle')).toBeVisible();
  await expect(page.getByText('Always available').first()).toBeVisible();
  await expect(page.getByText(/Starter word list/)).toBeVisible();
  await expect(page.getByText(/Word checking for Filipino stays off/)).toBeVisible();
  await expect(page.getByText(/can still be deleted if someone clears/)).toBeVisible();
  await expect(page.getByText(/used of about/)).toBeVisible();
});

test('Filipino stories are read and recorded without being scored by an English recognizer', async ({ page }) => {
  await installApp(page);
  await addReader(page, 'Nena');
  await page.goto('/stories?language=fil');
  await expect(page.getByRole('heading', { name: 'Ang Pusa ni Lito' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pip and the Puddle' })).toHaveCount(0);
  await openStory(page, 'Ang Pusa ni Lito');
  await expect(page.getByText(/Word checking for Filipino is not available yet/)).toBeVisible();
});

test('listen mode never pretends to follow the reader and explains a missing voice', async ({ page }) => {
  await installApp(page);
  await addReader(page, 'Mia');
  await openStory(page, 'Rain on the Roof', 'Listen');
  // Headless Chromium has no installed voices: the app must say so rather than fake highlighting.
  const unavailable = page.getByText(/no voice for this language on this device|cannot read stories aloud/);
  const available = page.getByText(/Your voice is not checked in Listen mode|whole sentences light up|Recorded narration/);
  await expect(unavailable.or(available)).toBeVisible();
});
