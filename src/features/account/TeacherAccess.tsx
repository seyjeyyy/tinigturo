import { GraduationCap, LogIn, UserPlus } from 'lucide-react';
import { Card } from '../../ui/feedback';
import { Button, ButtonLink } from '../../ui/Button';

export const TEACHER_SIGN_IN = '/account/sign-in?next=/teacher';
export const TEACHER_SIGN_UP = '/account/sign-up?as=teacher';

/**
 * The way into the teacher workspace. Teacher access comes only from the teacher role
 * on the server: an account cannot make itself a teacher in the app, so a parent or
 * guardian account is told how to get access instead.
 */
export function TeacherAccessCard({ state, onSwitchAccount }: { state: 'signed_out' | 'not_teacher'; onSwitchAccount?: () => void }) {
  if (state === 'signed_out') {
    return (
      <Card>
        <h2 className="mb-1 flex items-center gap-2 text-lg font-bold"><GraduationCap size={22} aria-hidden="true" />Teachers</h2>
        <p className="mb-3">Manage classes, assign stories, review readings, and publish grades in the teacher workspace.</p>
        <div className="flex flex-wrap gap-2">
          <ButtonLink to={TEACHER_SIGN_IN} icon={<LogIn size={20} />}>Teacher sign in</ButtonLink>
          <ButtonLink variant="secondary" to={TEACHER_SIGN_UP} icon={<UserPlus size={20} />}>Create a teacher account</ButtonLink>
        </div>
        <p className="mt-3 text-sm text-ink-soft">Teacher accounts are separate from parent accounts. Some schools approve teacher accounts before they can be used.</p>
      </Card>
    );
  }
  return (
    <Card>
      <h2 className="mb-1 flex items-center gap-2 text-lg font-bold"><GraduationCap size={22} aria-hidden="true" />Teacher workspace</h2>
      <p>This is a parent or guardian account, so it cannot open the teacher workspace. An account cannot be turned into a teacher account from inside the app.</p>
      <p className="mt-2">To teach with Tinig Turo, either:</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        <li>sign in with a teacher account, or create one with a different email and choose <strong>I am a… Teacher</strong>; or</li>
        <li>ask your school’s Tinig Turo administrator to add the teacher role to this account.</li>
      </ul>
      {onSwitchAccount ? (
        <Button className="mt-3" variant="secondary" icon={<LogIn size={20} />} onClick={onSwitchAccount}>Sign out and use a teacher account</Button>
      ) : null}
    </Card>
  );
}
