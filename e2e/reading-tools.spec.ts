import { expect, test, addReader, hasNoHorizontalScroll, installApp, openStory } from './helpers';

test('during a recording a tap does not cover the story; Word Coach pauses, then the reading continues', async ({ page }) => {
  await installApp(page);
  await addReader(page, 'Lia');
  await openStory(page, 'The Red Kite');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Recording', { exact: true })).toBeVisible();

  // A finger following the text must not open a dialog over the story.
  const kite = page.locator('[data-w]', { hasText: /^kite\.$/ }).first();
  await kite.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/touch and hold the word/)).toBeVisible();

  // The explicit action: Word Coach pauses the reading and asks for a word.
  await page.getByRole('button', { name: 'Word Coach' }).click();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await expect(page.getByText('Tap the word you want help with.')).toBeVisible();
  await kite.click();
  const coach = page.getByRole('dialog', { name: /Word helper/ });
  await expect(coach).toBeVisible();
  await coach.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('Recording', { exact: true })).toBeVisible(); // continued

  // The optional shortcut: touch (here: press) and hold a word.
  await page.locator('[data-w]', { hasText: /^string\.$/ }).first().hover();
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  await expect(page.getByRole('dialog', { name: /Word helper/ })).toBeVisible();
  await page.getByRole('dialog', { name: /Word helper/ }).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('Recording', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByText('Practice saved—word assessment unavailable.')).toBeVisible();
});

test('stories start with the Grade 2–4 English path; other stories stay available as labelled extra practice', async ({ page }) => {
  await installApp(page);
  await addReader(page, 'Noa');
  await page.goto('/stories');
  await expect(page.getByRole('heading', { name: 'The Red Kite' })).toBeVisible();
  await expect(page.getByRole('heading', { name: "Lola's Garden" })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pip and the Puddle' })).toHaveCount(0);
  await expect(page.getByText('Grade 2 reading level')).toBeVisible();

  await page.getByRole('button', { name: 'All stories' }).click();
  const pip = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Pip and the Puddle' }) });
  await expect(pip.getByText('Extra practice · Grade 1 level')).toBeVisible();
  const filipino = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Ang Pusa ni Lito' }) });
  await expect(filipino.getByText('Extra practice · Filipino story')).toBeVisible();
  expect(await hasNoHorizontalScroll(page)).toBe(true);
});
