import { expect, test, addReader, installApp, openStory, switchReader } from './helpers';

test('learners on a shared device keep their own words and progress', async ({ page }) => {
  await installApp(page);
  await addReader(page, 'Ana');
  await addReader(page, 'Ben', 'Fox');

  await switchReader(page, 'Ana');
  await openStory(page, 'Pip and the Puddle');
  await page.locator('[data-w]', { hasText: /^puddle\.$/ }).first().click();
  const coach = page.getByRole('dialog', { name: /Word helper/ });
  await expect(coach.getByText('A small pool of water on the ground, often after rain.')).toBeVisible();
  await expect(coach.getByText(/Syllables are only shown after a teacher checks them/)).toBeVisible();
  await expect(coach.getByText(/Draft definition/)).toBeVisible();
  await coach.getByRole('button', { name: 'Save to My Words' }).click();
  await expect(coach.getByText('Saved to My Words.')).toBeVisible();
  await coach.getByRole('button', { name: 'Close' }).click();

  await switchReader(page, 'Ben');
  await page.goto('/words');
  await expect(page.getByText('No saved words yet')).toBeVisible();

  await switchReader(page, 'Ana');
  await page.goto('/words');
  await expect(page.getByRole('heading', { name: 'puddle' })).toBeVisible();

  // Practice activity
  await page.getByRole('link', { name: 'Practice my words' }).click();
  await page.getByRole('button', { name: 'Show the meaning' }).click();
  await page.getByRole('button', { name: 'I practiced it' }).click();
  await expect(page.getByText('You practiced 1 word!')).toBeVisible();
  await page.goto('/words');
  await expect(page.getByText('Practiced 1 time')).toBeVisible();
});

test('keyboard users can navigate, open the word helper, and close it', async ({ page }) => {
  await installApp(page);
  await addReader(page, 'Kai');
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();

  await openStory(page, 'Pip and the Puddle');
  const passage = page.getByRole('group', { name: 'Story: Pip and the Puddle' });
  await passage.focus();
  await expect(passage).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Word helper: “a”' });
  await expect(dialog).toBeVisible();
  // Focus is trapped in the dialog and Escape closes it, returning focus.
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(passage).toBeFocused();

  // Visible focus indicator on interactive controls.
  await page.getByRole('button', { name: 'Start' }).focus();
  const outline = await page.getByRole('button', { name: 'Start' }).evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
});

test('leaving during a recording asks before discarding', async ({ page }) => {
  await installApp(page);
  await addReader(page, 'Eli');
  await openStory(page, 'Pip and the Puddle');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Recording', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to stories' }).click();
  const dialog = page.getByRole('dialog', { name: 'Leave this reading?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep reading' }).click();
  await expect(page.getByText('Recording', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to stories' }).click();
  await page.getByRole('dialog', { name: 'Leave this reading?' }).getByRole('button', { name: 'Save and leave' }).click();
  await expect(page.getByRole('heading', { name: 'Stories' })).toBeVisible();
  await page.goto('/progress');
  await expect(page.getByRole('link', { name: 'Pip and the Puddle' })).toBeVisible();
});

test('an attempt interrupted by a reload can be recovered', async ({ page }) => {
  await installApp(page);
  await addReader(page, 'Rosa');
  await openStory(page, 'Pip and the Puddle');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Recording', { exact: true })).toBeVisible();
  await page.waitForTimeout(3500); // at least one audio chunk and checkpoint are stored
  page.once('dialog', (d) => void d.accept()); // the browser's "leave site?" prompt
  await page.goto('/');
  await expect(page.getByText('You have an unfinished reading')).toBeVisible();
  await page.getByRole('button', { name: 'Save what was read' }).click();
  await expect(page.getByText('You have an unfinished reading')).toHaveCount(0);
  await page.goto('/progress');
  await expect(page.getByText('Recovered')).toBeVisible();
});

test('a reader-only page explains why a reader is needed, then returns there after choosing', async ({ page }) => {
  await installApp(page);
  await page.goto('/progress');
  await expect(page.getByText('Who is reading?')).toBeVisible();
  await expect(page).toHaveURL(/\/progress$/); // no silent redirect
  await page.getByRole('link', { name: 'Choose a reader' }).click();
  await page.getByRole('button', { name: 'Add a reader' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a reader' });
  await dialog.getByLabel('First name or nickname').fill('Mia');
  await dialog.getByRole('button', { name: 'Add reader' }).click();
  await expect(page.getByRole('heading', { name: 'My progress' })).toBeVisible();
  await expect(page).toHaveURL(/\/progress$/);
});
