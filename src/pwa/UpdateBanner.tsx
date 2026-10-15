import { useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import { updateStore } from './updateStore';
import { useApp } from '../app/AppContext';
import { Button } from '../ui/Button';

/**
 * Offers a downloaded update. During a recording it is either hidden (reading screen,
 * to avoid distraction) or shows that the update will wait; it is never applied then.
 */
export function UpdateBanner({ hideWhileRecording = false }: { hideWhileRecording?: boolean }) {
  const state = useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot);
  const { activity } = useApp();
  if (!state.needRefresh) return null;
  if (hideWhileRecording && activity.recordingActive) return null;
  return (
    <div role="status" className="border-b-2 border-sun bg-sun-tint px-4 py-2">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-medium">
          <RefreshCw size={18} aria-hidden="true" />
          {activity.recordingActive
            ? 'A new version of Tinig Turo is ready. It will be offered when you finish this reading.'
            : 'A new version of Tinig Turo is ready.'}
        </p>
        {!activity.recordingActive ? (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void updateStore.apply({ recordingActive: activity.recordingActive })}>Update now</Button>
            <Button size="sm" variant="ghost" onClick={() => updateStore.dismiss()}>Later</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
