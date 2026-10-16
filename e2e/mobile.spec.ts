import { expect, test, addReader, hasNoHorizontalScroll, installApp, openStory } from './helpers';

test('mobile layout: simple bottom navigation, no sideways scrolling', async ({ page }) => {
  await installApp(page);
  await addReader(page, 'Ana');
  const nav = page.getByRole('navigation', { name: 'Main' }).last();
  await expect(nav).toBeVisible();
  for (const label of ['Home', 'Stories', 'My Words', 'Progress']) {
    const link = nav.getByRole('link', { name: label });
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44); // large touch targets
  }
  for (const path of ['/', '/stories', '/words', '/progress', '/downloads', '/settings']) {
    await page.goto(path);
    expect(await hasNoHorizontalScroll(page), path).toBe(true);
  }
});

test('mobile reading screen gives the passage the space and keeps controls compact', async ({ page }) => {
  await installApp(page);
  await addReader(page, 'Ben');
  await openStory(page, "Lola's Garden");
  const viewport = page.viewportSize()!;
  const passage = await page.locator('#passage').boundingBox();
  const footer = await page.locator('footer').boundingBox();
  expect(passage!.height).toBeGreaterThan(viewport.height * 0.5);
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(viewport.height + 1);
  await expect(page.getByRole('button', { name: 'Start' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Help' })).toBeInViewport();

  // Largest text size (two steps up from the default) still fits without clipping sideways.
  const bigger = page.getByRole('button', { name: 'Bigger text' });
  await bigger.click();
  await bigger.click();
  await expect(bigger).toBeDisabled();
  expect(await hasNoHorizontalScroll(page)).toBe(true);

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Finish' })).toBeInViewport();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByText('Practice saved—word assessment unavailable.')).toBeVisible();
  expect(await hasNoHorizontalScroll(page)).toBe(true);
});

test.describe('small phone (360 × 640)', () => {
  test.use({ viewport: { width: 360, height: 640 } });

  test('the title stays readable and the passage gets most of the screen while recording', async ({ page }) => {
    await installApp(page);
    await addReader(page, 'Ana');
    await openStory(page, 'The Red Kite');
    const title = page.getByRole('heading', { level: 1, name: 'The Red Kite' });
    expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByText('Recording', { exact: true })).toBeVisible();
    const passage = await page.locator('#passage').boundingBox();
    expect(passage!.height).toBeGreaterThan(640 * 0.7);
    for (const name of ['Pause', 'Finish', 'Word Coach', 'Help']) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeInViewport();
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await hasNoHorizontalScroll(page)).toBe(true);
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByText('Practice saved—word assessment unavailable.')).toBeVisible();
  });
});
