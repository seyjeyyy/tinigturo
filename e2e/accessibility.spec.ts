import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, addReader, installApp, openStory } from './helpers';

/**
 * Automated accessibility checks (axe-core, WCAG 2.1 A and AA rules) on the main
 * student screens. Automated rules catch only part of the problems; the screen-reader
 * pass in docs/TESTING.md is still needed.
 */
async function expectNoSeriousViolations(page: Page, screen: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${screen}: ${v.id} — ${v.help} (${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')})`);
  expect(serious).toEqual([]);
}

test('student screens have no serious or critical automated accessibility violations', async ({ page }) => {
  await installApp(page);
  await expectNoSeriousViolations(page, 'choose a reader');
  await addReader(page, 'Ana');
  await expectNoSeriousViolations(page, 'home');
  for (const [path, name] of [['/stories', 'stories'], ['/words', 'my words'], ['/progress', 'progress'], ['/downloads', 'offline downloads'], ['/settings', 'settings'], ['/account', 'grown-ups'], ['/install', 'install']]) {
    await page.goto(path);
    await page.locator('main h1').first().waitFor();
    await expectNoSeriousViolations(page, name);
  }
  await openStory(page, 'The Red Kite');
  await expectNoSeriousViolations(page, 'reading');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Recording', { exact: true })).toBeVisible();
  await expectNoSeriousViolations(page, 'reading while recording');
  await page.getByRole('button', { name: 'Word Coach' }).click();
  await page.locator('[data-w]', { hasText: /^kite\.$/ }).first().click();
  await expect(page.getByRole('dialog', { name: /Word helper/ })).toBeVisible();
  await expectNoSeriousViolations(page, 'word coach');
  await page.getByRole('dialog', { name: /Word helper/ }).getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByText('Practice saved—word assessment unavailable.')).toBeVisible();
  await expectNoSeriousViolations(page, 'result');
});
