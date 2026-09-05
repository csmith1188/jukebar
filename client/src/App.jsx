import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Header } from './components/Header.jsx';
import { BootScreen } from './components/BootScreen.jsx';
import { useSession } from './useSession.js';
import { prefetchRoute } from './bootPrefetch.js';
import { LeaderboardPage } from './pages/LeaderboardPage.jsx';
import { SettingsPage } from './pages/SettingsPage.jsx';
import { TeacherPage } from './pages/TeacherPage.jsx';
import { PlayerPage } from './pages/PlayerPage.jsx';

// The classic EJS views each set their own <body class="..."> (teacher.ejs
// -> "teacher-page", settings.ejs -> "settings-page", player.ejs ->
// "player-page", leaderboard.ejs -> none), and a good chunk of styles.css is
// scoped through that class — most importantly `.teacher-page .main-content`,
// which is what gives the Teacher page its fixed-height, internally-scrolling
// layout. Because client/index.html hardcodes body to "player-page" for
// every route, the Teacher page never got that rule and its content just got
// clipped with no way to scroll it. Setting the class per-route here is the
// fix for that (and it also stops the Leaderboard page from incorrectly
// inheriting `.player-page`'s `overflow:hidden` background treatment).
const BODY_CLASS_BY_PATH = {
  '/app/player': 'player-page',
  '/app/teacher': 'teacher-page',
  '/app/settings': 'settings-page',
  '/app/leaderboard': '',
};

function useBodyClass(pathname) {
  useEffect(() => {
    const cls = BODY_CLASS_BY_PATH[pathname] ?? 'player-page';
    document.body.className = cls;
    return () => { document.body.className = ''; };
  }, [pathname]);
}

function AppRoutes({ session }) {
  const location = useLocation();
  useBodyClass(location.pathname);

  return (
    <div key={location.pathname} className="app-page-fade">
      <Routes location={location}>
        <Route path="/app" element={<Navigate to="/app/player" replace />} />
        <Route path="/app/player" element={<PlayerPage session={session} />} />
        <Route path="/app/teacher" element={<TeacherPage session={session} />} />
        <Route path="/app/settings" element={<SettingsPage session={session} />} />
        <Route path="/app/leaderboard" element={<LeaderboardPage />} />
        <Route path="*" element={<Navigate to="/app/player" replace />} />
      </Routes>
    </div>
  );
}

export function App() {
  const { session, loading, error, reload } = useSession();
  const [booting, setBooting] = useState(true);
  const [dataReady, setDataReady] = useState(false);
  const spotifyReady = !!session?.spotifyQueueReady;
  const location = useLocation();

  useEffect(() => {
    prefetchRoute(location.pathname).finally(() => setDataReady(true));
  }, []);

  useEffect(() => {
    if (!booting || spotifyReady) return;
    const id = setInterval(reload, 2000);
    return () => clearInterval(id);
  }, [booting, spotifyReady, reload]);

  const ready = spotifyReady && dataReady;
  if (booting) {
    return <BootScreen ready={ready} onDone={() => setBooting(false)} />;
  }

  if (loading) {
    return <div className="page-loading">Loading Jukebar…</div>;
  }
  if (error) {
    return <div className="page-error">Couldn't load your session: {error.message || String(error)}</div>;
  }

  return (
    <>
      <Header session={session} />
      <AppRoutes session={session} />
    </>
  );
}
