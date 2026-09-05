import React, { useCallback, useEffect, useState } from 'react';
import { Modal, List, Avatar, Card, Button, Empty, Tooltip } from 'antd';
import { PlayCircleOutlined, LeftOutlined } from '@ant-design/icons';
import { api } from '../api.js';
import { SkeletonRows } from './Skeleton.jsx';

function formatDuration(ms) {
  if (!ms) return '';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// requests should look like this: { type: 'artist', id, name, image } | { type: 'album', id, name, image, year }
export function ArtistModal({ request, onClose, onAdd }) {
  const [view, setView] = useState('overview'); // 'overview' | 'album'
  const [topTracks, setTopTracks] = useState(null);
  const [albums, setAlbums] = useState(null);
  const [albumsOffset, setAlbumsOffset] = useState(0);
  const [albumsHasMore, setAlbumsHasMore] = useState(false);
  const [albumsLoadingMore, setAlbumsLoadingMore] = useState(false);
  const [albumDetail, setAlbumDetail] = useState(null);

  const directAlbumMode = request?.type === 'album';

  const loadAlbum = useCallback(async (id, name, image, year) => {
    setAlbumDetail({ id, name, image, year, tracks: null, error: null });
    try {
      const d = await api.get(`/api/album/${id}/tracks`);
      if (!d.ok) { setAlbumDetail((a) => (a && a.id === id ? { ...a, tracks: [], error: 'Failed to load album tracks.' } : a)); return; }
      setAlbumDetail((a) => (a && a.id === id ? { ...a, tracks: d.tracks || [], year: a.year || d.releaseYear || '' } : a));
    } catch (err) {
      setAlbumDetail((a) => (a && a.id === id ? { ...a, tracks: [], error: err.message } : a));
    }
  }, []);

  const loadAlbums = useCallback(async (artistId, offset, append) => {
    if (append) setAlbumsLoadingMore(true);
    try {
      const d = await api.get(`/api/artist/${artistId}/albums${offset ? `?offset=${offset}` : ''}`);
      const list = d.ok ? (d.albums || []) : [];
      setAlbums((prev) => (append ? [...(prev || []), ...list] : list));
      setAlbumsOffset(d.nextOffset || 0);
      setAlbumsHasMore(!!d.hasMore);
    } catch {
      if (!append) setAlbums([]);
    } finally {
      setAlbumsLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (!request) return;
    setAlbumDetail(null);
    if (request.type === 'album') {
      setView('album');
      loadAlbum(request.id, request.name, request.image, request.year);
      return;
    }
    setView('overview');
    setTopTracks(null);
    setAlbums(null);
    setAlbumsOffset(0);
    setAlbumsHasMore(false);
    api.get(`/api/artist/${request.id}/top-tracks?name=${encodeURIComponent(request.name || '')}`)
      .then((d) => setTopTracks(d.ok ? (d.tracks || []) : []))
      .catch(() => setTopTracks([]));
    loadAlbums(request.id, 0, false);
  }, [request]);

  const openAlbum = (album) => {
    setView('album');
    loadAlbum(album.id, album.name, album.image, album.release_date ? album.release_date.slice(0, 4) : '');
  };

  const back = () => {
    if (directAlbumMode) { onClose(); return; }
    setView('overview');
    setAlbumDetail(null);
  };

  const closeBtnAction = view === 'album' && !directAlbumMode ? back : onClose;

  const trackActions = (track) => [
    <Tooltip title="Add to queue" key="add">
      <Button shape="circle" type="primary" icon={<PlayCircleOutlined />} onClick={() => onAdd(track)} />
    </Tooltip>,
  ];

  const modalTitle = view === 'album'
    ? (
      <span>
        {!directAlbumMode && (
          <Button type="text" icon={<LeftOutlined />} onClick={back} style={{ marginRight: 4, paddingInline: 4 }} />
        )}
        {albumDetail?.name}
      </span>
    )
    : (!directAlbumMode ? request?.name : '');

  return (
    <Modal
      open={!!request}
      onCancel={closeBtnAction}
      footer={null}
      width={720}
      title={modalTitle}
      destroyOnClose
      className="artist-modal-content"
    >
      {!directAlbumMode && view === 'overview' && (
        <div className="artist-modal-header">
          <div className="artist-modal-hero">
            {request?.image
              ? <Avatar size={72} src={request.image} />
              : <Avatar size={72}>🎤</Avatar>}
          </div>
        </div>
      )}

      {view === 'overview' && (
        <div id="artistOverviewView" className="artist-view-enter">
          <div id="artistTopTracksSection">
            <h4 className="artist-modal-section-title">Popular Tracks</h4>
            {topTracks === null && <SkeletonRows count={5} />}
            {topTracks && topTracks.length === 0 && <Empty description="No clean tracks found." />}
            {topTracks && topTracks.length > 0 && (
              <List
                dataSource={topTracks}
                renderItem={(track, idx) => (
                  <List.Item
                    key={track.uri}
                    actions={trackActions(track)}
                    className="artist-track-row-enter"
                    style={{ animationDelay: `${Math.min(idx, 10) * 0.025}s` }}
                  >
                    <List.Item.Meta
                      avatar={(
                        <>
                          <span className="artist-track-num">{idx + 1}</span>
                          <Avatar shape="square" size={44} src={track.album?.image || undefined} />
                        </>
                      )}
                      title={<span title={track.name}>{track.name}</span>}
                    />
                    <div className="artist-track-duration">{formatDuration(track.duration_ms)}</div>
                  </List.Item>
                )}
              />
            )}
          </div>
          <div id="artistAlbumsSection">
            <h4 className="artist-modal-section-title">Albums &amp; Singles</h4>
            <div id="artistAlbumGrid" className="artist-album-grid">
              {albums === null && Array.from({ length: 6 }).map((_, i) => (
                <Card key={i} loading style={{ width: '100%' }} />
              ))}
              {albums && albums.length === 0 && <Empty description="No albums available." />}
              {albums && albums.map((album, idx) => {
                const year = album.release_date ? album.release_date.slice(0, 4) : '';
                return (
                  <Card
                    key={album.id}
                    hoverable
                    className="artist-album-card-enter"
                    style={{ animationDelay: `${Math.min(idx, 10) * 0.03}s` }}
                    cover={album.image ? <img src={album.image} alt={album.name} /> : <div className="artist-album-cover--placeholder" />}
                    onClick={() => openAlbum(album)}
                    size="small"
                  >
                    <Card.Meta title={album.name} description={`${album.album_type}${year ? ` · ${year}` : ''}`} />
                  </Card>
                );
              })}
              {albumsHasMore && (
                <Button loading={albumsLoadingMore} onClick={() => loadAlbums(request.id, albumsOffset, true)}>
                  Load More
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {view === 'album' && albumDetail && (
        <div id="albumDetailView" className="artist-view-enter">
          <div className="album-detail-header">
            <div className="album-detail-hero">
              {albumDetail.image
                ? <Avatar shape="square" size={80} src={albumDetail.image} />
                : <Avatar shape="square" size={80} />}
              <div className="album-detail-info">
                {albumDetail.tracks?.[0]?.artist && <div className="album-detail-artist">{albumDetail.tracks[0].artist}</div>}
                {albumDetail.year && <div className="album-detail-year">{albumDetail.year}</div>}
              </div>
            </div>
            <hr className="album-detail-divider" />
          </div>
          <div className="album-detail-tracks-wrap">
            <div id="albumDetailTracksList">
              {albumDetail.tracks === null && <SkeletonRows count={6} />}
              {albumDetail.error && <Empty description={albumDetail.error} />}
              {albumDetail.tracks && albumDetail.tracks.length === 0 && !albumDetail.error && (
                <Empty description="No clean tracks found in this album." />
              )}
              {albumDetail.tracks && albumDetail.tracks.length > 0 && (
                <List
                  dataSource={albumDetail.tracks}
                  renderItem={(track, idx) => (
                    <List.Item
                      key={track.uri}
                      actions={trackActions(track)}
                      className="artist-track-row-enter"
                      style={{ animationDelay: `${Math.min(idx, 10) * 0.025}s` }}
                    >
                      <List.Item.Meta
                        avatar={<span className="artist-track-num">{idx + 1}</span>}
                        title={<span title={track.name}>{track.name}</span>}
                      />
                      <div className="artist-track-duration">{formatDuration(track.duration_ms)}</div>
                    </List.Item>
                  )}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
