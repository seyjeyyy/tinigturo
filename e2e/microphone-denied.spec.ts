import { expect, test, addReader, installApp, openStory } from './helpers';

/**
 * Headless Chromium reports any blocked microphone as NotSupportedError, so the
 * denial is simulated here: getUserMedia rejects with NotAllowedError (what real
 * browsers raise when the user blocks access) until the test "allows" the microphone.
 * The retry then uses Chromium's fake microphone.
 */
test('a denied microphone shows one clear error, and a retry after allowing it works', async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) =>
      (window as unknown as { __micAllowed?: boolean }).__micAllowed
        ? original(constraints)
        : Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await installApp(page);
  await addReader(page, 'Ana');
  await openStory(page, 'Pip and the Puddle');

  await page.getByRole('button', { name: 'Start' }).click();
  const error = page.getByRole('alert');
  await expect(error).toContainText('Tinig Turo is not allowed to use the microphone.');
  await expect(error).toContainText('site settings');
  await expect(page.getByRole('alert')).toHaveCount(1); // no conflicting messages
  await expect(page.getByText('Recording', { exact: true })).toHaveCount(0);

  await page.evaluate(() => {
    (window as unknown as { __micAllowed?: boolean }).__micAllowed = true;
  });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Recording', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0); // the old error is cleared
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByText('Practice saved—word assessment unavailable.')).toBeVisible();
});
