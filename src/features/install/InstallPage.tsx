import { useEffect, useState } from 'react';
import { Card, PageHeader } from '../../ui/feedback';
import { Button } from '../../ui/Button';

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
      <Card>
        {installed ? <p className="font-semibold">Tinig Turo is installed on this device.</p> : canPrompt ? (
          <Button onClick={async () => { await deferredPrompt?.prompt(); deferredPrompt = null; setCanPrompt(false); }}>Install Tinig Turo</Button>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>Android (Chrome):</strong> open the ⋮ menu and choose <em>Install app</em> or <em>Add to Home screen</em>.</li>
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
