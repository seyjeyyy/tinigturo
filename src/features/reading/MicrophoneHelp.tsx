import { useEffect, useMemo, useState } from 'react';
import {
  detectDeviceContext, microphoneRecoverySteps, queryMicrophonePermission, systemMicrophoneSteps, watchMicrophonePermission,
  type MicrophonePermission,
} from '../../recording/permissions';

/**
 * Steps for allowing a blocked microphone on this kind of device. It never asks the
 * browser for the microphone itself; the reader's "Check again" button does that only
 * once the permission is no longer blocked.
 */
export function MicrophoneBlockedSteps() {
  const context = useMemo(() => detectDeviceContext(), []);
  const [initial, setInitial] = useState<MicrophonePermission | null>(null);
  const [changed, setChanged] = useState<MicrophonePermission | null>(null);
  useEffect(() => {
    let cancelled = false;
    void queryMicrophonePermission().then((state) => !cancelled && setInitial(state));
    const stop = watchMicrophonePermission(setChanged);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);
  // The browser says the microphone is allowed, yet it was refused: the device blocks it.
  const steps = initial === 'granted' && changed === null ? systemMicrophoneSteps(context) : microphoneRecoverySteps(context);
  return (
    <div className="mt-2">
      <p className="font-semibold">For a grown-up: how to allow the microphone</p>
      {initial === 'granted' && changed === null ? (
        <p className="mt-1">This browser already allows the microphone, so the device’s own settings are probably blocking it.</p>
      ) : null}
      <ol className="mt-1 list-decimal space-y-1 pl-5">
        {steps.map((step) => <li key={step}>{step}</li>)}
      </ol>
      {changed === 'granted' || changed === 'prompt' ? (
        <p className="mt-2 font-semibold" role="status">The microphone is no longer blocked. Press “Check again”.</p>
      ) : null}
    </div>
  );
}
