import { useEffect, useMemo, useState } from 'react';
import { Download, Smartphone } from 'lucide-react';
import { Card, PageHeader } from '../../ui/feedback';
import { Button, buttonClass } from '../../ui/Button';
import { detectDeviceContext, type DeviceContext } from '../../recording/permissions';

/** The signed Android app (Trusted Web Activity), built by `npm run android:build`. */
export const ANDROID_APK_URL = '/download/tinigturo.apk';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
  });
}

const STEPS: Record<DeviceContext['platform'], { title: string; steps: string[] }> = {
  android: {
    title: 'Install from Chrome instead',
    steps: ['In Chrome, open the ⋮ menu.', 'Choose “Install app” or “Add to Home screen”.'],
  },
  ios: {
    title: 'iPhone and iPad (Safari)',
    steps: [
      'Open Tinig Turo in Safari (other browsers on iPhone cannot install it).',
      'Tap the Share button, then “Add to Home Screen”.',
      'Open Tinig Turo from the new icon once while online.',
    ],
  },
  desktop: {
    title: 'Computers and Chromebooks (Chrome or Edge)',
    steps: ['Click the install icon at the right end of the address bar, or open the browser menu and choose “Install Tinig Turo”.'],
  },
};

/**
 * Installation guidance for the device in use. The Android app (a Trusted Web Activity
 * around this same web app) is offered only on Android; other devices install the web
 * app from the browser. Guidance for other devices stays available below.
 */
export function InstallPage() {
  const device = useMemo(() => detectDeviceContext(), []);
  const [canPrompt, setCanPrompt] = useState(Boolean(deferredPrompt));
  useEffect(() => {
    const onPrompt = () => setCanPrompt(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  const others = (Object.keys(STEPS) as DeviceContext['platform'][]).filter((p) => p !== device.platform);

  return (
    <div className="space-y-5">
      <PageHeader title="Install and use offline" />
      {device.installed ? (
        <Card><p className="font-semibold">Tinig Turo is installed on this device.</p></Card>
      ) : (
        <>
          {device.platform === 'android' ? (
            <Card>
              <h2 className="mb-1 flex items-center gap-2 text-lg font-bold"><Smartphone size={20} aria-hidden="true" />Android app</h2>
              <p className="mb-3">For Android phones and tablets (Android 7.0 or newer). About 1 MB.</p>
              <a href={ANDROID_APK_URL} download="tinigturo.apk" className={buttonClass('primary', 'lg')}>
                <Download size={22} aria-hidden="true" />
                Download for Android
              </a>
              <ol className="mt-4 list-decimal space-y-1 pl-5">
                <li>Open the downloaded file <strong>tinigturo.apk</strong>.</li>
                <li>If your phone asks, allow your browser to <em>install unknown apps</em>, then tap <strong>Install</strong>.</li>
                <li>Open Tinig Turo once while connected to the internet so it can save itself for offline use.</li>
              </ol>
              <p className="mt-3 text-sm text-ink-soft">
                The app shows this same Tinig Turo inside Google Chrome, so keep Chrome installed and up to date. Updates to the
                reading app arrive automatically; a new download is only needed when the app’s icon or name changes.
              </p>
            </Card>
          ) : null}
          <Card>
            <h2 className="mb-2 text-lg font-bold">{STEPS[device.platform].title}</h2>
            {canPrompt ? (
              <Button onClick={async () => { await deferredPrompt?.prompt(); deferredPrompt = null; setCanPrompt(false); }}>Install Tinig Turo</Button>
            ) : (
              <ol className="list-decimal space-y-1 pl-5">
                {STEPS[device.platform].steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
            )}
          </Card>
        </>
      )}
      <Card>
        <h2 className="mb-2 text-lg font-bold">Before going offline</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Open the app once while online so it can save itself on the device.</li>
          <li>Sign in (if you use an account) and add readers.</li>
          <li>On <em>Offline downloads</em>, download the stories you need and, if offered, the speech language pack.</li>
          <li>Tap <em>Ask the browser to keep this data</em>.</li>
        </ol>
        <p className="mt-2 text-sm text-ink-soft">Browser data can still be removed if someone clears site data or the device runs out of space, so sync whenever you are online.</p>
      </Card>
      {!device.installed ? (
        <details className="rounded-2xl border-2 border-line bg-white p-4">
          <summary className="cursor-pointer font-semibold">Installing on another kind of device</summary>
          {others.map((p) => (
            <div key={p} className="mt-3">
              <h3 className="font-semibold">{p === 'android' ? 'Android phones and tablets' : STEPS[p].title}</h3>
              {p === 'android' ? (
                <p>Open this page on the Android device to download the Android app, or install it from Chrome’s ⋮ menu.</p>
              ) : (
                <ol className="list-decimal space-y-1 pl-5">{STEPS[p].steps.map((step) => <li key={step}>{step}</li>)}</ol>
              )}
            </div>
          ))}
        </details>
      ) : null}
    </div>
  );
}
