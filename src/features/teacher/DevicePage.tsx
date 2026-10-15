import { useState } from 'react';
import { useApp } from '../../app/AppContext';
import { listClasses } from '../../backend/teacherApi';
import { refreshFromServer } from '../../data/serverRefresh';
import { setPinRecord } from '../../db/metaDb';
import { createPinRecord, validatePin } from '../../lib/pin';
import { useAsync } from '../../lib/useAsync';
import { Alert, Card, Loading, PageHeader } from '../../ui/feedback';
import { Button } from '../../ui/Button';
import { SelectField, TextField } from '../../ui/fields';

export function DevicePage() {
  const { db, auth, deviceSettings, updateDeviceSettings, teacherLock, partition, useDevicePartition, setUseDevicePartition } = useApp();
  const classes = useAsync(listClasses, []);
  const [classId, setClassId] = useState(deviceSettings.sharedClassId ?? '');
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  const setUpShared = async () => {
    const klass = classes.data?.find((c) => c.id === classId);
    if (!klass) return setMessage({ tone: 'error', text: 'Choose a class.' });
    if (!teacherLock.hasPin) return setMessage({ tone: 'error', text: 'Set a PIN first, so learners cannot open the teacher workspace on this device.' });
    setBusy(true);
    try {
      if (useDevicePartition) await setUseDevicePartition(false);
      await updateDeviceSettings({ deviceMode: 'shared_classroom', sharedClassId: klass.id, sharedClassName: klass.name });
      await refreshFromServer(db, { mode: 'shared_classroom', classId: klass.id });
      setMessage({ tone: 'success', text: `This device is ready for ${klass.name}. Learners choose their picture to read. Their readings sync under your account.` });
    } catch (e) {
      setMessage({ tone: 'error', text: `Setup failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const setPersonal = async () => {
    await updateDeviceSettings({ deviceMode: 'personal', sharedClassId: null, sharedClassName: null });
    setMessage({ tone: 'info', text: 'This device is now a personal device. Class learners already on it are kept until you sign out and remove data.' });
  };

  const savePin = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = validatePin(pin);
    if (problem) return setPinError(problem);
    if (pin !== pin2) return setPinError('The two PINs are different.');
    await setPinRecord(auth.userId!, await createPinRecord(pin));
    await teacherLock.refresh();
    setPin('');
    setPin2('');
    setPinError(null);
    setMessage({ tone: 'success', text: 'PIN saved for this device.' });
  };

  return (
    <div className="space-y-5">
      <PageHeader title="This device" description={`Currently: ${deviceSettings.deviceMode === 'shared_classroom' ? `shared classroom device for ${deviceSettings.sharedClassName}` : 'personal device'}.`} />
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <Card>
        <h2 className="mb-2 text-lg font-bold">Quick-access PIN</h2>
        <p className="mb-3 text-sm text-ink-soft">
          The PIN reopens the teacher workspace on this device after you switch to student mode. It does not sign you in anywhere else and gives no access on the server:
          every change still needs your signed-in account and is checked by the server.
        </p>
        <form onSubmit={savePin} className="grid max-w-lg gap-3 sm:grid-cols-2">
          <TextField label={teacherLock.hasPin ? 'New PIN' : 'PIN'} type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} maxLength={8} autoComplete="new-password" />
          <TextField label="Repeat PIN" type="password" inputMode="numeric" value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} maxLength={8} autoComplete="new-password" error={pinError} />
          <div className="sm:col-span-2 flex gap-2">
            <Button type="submit">{teacherLock.hasPin ? 'Change PIN' : 'Set PIN'}</Button>
            {teacherLock.hasPin ? <Button variant="ghost" onClick={() => void setPinRecord(auth.userId!, null).then(teacherLock.refresh)}>Remove PIN</Button> : null}
          </div>
        </form>
      </Card>
      <Card>
        <h2 className="mb-2 text-lg font-bold">Shared classroom device</h2>
        <p className="mb-3 text-sm text-ink-soft">
          Use this on a device that stays in your classroom. The class list is downloaded to this device so learners can pick their name, even offline.
          Only learners in the class you choose appear. Do not use this on a family device.
        </p>
        {classes.loading ? <Loading /> : classes.error ? <Alert tone="error">{classes.error.message}</Alert> : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-60">
              <SelectField label="Class" value={classId} onChange={(e) => setClassId(e.target.value)}>
                <option value="">Choose a class</option>
                {classes.data!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </SelectField>
            </div>
            <Button onClick={() => void setUpShared()} busy={busy}>{deviceSettings.deviceMode === 'shared_classroom' ? 'Update class list' : 'Set up for this class'}</Button>
            {deviceSettings.deviceMode === 'shared_classroom' ? <Button variant="secondary" onClick={() => void setPersonal()}>Use as a personal device</Button> : null}
          </div>
        )}
        {partition === 'device' ? <p className="mt-2 text-sm text-ink-soft">Note: you are viewing device-only readers. Setting up a class switches to your account’s data.</p> : null}
      </Card>
    </div>
  );
}
