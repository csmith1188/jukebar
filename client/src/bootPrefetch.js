import { api } from './api.js';

const ROUTE_PREFETCH = {
  '/app/player': ['/api/playlists/allowed', '/api/custom-playlists', '/api/queue', '/api/me/banned'],
  '/app/teacher': ['/api/users', '/api/banned-songs', '/api/spotify/playlists', '/api/queueHistory?limit=20&offset=0'],
  '/app/settings': ['/api/settings/defaults', '/api/settings/overrides', '/api/settings/sounds'],
  '/app/leaderboard': ['/api/leaderboard'],
};

const cache = new Map();

export function prefetchRoute(pathname) {
  const urls = ROUTE_PREFETCH[pathname] || ROUTE_PREFETCH['/app/player'];
  return Promise.allSettled(
    urls.map((url) => {
      const promise = api.get(url);
      cache.set(url, promise);
      return promise;
    })
  );
}

export function fetchCached(url) {
  const cached = cache.get(url);
  if (cached) {
    cache.delete(url);
    return cached;
  }
  return api.get(url);
}
