import { Link } from 'react-router';
import { useApp } from '../../app/AppContext';
import { updatePreferences } from '../../data/learners';
import { DEFAULT_READING_PREFERENCES, type LineSpacing, type TextSize } from '../../domain/types';
import { Card, PageHeader } from '../../ui/feedback';
import { SelectField, Toggle } from '../../ui/fields';
import { ButtonLink } from '../../ui/Button';
import { TEXT_SIZES } from '../reading/Passage';

export function SettingsPage() {
  const { db, learner, settings, updateSettings, partition, deviceSettings } = useApp();
  const prefs = learner?.preferences ?? DEFAULT_READING_PREFERENCES;
  const setPrefs = (patch: Partial<typeof prefs>) => learner && void updatePreferences(db, learner.id, { ...prefs, ...patch });

  return (
    <div className="space-y-5">
      <PageHeader title="Settings" />

      {learner ? (
        <Card>
          <h2 className="mb-3 text-lg font-bold">Reading ({learner.displayName})</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField label="Text size" value={prefs.textSize} onChange={(e) => setPrefs({ textSize: e.target.value as TextSize })}>
              <option value="md">Medium</option>
              <option value="lg">Large</option>
              <option value="xl">Extra large</option>
              <option value="2xl">Huge</option>
            </SelectField>
            <SelectField label="Space between lines" value={prefs.lineSpacing} onChange={(e) => setPrefs({ lineSpacing: e.target.value as LineSpacing })}>
              <option value="normal">Normal</option>
              <option value="relaxed">Comfortable</option>
              <option value="loose">Extra space</option>
            </SelectField>
          </div>
          <p className="passage mt-4 rounded-xl bg-paper p-3" style={{ '--reading-size': TEXT_SIZES[prefs.textSize] } as React.CSSProperties}>The cat sat on the mat.</p>
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-1 text-lg font-bold">For grown-ups</h2>
        <p className="mb-4 text-sm text-ink-soft">These choices apply to {partition === 'device' ? 'readers saved on this device' : 'this account on this device'}.</p>
        <div className="space-y-5">
          <Toggle
            label="Allow online word checking"
            checked={settings.allowCloudRecognition}
            onChange={(v) => void updateSettings({ allowCloudRecognition: v })}
            description={
              <>
                Only used when this device has no on-device speech engine. While a child reads, their voice is sent to the browser maker’s speech service
                (for example Google for Chrome, Apple for Safari) to be turned into text. Off by default. On-device word checking never sends audio anywhere.
              </>
            }
          />
          <Toggle
            label="Share recordings with the teacher"
            checked={settings.shareRecordings}
            disabled={partition === 'device'}
            onChange={(v) => void updateSettings({ shareRecordings: v })}
            description={
              partition === 'device'
                ? 'Readers saved only on this device cannot share recordings. Sign in first.'
                : <>Recordings are uploaded only if this is on <em>and</em> the server allows it: a guardian gave consent for the learner, or the teacher turned on recording uploads for the class. Uploaded recordings are private to the learner’s guardians and teachers and are deleted after the class’s retention period (30 days unless the teacher sets another). Off by default.</>
            }
          />
        </div>
      </Card>

      <Card>
        <h2 className="mb-2 text-lg font-bold">This device</h2>
        <p className="mb-3">
          {deviceSettings.deviceMode === 'shared_classroom'
            ? `Shared classroom device${deviceSettings.sharedClassName ? ` for ${deviceSettings.sharedClassName}` : ''}. Set up by a teacher.`
            : 'Personal device.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <ButtonLink variant="secondary" to="/downloads">Offline downloads</ButtonLink>
          <ButtonLink variant="secondary" to="/sync">Sync status</ButtonLink>
          <ButtonLink variant="secondary" to="/learners">Switch reader</ButtonLink>
          <ButtonLink variant="secondary" to="/account">Account</ButtonLink>
        </div>
        <p className="mt-3 text-sm text-ink-soft">Need help installing? See <Link to="/install" className="underline">how to install and use offline</Link>.</p>
      </Card>
    </div>
  );
}
