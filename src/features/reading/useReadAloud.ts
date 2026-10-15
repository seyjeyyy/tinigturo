import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ReadAloudController } from '../../reading/readAloudController';
import { AudioRecorder, selectAudioFormat } from '../../recording/recorder';
import { queryMicrophonePermission } from '../../recording/permissions';
import { createProvider, type RecognitionPlan } from '../../speech/plan';
import type { StoryVersionRecord } from '../../domain/types';
import type { Passage } from '../../text/tokenize';
import type { TinigDb } from '../../db/localDb';
import { hasUnsavedAttempt, isActive } from '../../recording/machine';

export function useReadAloud(input: {
  db: TinigDb;
  story: StoryVersionRecord;
  passage: Passage;
  learnerId: string;
  assignmentId: string | null;
  plan: RecognitionPlan | null;
  shareAudio: boolean;
  onActiveChange: (active: boolean) => void;
}) {
  const { db, story, passage, learnerId, assignmentId, plan, shareAudio, onActiveChange } = input;
  // Read through a ref so toggling sharing does not recreate the controller mid-reading.
  const shareAudioRef = useRef(shareAudio);
  shareAudioRef.current = shareAudio;
  const controller = useMemo(() => {
    if (!plan) return null;
    return new ReadAloudController({
      db,
      story,
      passage,
      learnerId,
      assignmentId,
      plan,
      audioFormat: selectAudioFormat(),
      createRecorder: (mime) => new AudioRecorder(mime),
      createProvider: (p) => createProvider(p, story.language),
      shareAudio: () => shareAudioRef.current,
      checkMicrophone: queryMicrophonePermission,
    });
  }, [db, story, passage, learnerId, assignmentId, plan]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getSnapshot ?? nullSnapshot,
  );

  useEffect(() => () => controller?.dispose(), [controller]);

  // Pause automatically when the app goes to the background.
  useEffect(() => {
    if (!controller) return;
    const onVisibility = () => controller.setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [controller]);

  const active = snapshot ? isActive(snapshot.recording) : false;
  const unsaved = snapshot ? hasUnsavedAttempt(snapshot.recording) : false;
  useEffect(() => {
    onActiveChange(active);
    return () => onActiveChange(false);
  }, [active, onActiveChange]);

  // Warn before closing the tab with an unsaved attempt.
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);

  return { controller, snapshot, active, unsaved };
}

const noopSubscribe = () => () => undefined;
const nullSnapshot = () => null;
