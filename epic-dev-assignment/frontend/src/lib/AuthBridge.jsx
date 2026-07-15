import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { setTokenGetter } from './api.js';

// Bridges Clerk's hook-based getToken() into the plain-JS API layer (lib/api.js).
// Must be rendered inside <ClerkProvider>. Renders nothing.
export default function AuthBridge() {
  const { getToken } = useAuth();

  useEffect(() => {
    setTokenGetter(() => getToken());
    return () => setTokenGetter(null);
  }, [getToken]);

  return null;
}
