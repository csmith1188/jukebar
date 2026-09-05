import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  App as AntdApp, Tabs, Badge, Switch, Table, List, Avatar, Button, Input,
  Modal, Form, Tag, Tooltip, Empty, Typography,
} from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { api } from '../api.js';
import { fetchCached } from '../bootPrefetch.js';
import { socket } from '../socket.js';
import { searchCatalog } from '../spotifySearch.js';
import { SkeletonRows } from '../components/Skeleton.jsx';
import { Spinner } from '../components/Spinner.jsx';
import { useAppMessage } from '../useAppMessage.js';

const { Text } = Typography;

function timeAgo(timestamp) {
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// ---- spotify background sync toggle ----
function SpotifyBackgroundToggle() {
  const [enabled, setEnabled] = useState(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    api.get('/api/spotify-background')
      .then((d) => setEnabled(!!d.enabled))
      .catch(() => setVisible(false));
  }, []);

  if (!visible || enabled === null) return null;

  const toggle = async (want) => {
    setEnabled(want);
    try {
      await api.post('/api/spotify-background', { enabled: want });
    } catch {
      setEnabled(!want);
    }
  };

  return (
    <div className="teacher-spotify-bg-toggle">
      <span
        className="teacher-spotify-bg-label"
        title="When off, Jukebar stops automatic Spotify sync and diagnostics in the background to reduce API use and rate limits. Turn on again before class."
      >
        Spotify background sync
      </span>
      <Switch checked={enabled} onChange={toggle} />
    </div>
  );
}

// ---- User management ----
function UserManagement({ onShowTransactions, ownerIDs, showToast, onCount }) {
  const [users, setUsers] = useState(null);
  const [filter, setFilter] = useState('');
  const { modal } = AntdApp.useApp();

  const load = useCallback(() => {
    fetchCached('/api/users').then(setUsers).catch(() => setUsers([]));
  }, []);

  useEffect(load, [load]);
  useEffect(() => { if (users) onCount?.(users.length); }, [users, onCount]);

  const toggleBan = async (user) => {
    const isBanned = !!user.isBanned;
    const action = isBanned ? 'unban' : 'ban';
    const msg = isBanned
      ? `Unban ${user.displayName}? They will be able to use Jukebar again.`
      : `Ban ${user.displayName}? They will not be able to queue songs, skip, or start ban votes.`;
    modal.confirm({
      title: isBanned ? 'Unban user?' : 'Ban user?',
      content: msg,
      okText: isBanned ? 'Unban' : 'Ban',
      okButtonProps: { danger: !isBanned },
      onOk: async () => {
        try {
          const data = await api.post(`/api/users/${action}`, { username: user.displayName });
          if (data.success || data.ok) {
            showToast(`${user.displayName} has been ${action === 'ban' ? 'banned' : 'unbanned'}`);
            load();
          } else {
            showToast(data.error || `Failed to ${action} user`, 'error');
          }
        } catch (err) {
          showToast(err.message, 'error');
        }
      },
    });
  };

  const visible = (users || []).filter((u) => (u.displayName || '').toLowerCase().includes(filter.toLowerCase()));

  const columns = [
    {
      title: 'Username',
      dataIndex: 'displayName',
      key: 'displayName',
      render: (name, user) => {
        const isTeacherOrOwner = user.permission >= 4 || ownerIDs.includes(user.id);
        return (
          <span>
            {name}{' '}
            {/* isBanned is a SQLite 0/1, not a real boolean — bare `&&` would
                render a literal "0" next to the name when falsy. */}
            {!!user.isBanned && <Tag color="error">BANNED</Tag>}
            {isTeacherOrOwner && <Tag color="success">TEACHER</Tag>}
          </span>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      align: 'center',
      render: (_, user) => {
        const isTeacherOrOwner = user.permission >= 4 || ownerIDs.includes(user.id);
        return (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
            <Tooltip title="View Transactions">
              <Button size="small" icon={<SearchOutlined />} onClick={() => onShowTransactions(user.displayName)} />
            </Tooltip>
            {!isTeacherOrOwner && (
              <Button size="small" danger={!user.isBanned} onClick={() => toggleBan(user)}>
                {user.isBanned ? 'Unban' : 'Ban'}
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div id="userManagement">
      <div className="section-header">
        <h2>User Management</h2>
        <p className="section-subtitle">Manage user access and permissions</p>
      </div>
      <Input
        placeholder="Search users..."
        prefix={<SearchOutlined />}
        allowClear
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ marginBottom: 12 }}
      />
      <div id="userList">
        {users === null && <SkeletonRows count={6} />}
        {users && users.length === 0 && <Empty description="No users found." />}
        {users && users.length > 0 && (
          <Table
            rowKey="id"
            columns={columns}
            dataSource={visible}
            size="small"
            pagination={false}
          />
        )}
      </div>
    </div>
  );
}

// ---- Banned songs ----
function BannedSongsPanel({ showToast, onCount }) {
  const [songs, setSongs] = useState(null);
  const { modal } = AntdApp.useApp();

  const load = useCallback(() => {
    fetchCached('/api/banned-songs').then((d) => setSongs(d.songs || [])).catch(() => setSongs([]));
  }, []);

  useEffect(load, [load]);
  useEffect(() => { if (songs) onCount?.(songs.length); }, [songs, onCount]);

  const unban = async (name, artist) => {
    modal.confirm({
      title: 'Unban song?',
      content: `Unban ${name} - ${artist}?`,
      okText: 'Unban',
      onOk: async () => {
        try {
          const data = await api.post('/unbanTrack', { name, artist });
          if (data.ok) { showToast(`Unbanned: ${name} - ${artist}`); load(); }
          else showToast(data.error || 'Failed to unban track', 'error');
        } catch (err) {
          showToast(err.message, 'error');
        }
      },
    });
  };

  return (
    <div id="bannedSongsPanel">
      <div className="section-header">
        <h2>Banned Songs</h2>
        <p className="section-subtitle">All banned tracks</p>
      </div>
      <div id="bannedSongsList">
        {songs === null && <SkeletonRows count={6} />}
        {songs && songs.length === 0 && <Empty description="No banned songs." />}
        {songs && songs.length > 0 && (
          <List
            dataSource={songs}
            renderItem={(song) => (
              <List.Item
                key={song.id}
                actions={[<Button key="unban" size="small" onClick={() => unban(song.track_name, song.artist_name)}>Unban</Button>]}
              >
                <List.Item.Meta
                  avatar={<Avatar shape="square" size={44} src={song.album_image || undefined} />}
                  title={(
                    <Tooltip
                      title={`Reason: ${song.reason}\nBy: ${song.banned_by_name}\nWhen: ${song.timestamp ? new Date(song.timestamp).toLocaleString() : 'Unknown time'}`}
                    >
                      {song.track_name || 'Unknown Track'}
                    </Tooltip>
                  )}
                  description={song.artist_name || 'Unknown Artist'}
                />
              </List.Item>
            )}
          />
        )}
      </div>
    </div>
  );
}

// ---- Playlists (allow/disallow) ----
function PlaylistsColumn({ showToast, onCount }) {
  const [playlists, setPlaylists] = useState(null);
  const [error, setError] = useState(null);
  const [customPlaylists, setCustomPlaylists] = useState(null);
  const { modal } = AntdApp.useApp();

  useEffect(() => {
    fetchCached('/api/spotify/playlists')
      .then((d) => setPlaylists(d.playlists || []))
      .catch((err) => setError(err.message));
  }, []);
  useEffect(() => { if (playlists) onCount?.(playlists.length); }, [playlists, onCount]);

  const loadCustomPlaylists = useCallback(() => {
    fetchCached('/api/custom-playlists').then((d) => setCustomPlaylists(d.playlists || [])).catch(() => setCustomPlaylists([]));
  }, []);
  useEffect(loadCustomPlaylists, [loadCustomPlaylists]);

  const toggleAllow = async (playlist) => {
    const nowAllowed = !playlist.isAllowed;
    const endpoint = playlist.isAllowed ? '/api/spotify/playlists/disallow' : '/api/spotify/playlists/allow';
    try {
      await api.post(endpoint, {
        playlistId: playlist.id, name: playlist.name, owner: playlist.owner, image: playlist.image, totalTracks: playlist.totalTracks,
      });
      setPlaylists((list) => list.map((p) => (p.id === playlist.id ? { ...p, isAllowed: nowAllowed } : p)));
      showToast(`${playlist.name} ${nowAllowed ? 'allowed' : 'disallowed'} for students`);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const deleteCustomPlaylist = (playlist) => {
    modal.confirm({
      title: 'Delete class playlist?',
      content: `Delete "${playlist.name}"? This removes it for the whole class and can't be undone.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.del(`/api/custom-playlists/${playlist.id}`);
          setCustomPlaylists((list) => list.filter((p) => p.id !== playlist.id));
          showToast(`Deleted playlist "${playlist.name}"`);
        } catch (err) {
          showToast(err.message, 'error');
        }
      },
    });
  };

  return (
    <div id="playlistColumn">
      <div className="section-header">
        <h2>Playlists</h2>
        <p className="section-subtitle">Your playlists</p>
      </div>
      <div id="playlistList">
        {error && <Empty description={error} />}
        {!error && playlists === null && <SkeletonRows count={5} />}
        {!error && playlists && playlists.length === 0 && <Empty description="No playlists found." />}
        {!error && playlists && playlists.length > 0 && (
          <List
            dataSource={playlists}
            renderItem={(playlist) => (
              <List.Item
                key={playlist.id}
                actions={[
                  <Button
                    key="toggle" size="small" danger={playlist.isAllowed} type={playlist.isAllowed ? 'default' : 'primary'}
                    onClick={() => toggleAllow(playlist)}
                  >
                    {playlist.isAllowed ? 'Disallow' : 'Allow'}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  avatar={<Avatar shape="square" size={44} src={playlist.image || '/img/placeholder.png'} />}
                  title={playlist.name || 'Untitled Playlist'}
                  description={(
                    <>
                      <div>{playlist.owner || 'Unknown'} • {playlist.totalTracks || 0} tracks</div>
                      {playlist.canAccessTracks === false && (
                        <Text type="warning" style={{ fontSize: '0.75em' }}>Not owned — students cannot queue this playlist</Text>
                      )}
                    </>
                  )}
                />
              </List.Item>
            )}
          />
        )}

        <div className="section-header" style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: '1.1rem' }}>Class Playlists</h2>
          <p className="section-subtitle">Custom playlists your students built</p>
        </div>
        {customPlaylists === null && <SkeletonRows count={3} />}
        {customPlaylists && customPlaylists.length === 0 && <Empty description="No class playlists yet." />}
        {customPlaylists && customPlaylists.length > 0 && (
          <List
            dataSource={customPlaylists}
            renderItem={(playlist) => (
              <List.Item
                key={playlist.id}
                actions={[
                  <Button key="delete" size="small" danger onClick={() => deleteCustomPlaylist(playlist)}>Delete</Button>,
                ]}
              >
                <List.Item.Meta
                  avatar={<Avatar shape="square" size={44} src={playlist.image_url || '/img/placeholder.png'} />}
                  title={playlist.name || 'Untitled Playlist'}
                  description={`${playlist.owner_name || 'Unknown'} • ${playlist.song_count || 0} track${playlist.song_count === 1 ? '' : 's'}`}
                />
              </List.Item>
            )}
          />
        )}
      </div>
    </div>
  );
}

// ---- Queue history ----
function QueueHistory() {
  const [plays, setPlays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchCached(`/api/queueHistory?limit=${limit}&offset=${offsetRef.current}`);
      const newPlays = data.plays || [];
      setPlays((prev) => [...prev, ...newPlays]);
      offsetRef.current += newPlays.length;
      setHasMore(newPlays.length >= limit);
    } catch {
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div id="queueHistory">
      <div className="section-header">
        <h2>Queue History</h2>
        <p className="section-subtitle">Recently played tracks</p>
      </div>
      <div id="historyList">
        {plays.length === 0 && !loading && <Empty description="No play history found" />}
        {plays.length === 0 && loading && <SkeletonRows count={6} />}
        {plays.length > 0 && (
          <List
            dataSource={plays}
            renderItem={(play, i) => (
              <List.Item key={`${play.track_uri}-${play.timestamp}-${i}`} className="queue-item">
                <List.Item.Meta
                  avatar={<Avatar shape="square" size={52} src={play.albumImage || undefined} />}
                  title={play.track_name}
                  description={play.artist_name}
                />
                <div style={{ textAlign: 'right', minWidth: 120 }}>
                  <div style={{ color: '#1db954', fontSize: '0.85rem', fontWeight: 500 }}>{play.user}</div>
                  <div style={{ color: 'rgba(255,255,255,.5)', fontSize: '0.8rem', marginTop: 2 }}>{timeAgo(play.timestamp)}</div>
                </div>
              </List.Item>
            )}
          />
        )}
      </div>
      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <Button loading={loading} onClick={load}>Load More</Button>
        </div>
      )}
    </div>
  );
}

// ---- Music control: search + ban/unban ----
const BAN_SEARCH_PAGE_SIZE = 10;

function MusicControl({ onBanRequest, showToast }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const nextOffsetRef = useRef(0);
  // "No results" must only show after a real search comes back empty, not
  // just because the box currently has text in it.
  const [hasSearched, setHasSearched] = useState(false);
  const searchSeq = useRef(0);

  const runSearch = useCallback(async (q) => {
    if (!q || q.trim().length < 2) { setResults([]); setSearching(false); setHasSearched(false); setHasMore(false); return; }
    const seq = ++searchSeq.current;
    setSearching(true);
    try {
      const data = await searchCatalog({
        query: q.trim(), source: 'teacher', includeArtists: false, includeAlbums: false,
        limit: BAN_SEARCH_PAGE_SIZE, desiredTotal: BAN_SEARCH_PAGE_SIZE,
      });
      if (seq !== searchSeq.current) return;
      setResults(data.tracks?.items || []);
      nextOffsetRef.current = data.nextOffset || 0;
      setHasMore(!!data.hasMore);
    } catch (err) {
      if (seq === searchSeq.current) showToast(err.message, 'error');
    } finally {
      if (seq === searchSeq.current) { setSearching(false); setHasSearched(true); }
    }
  }, [showToast]);

  const loadMore = useCallback(async () => {
    const q = query.trim();
    if (!q || loadingMore) return;
    const seq = searchSeq.current;
    setLoadingMore(true);
    try {
      const data = await searchCatalog({
        query: q, source: 'teacher', includeArtists: false, includeAlbums: false,
        limit: BAN_SEARCH_PAGE_SIZE, desiredTotal: BAN_SEARCH_PAGE_SIZE, offset: nextOffsetRef.current,
      });
      if (seq !== searchSeq.current) return;
      setResults((prev) => [...prev, ...(data.tracks?.items || [])]);
      nextOffsetRef.current = data.nextOffset || nextOffsetRef.current;
      setHasMore(!!data.hasMore);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoadingMore(false);
    }
  }, [query, loadingMore, showToast]);

  const onChange = (v) => {
    setQuery(v);
    setHasSearched(false);
    if (!v.trim()) { setResults([]); setSearching(false); setHasMore(false); }
  };

  const unban = async (track) => {
    try {
      const data = await api.post('/unbanTrack', { name: track.name, artist: track.artist });
      if (data.ok) { showToast('Track unbanned'); runSearch(query); }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  return (
    <div id="spotifyPlayer">
      <div className="section-header">
        <h2>Music Control</h2>
        <p className="section-subtitle">Search and manage the music queue</p>
      </div>
      {/* dont touch the {} around this comment leave them empty */}
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
      {searching && <Spinner label="Searching Spotify…" />}
      <div id="searchResults" style={{ marginTop: 12 }}>
        {!searching && hasSearched && results.length === 0 && <p style={{ color: '#b3b3b3' }}>No results found.</p>}
        {results.map((track) => (
          <div key={track.id} className="search-result-item">
            {track.album?.image
              ? <img src={track.album.image} alt={track.album.name || ''} className="album-cover" />
              : <div className="album-cover" style={{ background: '#282828', borderRadius: 4, flexShrink: 0 }} />}
            <div className="search-result-content">
              <div className="search-result-title">{track.name}</div>
              <div className="search-result-artist">{track.artist}</div>
            </div>
            <button
              className={track.isBanned ? 'unban-button' : 'ban-button'}
              title={track.isBanned ? 'Unban this track' : 'Ban this track'}
              onClick={() => (track.isBanned ? unban(track) : onBanRequest(track))}
            >
              {track.isBanned ? 'Unban' : 'Ban'}
            </button>
          </div>
        ))}
      </div>
      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <Button loading={loadingMore} onClick={loadMore}>Load More</Button>
        </div>
      )}
    </div>
  );
}

// ---- Ban reason modal ----
function BanReasonModal({ pending, onCancel, onConfirm }) {
  const [reason, setReason] = useState('');
  useEffect(() => { setReason(''); }, [pending]);

  return (
    <Modal
      open={!!pending}
      onCancel={onCancel}
      title="Reason for ban"
      okText="Ban Song"
      okButtonProps={{ danger: true, disabled: !reason.trim() }}
      onOk={() => reason.trim() && onConfirm(reason.trim())}
      destroyOnClose
    >
      <Form layout="vertical" onFinish={() => reason.trim() && onConfirm(reason.trim())}>
        <Form.Item>
          <Input
            id="teacherBanReasonInput"
            placeholder="Enter reason (required)"
            maxLength={200}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---- Transactions modal ----
function TransactionsModal({ username, onClose, showToast }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!username) return;
    api.post('/api/users/transactions', { username, page, limit: pageSize })
      .then(setData)
      .catch((err) => showToast(err.message, 'error'));
  }, [username, page, pageSize, showToast]);

  useEffect(() => { if (!username) { setPage(1); setPageSize(10); } }, [username]);

  // Table's pagination is fully controlled (current + pageSize both driven
  // by state, both updated together here) — leaving pageSize hardcoded
  // while antd's own size-changer dropdown tried to pick a different one
  // made the component fight itself: it'd request a new size, get handed
  // back the same fixed prop next render, and re-fire onChange trying to
  // "correct" that, over and over, hammering the server with requests
  // until it started getting 429s.
  const onPageChange = (nextPage, nextPageSize) => {
    if (nextPageSize !== pageSize) {
      setPageSize(nextPageSize);
      setPage(1);
    } else {
      setPage(nextPage);
    }
  };

  const pagination = data?.pagination;

  const columns = [
    {
      title: '',
      key: 'image',
      width: 50,
      render: (_, t) => (t.image_url
        ? <img src={t.image_url} alt="" style={{ width: 40, height: 40, borderRadius: 4, objectFit: 'cover' }} />
        : <div style={{ width: 40, height: 40, background: '#282828', borderRadius: 4 }} />),
    },
    { title: 'Track', dataIndex: 'track_name', key: 'track', render: (v) => v || 'Unknown' },
    { title: 'Artist', dataIndex: 'artist_name', key: 'artist', render: (v) => v || 'Unknown' },
    { title: 'Cost', dataIndex: 'cost', key: 'cost', render: (v) => <Tag color="green">{v} Digipogs</Tag> },
    { title: 'Time', dataIndex: 'formatted_time', key: 'time' },
  ];

  return (
    <Modal open={!!username} onCancel={onClose} footer={null} width={720} title={`Play History for ${username}`} destroyOnClose>
      {!data && <SkeletonRows count={6} />}
      {data && data.transactions.length === 0 && <Empty description="No plays found for this user." />}
      {data && data.transactions.length > 0 && (
        <Table
          rowKey={(t, i) => i}
          columns={columns}
          dataSource={data.transactions}
          size="small"
          pagination={pagination ? {
            current: pagination.currentPage,
            pageSize: 10,
            total: pagination.totalCount,
            onChange: setPage,
          } : false}
        />
      )}
    </Modal>
  );
}

export function TeacherPage({ session }) {
  const canManage = (session?.userPermission ?? 0) >= 4 || session?.isOwner;
  const [banPending, setBanPending] = useState(null);
  const [transactionsFor, setTransactionsFor] = useState(null);
  const [activeTab, setActiveTab] = useState('music');
  const [counts, setCounts] = useState({ playlists: null, users: null, banned: null });
  const { showToast } = useAppMessage();

  useEffect(() => {
    socket.connect();
    return () => socket.disconnect();
  }, []);

  if (!canManage) {
    return <main className="main-content"><div className="page-error">Teacher access only.</div></main>;
  }

  const confirmBan = async (reason) => {
    const track = banPending;
    setBanPending(null);
    try {
      const data = await api.post('/banTrack', { name: track.name, artist: track.artist, reason, uri: track.uri, image: track.album?.image });
      if (data.ok) showToast('Track banned');
      else showToast(data.error || 'Failed to ban track', 'error');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const tabLabel = (label, count) => (count != null ? <Badge count={count} size="small" offset={[8, 0]}>{label}</Badge> : label);

  const tabItems = [
    { key: 'music', label: 'Music Control', children: <MusicControl onBanRequest={setBanPending} showToast={showToast} /> },
    { key: 'queue', label: 'Queue History', children: <QueueHistory /> },
    {
      key: 'playlists',
      label: tabLabel('Playlists', counts.playlists),
      children: <PlaylistsColumn showToast={showToast} onCount={(n) => setCounts((c) => ({ ...c, playlists: n }))} />,
    },
    {
      key: 'users',
      label: tabLabel('Users', counts.users),
      children: (
        <UserManagement
          onShowTransactions={setTransactionsFor}
          ownerIDs={session?.ownerIDs || []}
          showToast={showToast}
          onCount={(n) => setCounts((c) => ({ ...c, users: n }))}
        />
      ),
    },
    {
      key: 'banned',
      label: tabLabel('Banned Songs', counts.banned),
      children: <BannedSongsPanel showToast={showToast} onCount={(n) => setCounts((c) => ({ ...c, banned: n }))} />,
    },
  ];

  return (
    <div className="main-content">
      <div className="teacher-toolbar">
        {(session?.jukepixFeatureEnabled ?? true) && (
          <Link className="changelog-button" to="/app/settings" title="JukePix Settings">
            <img src="/img/settings.png" alt="JukePix Settings" />
          </Link>
        )}
        {session?.spotifyApiConfigured && <SpotifyBackgroundToggle />}
        <p className="user-greeting teacher-toolbar-greeting">Logged in as: <strong>{session?.user}</strong></p>
      </div>

      <Tabs
        className="teacher-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        destroyInactiveTabPane={false}
        animated={false}
      />

      <BanReasonModal pending={banPending} onCancel={() => setBanPending(null)} onConfirm={confirmBan} />
      <TransactionsModal username={transactionsFor} onClose={() => setTransactionsFor(null)} showToast={showToast} />
    </div>
  );
}
