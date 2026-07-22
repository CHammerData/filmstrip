import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { applyTheme, getInitialTheme, Theme } from './theme';
import Login from './pages/Login';
import Lists from './pages/Lists';
import Movies from './pages/Movies';
import MovieHistory from './pages/MovieHistory';
import Users from './pages/Users';
import Deletions from './pages/Deletions';
import SyncHistory from './pages/SyncHistory';
import Settings from './pages/Settings';

export default function App() {
  const { me, loading, logout } = useAuth();

  if (loading) return <div className="center muted">Loading…</div>;
  if (!me) return <Login />;

  const isAdmin = me.isAdmin;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Filmstrip</span>
        <nav>
          <NavLink to="/lists">Lists</NavLink>
          <NavLink to="/movies">Movies</NavLink>
          <NavLink to="/history">History</NavLink>
          {isAdmin && <NavLink to="/deletions">Deletions</NavLink>}
          {isAdmin && <NavLink to="/users">Users</NavLink>}
          {isAdmin && <NavLink to="/settings">Settings</NavLink>}
        </nav>
        <span className="spacer" />
        <span className="who">
          {me.user.name}
          {isAdmin && <span className="badge">admin</span>}
        </span>
        <ThemeToggle />
        <button className="link" onClick={() => logout()}>
          Log out
        </button>
      </header>

      <main className="content">
        <Routes>
          <Route path="/lists" element={<Lists />} />
          <Route path="/movies" element={<Movies />} />
          <Route path="/movies/:id" element={<MovieHistory />} />
          <Route path="/history" element={<SyncHistory />} />
          {isAdmin && <Route path="/deletions" element={<Deletions />} />}
          {isAdmin && <Route path="/users" element={<Users />} />}
          {isAdmin && <Route path="/settings" element={<Settings />} />}
          <Route path="*" element={<Navigate to="/lists" replace />} />
        </Routes>
      </main>
    </div>
  );
}

/** Topbar button that flips the light/dark theme and remembers the choice. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  }
  return (
    <button
      className="link"
      onClick={toggle}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      aria-label="Toggle theme"
    >
      {theme === 'dark' ? '☀ Light' : '☾ Dark'}
    </button>
  );
}
