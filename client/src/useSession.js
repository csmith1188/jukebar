import { useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

export function useSession() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(() => {
    setLoading(true);
    api
      .get('/api/me')
      .then((data) => setSession(data))
      .catch((err) => setError(err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { session, loading, error, reload };
}
