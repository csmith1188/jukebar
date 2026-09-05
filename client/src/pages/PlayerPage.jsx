import React, { useEffect, useState } from 'react';
import { Alert } from 'antd';
import { fetchCached } from '../bootPrefetch.js';
import { socket } from '../socket.js';
import { useAppMessage } from '../useAppMessage.js';
import { PaymentModal } from '../components/PaymentModal.jsx';
import { ChangelogModal } from '../components/ChangelogModal.jsx';
import { BanVoteBanner } from '../components/BanVoteBanner.jsx';
import { PlaylistsSidebar } from './player/PlaylistsSidebar.jsx';
import { SearchPanel } from './player/SearchPanel.jsx';
import { QueueRail } from './player/QueueRail.jsx';
import { NowPlayingBar } from './player/NowPlayingBar.jsx';

export function PlayerPage({ session }) {
  const [queueState, setQueueState] = useState({ currentTrack: null, queue: [], isPlaying: false, progress: 0, lastUpdate: 0 });
  const [onlineCount, setOnlineCount] = useState(1);
  const [banVote, setBanVote] = useState(null);
  const [banVotePayment, setBanVotePayment] = useState(null);
  const [isBanned, setIsBanned] = useState(false);
  const { showToast } = useAppMessage();

  useEffect(() => {
    fetchCached('/api/me/banned').then((d) => setIsBanned(!!d.banned)).catch(() => {});
  }, []);

  useEffect(() => {
    fetchCached('/api/queue').then((data) => setQueueState((prev) => ({ ...prev, ...data }))).catch(() => {});
  }, []);

  useEffect(() => {
    socket.connect();

    const mergeQueue = (patch) => setQueueState((prev) => ({ ...prev, ...patch }));

    const onConnect = () => socket.emit('requestQueueUpdate');
    const onQueueUpdate = (data) => mergeQueue(data);
    const onCurrentTrack = (track) => mergeQueue({ currentTrack: track });
    const onPlaybackState = (data) => mergeQueue(data);
    const onQueueAdd = (data) => data.queue && mergeQueue({ queue: data.queue });
    const onUserCount = (n) => setOnlineCount(n);
    const onShieldPurchased = () => socket.emit('requestQueueUpdate');

    const onBanVoteStarted = (data) => setBanVote({ ...data, status: 'Ban vote in progress...', expiresAt: Date.now() + (data.expiresIn || 45000) });
    const onFormbarVoteStarted = (data) => setBanVote({ trackName: data.song, trackArtist: data.artist, status: 'Ban vote in progress on Formbar...', external: true });
    const onBanVoteUpdate = (data) => setBanVote((v) => (v ? { ...v, ...data } : v));
    const onBanVotePassed = (data) => { showToast(`Banned: ${data.trackName} — ${data.trackArtist || ''}`); setBanVote(null); };
    const onBanVoteFailed = (data) => { showToast(`Ban vote failed for ${data.trackName || 'track'}`, 'info'); setBanVote(null); };
    const onBanVoteError = (data) => showToast(data.error || 'Ban vote error', 'error');
    const onUserBanned = (data) => { if (String(data.userId) === String(session?.userID)) { setIsBanned(true); showToast('You have been banned from Jukebar.', 'error'); } };
    const onUserUnbanned = (data) => { if (String(data.userId) === String(session?.userID)) setIsBanned(false); };

    socket.on('connect', onConnect);
    socket.on('queueUpdate', onQueueUpdate);
    socket.on('currentTrack', onCurrentTrack);
    socket.on('playbackState', onPlaybackState);
    socket.on('queueAdd', onQueueAdd);
    socket.on('userCount', onUserCount);
    socket.on('shieldPurchased', onShieldPurchased);
    socket.on('banVoteStarted', onBanVoteStarted);
    socket.on('formbarVoteStarted', onFormbarVoteStarted);
    socket.on('banVoteUpdate', onBanVoteUpdate);
    socket.on('banVotePassed', onBanVotePassed);
    socket.on('banVoteFailed', onBanVoteFailed);
    socket.on('banVoteError', onBanVoteError);
    socket.on('userBanned', onUserBanned);
    socket.on('userUnbanned', onUserUnbanned);

    if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('queueUpdate', onQueueUpdate);
      socket.off('currentTrack', onCurrentTrack);
      socket.off('playbackState', onPlaybackState);
      socket.off('queueAdd', onQueueAdd);
      socket.off('userCount', onUserCount);
      socket.off('shieldPurchased', onShieldPurchased);
      socket.off('banVoteStarted', onBanVoteStarted);
      socket.off('formbarVoteStarted', onFormbarVoteStarted);
      socket.off('banVoteUpdate', onBanVoteUpdate);
      socket.off('banVotePassed', onBanVotePassed);
      socket.off('banVoteFailed', onBanVoteFailed);
      socket.off('banVoteError', onBanVoteError);
      socket.off('userBanned', onUserBanned);
      socket.off('userUnbanned', onUserUnbanned);
      socket.disconnect();
    };
  }, [session?.userID]);

  const startBanVote = (track, reason) => {
    socket.emit('initiateBanVote', {
      trackUri: track.uri, trackName: track.name, trackArtist: track.artist,
      initiator: session?.user, reason: reason || 'student ban', trackImage: track.album?.image || track.image || null,
    });
  };

  const requestVoteBan = (track) => {
    if (isBanned) { showToast('You have been banned from Jukebar. Contact your teacher.', 'error'); return; }
    if (banVote) { showToast('A ban vote is already in progress.', 'error'); return; }
    if (session?.isOwner) { startBanVote(track, 'owner ban'); return; }
    setBanVotePayment({ pendingAction: 'Ban Vote', onSuccess: () => startBanVote(track, 'student ban') });
  };

  const castVote = (vote) => {
    if (!banVote?.voteId) return;
    socket.emit('castBanVote', { voteId: banVote.voteId, vote });
  };

  return (
    <div className="main-content player-main-content">
      <div className="player-topbar">
        <p className="user-greeting">
          Logged in as: <strong>{session?.user}</strong>{' '}
          <span className="user-count">({onlineCount} online)</span>
        </p>
      </div>

      <div className="player-shell">
        <PlaylistsSidebar session={session} showToast={showToast} />
        <SearchPanel session={session} showToast={showToast} onVoteBan={requestVoteBan} />
        <QueueRail queue={queueState.queue} session={session} showToast={showToast} onVoteBan={requestVoteBan} />
      </div>

      <NowPlayingBar session={session} queueState={queueState} onVoteBan={requestVoteBan} showToast={showToast} />

      <BanVoteBanner vote={banVote} onVote={castVote} />
      <PaymentModal request={banVotePayment} onClose={() => setBanVotePayment(null)} />
      <ChangelogModal changelog={session?.changelog} changelogLatestKey={session?.changelogLatestKey} />

      {isBanned && (
        <Alert
          className="player-banned-banner"
          type="error"
          banner
          message="You have been banned from Jukebar. ROFL COULD NEVER BE ME AHAHAHAHAHAH"
        />
      )}
    </div>
  );
}
