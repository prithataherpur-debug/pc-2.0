import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { storage } from "@/src/utils/storage";
import { api, TOKEN_KEY, User } from "@/src/lib/api";

type AuthCtx = {
  user: User | null;
  token: string | null;
  loading: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const bootstrap = useCallback(async () => {
    const stored = await storage.secureGet(TOKEN_KEY, "");
    if (!stored) {
      setLoading(false);
      return;
    }
    setToken(stored as string);
    try {
      const me = await api.me();
      setUser(me);
    } catch {
      await storage.secureRemove(TOKEN_KEY);
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const signIn = async (username: string, password: string) => {
    const res = await api.login(username, password);
    await storage.secureSet(TOKEN_KEY, res.access_token);
    setToken(res.access_token);
    setUser(res.user);
  };

  const signOut = async () => {
    await storage.secureRemove(TOKEN_KEY);
    setToken(null);
    setUser(null);
  };

  const refresh = async () => {
    try {
      const me = await api.me();
      setUser(me);
    } catch {}
  };

  return (
    <Ctx.Provider value={{ user, token, loading, signIn, signOut, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
