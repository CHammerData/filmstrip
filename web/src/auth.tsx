import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { get, post, ApiError, Me } from './api';

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  // On boot, ask who we are. A 401 just means "not logged in".
  useEffect(() => {
    get<Me>('/auth/me')
      .then(setMe)
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      })
      .finally(() => setLoading(false));
  }, []);

  async function login(username: string, password: string) {
    await post('/auth/login', { username, password });
    setMe(await get<Me>('/auth/me'));
  }

  async function logout() {
    await post('/auth/logout');
    setMe(null);
  }

  return <AuthContext.Provider value={{ me, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
