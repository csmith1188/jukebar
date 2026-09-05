import { api } from './api.js';

export function searchCatalog({ query, source, offset = 0, limit, desiredTotal, includeArtists, includeAlbums }) {
  return api.post('/search', { query, source, offset, limit, desiredTotal, includeArtists, includeAlbums });
}
