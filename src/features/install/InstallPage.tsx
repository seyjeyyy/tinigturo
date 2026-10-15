import { useEffect, useState } from 'react';
import { Download, Smartphone } from 'lucide-react';
import { Card, PageHeader } from '../../ui/feedback';
import { Button, buttonClass } from '../../ui/Button';

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

export function InstallPage() {
  const [canPrompt, setCanPrompt] = useState(Boolean(deferredPrompt));
  const installed = typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches;
  useEffect(() => {
    const onPrompt = () => setCanPrompt(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  return (
    <div className="space-y-5">
      <PageHeader title="Install and use offline" />
      {!installed ? (
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
          <p className="mt-3 text-sm text-ink-soft">The app runs on Google Chrome, so keep Chrome installed and up to date. Reading, recording and word checking work the same as in the browser.</p>
        </Card>
      ) : null}
      <Card>
        {installed ? <p className="font-semibold">Tinig Turo is installed on this device.</p> : canPrompt ? (
          <Button onClick={async () => { await deferredPrompt?.prompt(); deferredPrompt = null; setCanPrompt(false); }}>Install Tinig Turo</Button>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>Android (without the APK):</strong> in Chrome, open the ⋮ menu and choose <em>Install app</em> or <em>Add to Home screen</em>.</li>
            <li><strong>iPhone/iPad (Safari):</strong> tap Share, then <em>Add to Home Screen</em>.</li>
            <li><strong>Windows/Chromebook (Chrome or Edge):</strong> click the install icon in the address bar.</li>
          </ul>
        )}
      </Card>
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
    </div>
  );
}
