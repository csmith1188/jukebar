import React, { useEffect, useState } from 'react';
import { App as AntdApp, Tabs, List, Avatar, Button, Empty, Modal, Form, Input, Tag, Tooltip, Typography } from 'antd';
import { PlayCircleOutlined, EditOutlined, CloseOutlined, PlusOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { api } from '../../api.js';
import { fetchCached } from '../../bootPrefetch.js';
import { searchCatalog } from '../../spotifySearch.js';
import { PaymentModal } from '../../components/PaymentModal.jsx';
import { SkeletonRows } from '../../components/Skeleton.jsx';

const { Text } = Typography;

function AllowedPlaylists({ session, showToast }) {
  const [playlists, setPlaylists] = useState(null);
  const [payment, setPayment] = useState(null);
  const { modal } = AntdApp.useApp();

  useEffect(() => {
    fetchCached('/api/playlists/allowed').then((d) => setPlaylists(d.playlists || [])).catch(() => setPlaylists([]));
  }, []);

  const queuePlaylist = async (id) => {
    try {
      const data = await api.post('/api/playlists/queue', { playlistId: id });
      if (data.ok !== false) showToast('Playlist queued!');
      else showToast(data.error || 'Failed to queue playlist', 'error');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const play = async (playlist) => {
    try {
      const quote = await api.post('/api/playlists/quote', { playlistId: playlist.id });
      modal.confirm({
        title: `Queue "${quote.playlist?.name || playlist.name}"?`,
        content: `${quote.queueableCount} songs${session?.isOwner ? '' : ` for ${quote.cost} Digipogs`}`,
        okText: 'Queue it up',
        onOk: () => {
          if (session?.isOwner) { queuePlaylist(playlist.id); return; }
          setPayment({ pendingAction: 'playlist', playlistId: playlist.id, onSuccess: () => queuePlaylist(playlist.id) });
        },
      });
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  if (playlists === null) return <SkeletonRows count={5} />;
  if (playlists.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={(
          <>
            <div>No playlists allowed yet.</div>
            <Text type="secondary" style={{ fontSize: '0.85em' }}>Ask your teacher to allow a Spotify playlist from the Teacher page.</Text>
          </>
        )}
      />
    );
  }

  return (
    <>
      <List
        dataSource={playlists}
        renderItem={(p) => (
          <List.Item
            key={p.id}
            className="player-sidebar-item"
            onClick={() => play(p)}
            style={{ cursor: 'pointer' }}
            extra={<Tag color="green" icon={<PlayCircleOutlined />}>Queue</Tag>}
          >
            <List.Item.Meta
              avatar={<Avatar shape="square" size={40} src={p.image || undefined} />}
              title={<span title={p.name}>{p.name}</span>}
              description={<>{p.owner}<br />{p.totalTracks} tracks</>}
            />
          </List.Item>
        )}
      />
      <PaymentModal request={payment} onClose={() => setPayment(null)} />
    </>
  );
}

// thought about putting these in the .env but i decided against it env is long enough if you want to do so then by all meands go ahead
const CREATE_PLAYLIST_FREE_SONGS = 5;
const CREATE_PLAYLIST_EXTRA_SONG_AMOUNT = 25;
const MAX_PLAYLIST_CREATE_SONGS = 30;
const MIN_PLAYLIST_CREATE_SONGS = 2;

function CreatePlaylistModal({ session, onClose, onCreated, showToast }) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState([]);
  const [payment, setPayment] = useState(null);
  const [warnedSurcharge, setWarnedSurcharge] = useState(false);
  const { modal } = AntdApp.useApp();

  const search = async () => {
    if (query.trim().length < 2) return;
    try {
      const data = await searchCatalog({ query: query.trim(), desiredTotal: 10 });
      setResults(data.tracks?.items || []);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const toggle = (track) => {
    setPicked((list) => {
      if (list.some((t) => t.uri === track.uri)) return list.filter((t) => t.uri !== track.uri);
      if (list.length >= MAX_PLAYLIST_CREATE_SONGS) {
        showToast(`You can add up to ${MAX_PLAYLIST_CREATE_SONGS} songs when creating a playlist`, 'error');
        return list;
      }
      const next = [...list, track];
      // this notifies the user that adding more than 5 songs is a 25 digipog upcharge
      if (!session?.isOwner && next.length === CREATE_PLAYLIST_FREE_SONGS + 1 && !warnedSurcharge) {
        setWarnedSurcharge(true);
        modal.info({
          title: 'Heads up',
          content: `The first ${CREATE_PLAYLIST_FREE_SONGS} songs are free, but every song you add after that costs an extra ${CREATE_PLAYLIST_EXTRA_SONG_AMOUNT} Digipogs.`,
        });
      }
      return next;
    });
  };

  const create = async () => {
    try {
      const data = await api.post('/api/custom-playlists/create', { name: name.trim(), trackUris: picked.map((t) => t.uri) });
      if (data.ok) { showToast('Playlist created'); onCreated(); onClose(); }
      else showToast(data.error || 'Failed to create playlist', 'error');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const submit = () => {
    if (!name.trim()) { showToast('Playlist name is required', 'error'); return; }
    if (picked.length < MIN_PLAYLIST_CREATE_SONGS) {
      showToast(`Add at least ${MIN_PLAYLIST_CREATE_SONGS} songs to create a playlist`, 'error');
      return;
    }
    if (session?.isOwner) { create(); return; }
    setPayment({ pendingAction: 'createPlaylist', songCount: picked.length, onSuccess: create });
  };

  const extraSongs = Math.max(0, picked.length - CREATE_PLAYLIST_FREE_SONGS);
  const extraCost = extraSongs * CREATE_PLAYLIST_EXTRA_SONG_AMOUNT;

  return (
    <Modal open onCancel={onClose} footer={null} width={760} title="Create Custom Playlist" destroyOnClose className="playlist-modal-content">
      <p className="playlist-modal-help">
        Name your playlist and add at least {MIN_PLAYLIST_CREATE_SONGS} songs — the first {CREATE_PLAYLIST_FREE_SONGS} are
        included, and each song after that costs an extra {CREATE_PLAYLIST_EXTRA_SONG_AMOUNT} Digipogs.
      </p>
      <Form layout="vertical" onFinish={submit}>
        <Form.Item label="Playlist name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. Period 3 Picks" />
        </Form.Item>

        <div className="playlist-modal-body-but-better">
          <div className="playlist-modal-field create-playlist-songs">
            <Form.Item label={`Add songs (${picked.length}${!session?.isOwner && extraSongs > 0 ? ` — +${extraCost} DP for ${extraSongs} extra song${extraSongs === 1 ? '' : 's'}` : ''})`}>
              {/* dont touch the {} around this comment leave them empty */}
              <div className="playlist-modal-search-form">
                <div className="search-container">
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }}
                    placeholder="Search for a song"
                  />
                  <button type="button" className="primary playlist-modal-search-btn" onClick={search}>Search</button>
                </div>
              </div>
            </Form.Item>
            <List
              className="playlist-search-results"
              dataSource={results}
              renderItem={(t) => {
                const isPicked = picked.some((p) => p.uri === t.uri);
                return (
                  <List.Item
                    key={t.id}
                    actions={[
                      <Button
                        key="add" size="small" type={isPicked ? 'default' : 'primary'}
                        disabled={isPicked || (!isPicked && picked.length >= MAX_PLAYLIST_CREATE_SONGS)}
                        onClick={() => toggle(t)}
                      >
                        {isPicked ? 'Added' : 'Add'}
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta avatar={<Avatar shape="square" src={t.album?.image || undefined} />} title={t.name} description={t.artist} />
                  </List.Item>
                );
              }}
            />
          </div>
          <div className="playlist-selected-songs">
            {picked.length > 0 && (
              <>
                <Text type="secondary" style={{ fontSize: '0.8em' }}>
                  Selected ({picked.length}{!session?.isOwner ? `/${CREATE_PLAYLIST_FREE_SONGS} free` : ''}):
                </Text>
                <List
                  className="playlist-selected-songs-scroll"
                  dataSource={picked}
                  renderItem={(t) => (
                    <List.Item key={t.uri} actions={[<Button key="rm" size="small" danger icon={<CloseOutlined />} onClick={() => toggle(t)} />]}>
                      <List.Item.Meta avatar={<Avatar src={t.album?.image || '/img/placeholder.png'} />} title={t.name} description={t.artist} />
                    </List.Item>
                  )}
                />
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', marginTop: 16 }}>
          {picked.length < MIN_PLAYLIST_CREATE_SONGS && (
            <Text type="secondary" style={{ fontSize: '0.8em' }}>
              Add {MIN_PLAYLIST_CREATE_SONGS - picked.length} more song{MIN_PLAYLIST_CREATE_SONGS - picked.length === 1 ? '' : 's'} to create
            </Text>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" htmlType="submit" disabled={picked.length < MIN_PLAYLIST_CREATE_SONGS}>Create</Button>
        </div>
      </Form>
      <PaymentModal request={payment} onClose={() => setPayment(null)} />
    </Modal>
  );
}

function ManagePlaylistModal({ playlist, session, onClose, showToast }) {
  const [tracks, setTracks] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [payment, setPayment] = useState(null);

  const load = () => {
    api.get(`/api/custom-playlists/${playlist.id}/tracks`).then((d) => setTracks(d.tracks || [])).catch((err) => showToast(err.message, 'error'));
  };
  useEffect(load, [playlist.id]);

  const removeSong = async (uri) => {
    const doRemove = async () => {
      const data = await api.post('/api/custom-playlists/remove-song', { playlistId: playlist.id, trackUri: uri });
      if (data.ok) { showToast('Song removed'); load(); } else showToast(data.error || 'Failed to remove', 'error');
    };
    if (session?.isOwner) return doRemove();
    setPayment({ pendingAction: 'removePlaylistSong', playlistId: String(playlist.id), onSuccess: doRemove });
  };

  const addSong = async (track) => {
    const doAdd = async () => {
      const data = await api.post('/api/custom-playlists/add-song', { playlistId: playlist.id, trackUri: track.uri });
      if (data.ok) { showToast('Song added'); load(); } else showToast(data.error || 'Failed to add', 'error');
    };
    if (session?.isOwner) return doAdd();
    setPayment({ pendingAction: 'addPlaylistSong', playlistId: String(playlist.id), onSuccess: doAdd });
  };

  const search = async () => {
    if (query.trim().length < 2) return;
    try {
      const data = await searchCatalog({ query: query.trim(), desiredTotal: 10 });
      setResults(data.tracks?.items || []);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  return (
    <Modal open onCancel={onClose} footer={null} width={640} title={playlist.name} destroyOnClose className="playlist-modal-content">
      <div className="playlist-tracks-list">
        {tracks === null && <SkeletonRows count={4} />}
        {tracks && tracks.length === 0 && <Empty description="No tracks yet." />}
        {tracks && tracks.length > 0 && (
          <List
            dataSource={tracks}
            renderItem={(t) => (
              <List.Item
                key={t.uri}
                actions={[
                  <Button key="rm" danger size="small" onClick={() => removeSong(t.uri)}>
                    Remove{session?.isOwner ? '' : ` (${session?.removePlaylistSongAmount ?? 50})`}
                  </Button>,
                ]}
              >
                <List.Item.Meta avatar={<Avatar shape="square" src={t.album?.image || undefined} />} title={t.name} description={t.artist} />
              </List.Item>
            )}
          />
        )}
      </div>
      <div style={{ marginTop: 16 }}>
        <Text style={{ display: 'block', marginBottom: 8, fontSize: '0.85em' }}>
          Add a song{session?.isOwner ? '' : ` (${session?.addPlaylistSongAmount ?? 100} Digipogs)`}
        </Text>
        <form
          className="playlist-modal-search-form playlist-modal-search-form--compact"
          onSubmit={(e) => { e.preventDefault(); search(); }}
        >
          <div className="search-container">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for a song"
            />
            <button type="submit" className="primary playlist-modal-search-btn">Search</button>
          </div>
        </form>
        <List
          dataSource={results}
          renderItem={(t) => (
            <List.Item key={t.id} onClick={() => addSong(t)} style={{ cursor: 'pointer' }} actions={[<PlusOutlined key="add" />]}>
              <List.Item.Meta avatar={<Avatar shape="square" src={t.album?.image || undefined} />} title={t.name} description={t.artist} />
            </List.Item>
          )}
        />
      </div>
      <PaymentModal request={payment} onClose={() => setPayment(null)} />
    </Modal>
  );
}

function MyPlaylists({ session, showToast }) {
  const [playlists, setPlaylists] = useState(null);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(null);
  const [payment, setPayment] = useState(null);

  const load = () => {
    fetchCached('/api/custom-playlists').then((d) => setPlaylists(d.playlists || [])).catch(() => setPlaylists([]));
  };
  useEffect(load, []);

  const queuePlaylist = async (id) => {
    try {
      const data = await api.post('/api/custom-playlists/queue', { playlistId: id });
      if (data.ok !== false) showToast('Playlist queued!');
      else showToast(data.error || 'Failed to queue playlist', 'error');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const play = (playlist) => {
    if (session?.isOwner) { queuePlaylist(playlist.id); return; }
    setPayment({ pendingAction: 'customPlaylistPlay', playlistId: String(playlist.id), onSuccess: () => queuePlaylist(playlist.id) });
  };

  return (
    <>
      <div className="player-sidebar-list-actions">
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setCreating(true)}>New Playlist</Button>
        <span className="player-sidebar-hint">Playlists built by your class.</span>
      </div>
      <div className="player-sidebar-list">
        {playlists === null && <SkeletonRows count={5} />}
        {playlists && playlists.length === 0 && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={(
              <>
                <div>No class playlists yet.</div>
                <Text type="secondary" style={{ fontSize: '0.85em' }}>Start one above anyone in class can add songs and play it.</Text>
              </>
            )}
          />
        )}
        {playlists && playlists.length > 0 && (
          <List
            dataSource={playlists}
            renderItem={(p) => (
              <List.Item
                key={p.id}
                className="player-sidebar-item"
                extra={(
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                    <Tag
                      color="green"
                      icon={<PlayCircleOutlined />}
                      style={{ cursor: 'pointer' }}
                      onClick={(e) => { e.stopPropagation(); play(p); }}
                      title="Queue this playlist"
                    >
                      Queue
                    </Tag>
                    <Tag
                      color="gold"
                      icon={<EditOutlined />}
                      style={{ cursor: 'pointer' }}
                      onClick={(e) => { e.stopPropagation(); setManaging(p); }}
                      title="Add or remove songs"
                    >
                      Modify
                    </Tag>
                  </div>
                )}
              >
                <List.Item.Meta
                  avatar={<Avatar shape="square" size={40} src={p.image_url || undefined} />}
                  title={<span title={p.name}>{p.name}</span>}
                  description={<>{p.owner_name}<br />{p.song_count} track{p.song_count === 1 ? '' : 's'}</>}
                />
              </List.Item>
            )}
          />
        )}
      </div>
      {creating && <CreatePlaylistModal session={session} onClose={() => setCreating(false)} onCreated={load} showToast={showToast} />}
      {managing && <ManagePlaylistModal playlist={managing} session={session} onClose={() => setManaging(null)} showToast={showToast} />}
      <PaymentModal request={payment} onClose={() => setPayment(null)} />
    </>
  );
}

const PLAYLIST_TAB_HINT = {
  teacher: 'Spotify playlists your teacher has approved.',
  mine: 'Custom playlists your class built in Jukebar.',
};

export function PlaylistsSidebar({ session, showToast }) {
  const [tab, setTab] = useState('teacher');

  return (
    <aside className="player-sidebar" aria-label="Playlists">
      <div className="player-sidebar-header">
        <Tabs
          activeKey={tab}
          onChange={setTab}
          size="small"
          items={[
            { key: 'teacher', label: 'Teacher Playlists' },
            { key: 'mine', label: 'Class Playlists' },
          ]}
        />
        <Tooltip title={PLAYLIST_TAB_HINT[tab]}>
          <p className="player-sidebar-tab-hint">
            <InfoCircleOutlined /> What&apos;s this?
          </p>
        </Tooltip>
      </div>
      {tab === 'teacher'
        ? <div className="player-sidebar-list"><AllowedPlaylists session={session} showToast={showToast} /></div>
        : <MyPlaylists session={session} showToast={showToast} />}
    </aside>
  );
}
