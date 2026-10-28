import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { searchCatalog } from '../../spotifySearch.js';
import { socket } from '../../socket.js';
import { PaymentModal } from '../../components/PaymentModal.jsx';
import { Spinner } from '../../components/Spinner.jsx';
import { ArtistModal } from '../../components/ArtistModal.jsx';

function coverOf(item) {
  return item?.album?.image || item?.image || null;
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'songs', label: 'Songs' },
  { key: 'artists', label: 'Artists' },
  { key: 'albums', label: 'Albums' },
];

export function SearchPanel({ session, showToast, onVoteBan }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [tracks, setTracks] = useState([]);
  const [artists, setArtists] = useState([]);
  const [albums, setAlbums] = useState([]);
  const [artistRequest, setArtistRequest] = useState(null);
  const [ownerAnon, setOwnerAnon] = useState(false);
  const [payment, setPayment] = useState(null);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const searchSeq = useRef(0);
  const [recentlyViewed, setRecentlyViewed] = useState([]);

  const loadRecentlyViewed = useCallback(async () => {
    try {
      const data = await api.get('/recentlyQueued');
      setRecentlyViewed(data.ok ? (data.tracks || []) : []);
    } catch {
      setRecentlyViewed([]);
    }
  }, []);

  useEffect(() => {
    loadRecentlyViewed();
    const onHistoryChange = () => loadRecentlyViewed();
    socket.on('queueHistoryUpdated', onHistoryChange);
    socket.on('recentlyQueuedCleared', onHistoryChange);
    socket.on('recentlyQueuedUpdate', onHistoryChange);
    return () => {
      socket.off('queueHistoryUpdated', onHistoryChange);
      socket.off('recentlyQueuedCleared', onHistoryChange);
      socket.off('recentlyQueuedUpdate', onHistoryChange);
    };
  }, [loadRecentlyViewed]);

  const logInteraction = (type, payload) => {
    api.post('/recentlyQueued/interactions', {
      type,
      id: payload?.id || '',
      name: payload?.name || '',
      subtitle: payload?.subtitle || '',
      image: payload?.image || '',
    }).catch(() => { });
  };

  const clearHistory = async () => {
    if (!window.confirm('Are you sure you want to clear your history?')) return;
    try {
      const data = await api.post('/clearQueueHistory');
      if (data.ok) {
        showToast('History cleared', 'info');
        setRecentlyViewed([]);
      } else {
        showToast('Failed to clear history', 'error');
      }
    } catch (err) {
      showToast(err.message || 'Error clearing history', 'error');
    }
  };

  const runSearch = useCallback(async (q) => {
    if (!q || q.trim().length < 2) { setTracks([]); setArtists([]); setAlbums([]); setSearching(false); setHasSearched(false); return; }
    const seq = ++searchSeq.current;
    setSearching(true);
    try {
      const data = await searchCatalog({ query: q.trim(), includeArtists: true, includeAlbums: true, desiredTotal: 16 });
      if (seq !== searchSeq.current) return; // a newer search superseded this one
      setTracks(data.tracks?.items || []);
      setArtists(data.artists || []);
      setAlbums(data.albums || []);
    } catch (err) {
      if (seq === searchSeq.current) showToast(err.message, 'error');
    } finally {
      if (seq === searchSeq.current) { setSearching(false); setHasSearched(true); }
    }
  }, [showToast]);

  const onChange = (v) => {
    setQuery(v);
    setHasSearched(false);
    if (!v.trim()) { setTracks([]); setArtists([]); setAlbums([]); setSearching(false); }
  };

  const addToQueue = async (track, anonMode) => {
    try {
      const data = await api.post('/addToQueue', {
        uri: track.uri, anonMode: !!anonMode, trackName: track.name, trackArtist: track.artist, trackImage: coverOf(track),
      });
      if (data.success) showToast(`Added "${track.name}" to the queue`);
      else showToast(data.error || 'Failed to queue track', 'error');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const requestAdd = (track) => {
    if (session?.isOwner) { addToQueue(track, ownerAnon); return; }
    setPayment({ pendingAction: 'play', onSuccess: ({ anonMode }) => addToQueue(track, anonMode) });
  };

  // Opens the same full artist/album browser the classic player used
  // (Popular Tracks + Albums & Singles, with album drill-down) instead of
  // just re-running the search under the artist's name.
  const openArtist = (artist) => {
    logInteraction('artist', { id: artist.id, name: artist.name, image: artist.image });
    setArtistRequest({ type: 'artist', id: artist.id, name: artist.name, image: artist.image });
  };

  const openAlbum = (album) => {
    const year = album.release_date ? album.release_date.slice(0, 4) : '';
    logInteraction('album', {
      id: album.id, name: album.name, image: album.image,
      subtitle: `${album.artists || ''}${year ? ` · ${year}` : ''}`.trim(),
    });
    setArtistRequest({ type: 'album', id: album.id, name: album.name, image: album.image, year });
  };

  const showFilterTabs = tracks.length > 0 || artists.length > 0 || albums.length > 0;
  const showTracks = filter === 'all' || filter === 'songs';
  const showArtists = filter === 'all' || filter === 'artists';
  const showAlbums = filter === 'all' || filter === 'albums';
  const noResults = !searching && hasSearched && !showFilterTabs;
  // Recently-viewed tiles only stand in for an empty #searchResults, same as
  // classic player.ejs's loadRecentlyQueued() only rendering into an empty div.
  const showRecentlyViewed = !query.trim() && !searching && recentlyViewed.length > 0;

  const artistTile = (artist, key) => (
    <div key={key} className="search-result-item artist-result-item" onClick={() => openArtist(artist)}>
      {artist.image
        ? <img src={artist.image} alt={artist.name} className="album-cover artist-cover" />
        : <div className="album-cover artist-cover" style={{ background: '#282828', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2em' }}>🎤</div>}
      <div className="search-result-content-outer">
        <div className="thebackgroundoftheitemsthatareinthesearchresults" />
        <div className="search-result-content-pushies">
          <span className="artist-badge">ARTIST</span>
          <div className="search-result-title" title={artist.name}>{artist.name}</div>
        </div>
      </div>
    </div>
  );

  const albumTile = (album, key) => {
    const year = album.release_date ? album.release_date.slice(0, 4) : '';
    return (
      <div key={key} className="search-result-item album-result-item" onClick={() => openAlbum(album)}>
        {album.image
          ? <img src={album.image} alt={album.name} className="album-cover" />
          : <div className="album-cover" style={{ background: '#282828' }} />}
        <div className="search-result-content-outer">
          <div className="thebackgroundoftheitemsthatareinthesearchresults" />
          <div className="search-result-content-pushies">
            <span className="album-badge">ALBUM</span>
            <div className="search-result-title" title={album.name}>{album.name}</div>
            <div className="search-result-artist">{album.artists}{year ? ` · ${year}` : ''}</div>
          </div>
        </div>
      </div>
    );
  };

  const trackTile = (track, key) => (
    <div key={key} className="search-result-item">
      {coverOf(track)
        ? <img src={coverOf(track)} alt={track.album?.name || ''} className="album-cover" />
        : <div className="album-cover" style={{ background: '#282828', borderRadius: 4, flexShrink: 0 }} />}
      <div className="search-result-content-outer">
        <div className="thebackgroundoftheitemsthatareinthesearchresults" />
        <div className="search-result-content-pushies">
          <div className="search-result-title" title={track.name}>{track.name}</div>
          <div className="search-result-artist" title={track.artist}>{track.artist}</div>
          <div className="search-result-actions">
            <button className="play-button-icon" title="Add to queue" onClick={() => requestAdd(track)}>
              <img src="/img/play.png" alt="Play" className="play-icon" />
            </button>
            <button className="ban-button-icon" title="Vote to ban" onClick={() => onVoteBan(track)}>
              <img src="/img/ban.png" alt="Ban" className="ban-icon" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const recentTile = (item, idx) => {
    const key = `recent-${item.uri}-${idx}`;
    const id = (item.uri || '').split(':')[2] || '';
    if (item.itemType === 'artist') {
      return artistTile({ id, name: item.name, image: item.album?.image || '' }, key);
    }
    if (item.itemType === 'album') {
      const artistsText = (item.artist && item.artist !== 'Unknown') ? item.artist : '';
      return albumTile({
        id, name: item.name, image: item.album?.image || '',
        artists: artistsText, release_date: item.releaseYear ? `${item.releaseYear}-01-01` : '',
      }, key);
    }
    return trackTile(item, key);
  };

  return (
    <main className="player-main" aria-label="Search">
      <div id="spotifyPlayer" className="player-search-panel">
        <form onSubmit={(e) => { e.preventDefault(); runSearch(query); }}>
          <div className="search-container">
            <input
              id="searchInput"
              type="text"
              autoComplete="off"
              placeholder="Search for a song, artist, or album"
              value={query}
              onChange={(e) => onChange(e.target.value)}
            />
            <button id="searchButton" type="submit" aria-label="Search">
              <img src="/img/search.png" alt="" className="search-icon" />
            </button>
          </div>
        </form>

        {session?.isOwner && (
          <div className="owner-anon-container">
            <label className="owner-anon-label">
              <input type="checkbox" checked={ownerAnon} onChange={(e) => setOwnerAnon(e.target.checked)} />
              Add songs anonymously
            </label>
          </div>
        )}

        {showFilterTabs && (
          <div id="searchFilterTabs" className="search-filter-tabs">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`search-filter-tab${filter === f.key ? ' active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}

        {searching && <Spinner label="Searching Spotify…" />}

        <div id="searchResults">
          {noResults && (
            <p style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#b3b3b3', padding: '20px 0' }}>No results found.</p>
          )}

          {showRecentlyViewed && (
            <>
              <div className="recently-queued-header">
                <span>Recently Viewed</span>
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); clearHistory(); }}
                  style={{ fontSize: '0.85em', color: 'rgba(255, 255, 255, 0.6)', textDecoration: 'none', cursor: 'pointer', transition: 'color 0.2s' }}
                  onMouseOver={(e) => { e.currentTarget.style.color = 'rgba(255, 255, 255, 0.9)'; }}
                  onMouseOut={(e) => { e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)'; }}
                >
                  Clear History
                </a>
              </div>
              <hr className="recently-queued-divider" />
              {recentlyViewed.map((item, idx) => recentTile(item, idx))}
            </>
          )}

          {showArtists && artists.map((artist) => artistTile(artist, `a-${artist.id}`))}

          {showAlbums && albums.map((album) => albumTile(album, `al-${album.id}`))}

          {showTracks && tracks.map((track) => trackTile(track, track.id))}
        </div>
      </div>

      <PaymentModal request={payment} onClose={() => setPayment(null)} />
      <ArtistModal request={artistRequest} onClose={() => setArtistRequest(null)} onAdd={requestAdd} />
    </main>
  );
}
