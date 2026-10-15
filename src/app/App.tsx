import { useEffect } from 'react';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router';
import { AppProvider, useApp } from './AppContext';
import { RequireLearner, StudentLayout } from './StudentLayout';
import { HomePage } from '../features/home/HomePage';
import { LearnerPicker } from '../features/learners/LearnerPicker';
import { StoryLibrary } from '../features/stories/StoryLibrary';
import { ReadingPage } from '../features/reading/ReadingPage';
import { MyWords, WordPractice } from '../features/words/MyWords';
import { AttemptDetail, ProgressPage } from '../features/progress/ProgressPage';
import { DownloadsPage } from '../features/downloads/DownloadsPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { SyncPage } from '../features/sync/SyncPage';
import { AccountPage, JoinClassPage, ResetPasswordPage, SignInPage, SignUpPage, UpdatePasswordPage } from '../features/account/AccountPages';
import { InstallPage } from '../features/install/InstallPage';
import { refreshFromServer } from '../data/serverRefresh';
import { EmptyState } from '../ui/feedback';
import { ButtonLink } from '../ui/Button';

/** Pulls learners, assignments and assigned stories when online and signed in. */
function ServerRefresh() {
  const { db, partition, online, ready, deviceSettings, auth } = useApp();
  useEffect(() => {
    if (!ready || !online || partition === 'device' || auth.status !== 'signed_in') return;
    void refreshFromServer(db, { mode: deviceSettings.deviceMode, classId: deviceSettings.sharedClassId }).catch(() => undefined);
  }, [db, partition, online, ready, deviceSettings.deviceMode, deviceSettings.sharedClassId, auth.status]);
  return null;
}

function Root() {
  return (
    <>
      <ServerRefresh />
      <Outlet />
    </>
  );
}

function NotFound() {
  return <EmptyState icon="🧭" title="Page not found" action={<ButtonLink to="/">Go home</ButtonLink>} />;
}

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      {
        element: <StudentLayout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'learners', element: <LearnerPicker /> },
          { path: 'downloads', element: <DownloadsPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'sync', element: <SyncPage /> },
          { path: 'install', element: <InstallPage /> },
          { path: 'benchmark', lazy: async () => ({ Component: (await import('../features/dev/SpeechBenchmark')).SpeechBenchmarkPage }) },
          { path: 'account', element: <AccountPage /> },
          { path: 'account/sign-in', element: <SignInPage /> },
          { path: 'account/sign-up', element: <SignUpPage /> },
          { path: 'account/reset', element: <ResetPasswordPage /> },
          { path: 'account/update-password', element: <UpdatePasswordPage /> },
          { path: 'join', element: <JoinClassPage /> },
          {
            element: <RequireLearner />,
            children: [
              { path: 'stories', element: <StoryLibrary /> },
              { path: 'words', element: <MyWords /> },
              { path: 'words/practice', element: <WordPractice /> },
              { path: 'progress', element: <ProgressPage /> },
              { path: 'progress/:sessionId', element: <AttemptDetail /> },
            ],
          },
          { path: '*', element: <NotFound /> },
        ],
      },
      {
        element: <RequireLearner />,
        children: [{ path: 'read/:versionId', element: <ReadingPage /> }],
      },
      {
        // The teacher workspace is loaded on demand so student devices load less code.
        path: 'teacher',
        lazy: async () => ({ Component: (await import('../features/teacher/TeacherLayout')).TeacherLayout }),
        children: [
          { index: true, lazy: async () => ({ Component: (await import('../features/teacher/ClassesPage')).ClassesPage }) },
          { path: 'classes/:classId', lazy: async () => ({ Component: (await import('../features/teacher/ClassDetail')).ClassDetail }) },
          { path: 'stories', lazy: async () => ({ Component: (await import('../features/teacher/StoriesPages')).TeacherStoriesPage }) },
          { path: 'stories/new', lazy: async () => ({ Component: (await import('../features/teacher/StoriesPages')).StoryEditorPage }) },
          { path: 'stories/:storyId', lazy: async () => ({ Component: (await import('../features/teacher/StoriesPages')).StoryEditorPage }) },
          { path: 'review', lazy: async () => ({ Component: (await import('../features/teacher/ReviewPages')).ReviewQueuePage }) },
          { path: 'review/:sessionId', lazy: async () => ({ Component: (await import('../features/teacher/ReviewPages')).ReviewSessionPage }) },
          { path: 'device', lazy: async () => ({ Component: (await import('../features/teacher/DevicePage')).DevicePage }) },
        ],
      },
    ],
  },
]);

export function App() {
  return (
    <AppProvider>
      <RouterProvider router={router} />
    </AppProvider>
  );
}
