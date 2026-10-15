import { test as base, expect } from '@playwright/test';
import { addReader, installApp, openStory } from './helpers';

/**
 * Real browser defect found while testing: in headless Chromium, the on-device speech
 * availability check crashes the page. The app must recover on the next load and keep
 * reading and recording usable, without checking again automatically.
 */
base('recovers after the on-device speech check crashes the browser page', async ({ context }) => {
  const first = await context.newPage();
  await installApp(first);
  await addReader(first, 'Ana');
  const crashed = new Promise<boolean>((resolve) => {
    first.on('crash', () => resolve(true));
    setTimeout(() => resolve(false), 20_000);
  });
  // An English story: on-device checking is only probed for languages that could use it.
  await openStory(first, 'Pip and the Puddle').catch(() => undefined);
  const didCrash = await crashed;

  const second = await context.newPage();
  await openStory(second, 'Pip and the Puddle');
  await expect(second.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(second.getByText(/Word checking is not available on this device/)).toBeVisible();
  await second.goto('/downloads');
  if (didCrash) await expect(second.getByText(/stopped this browser earlier/)).toBeVisible();
  await expect(second.getByRole('heading', { name: 'Offline downloads' })).toBeVisible();
});
