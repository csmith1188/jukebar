import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { PaymentModal } from '../../components/PaymentModal.jsx';

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function coverOf(item) {
  return item?.album?.image || item?.image || null;
}

export function NowPlayingBar({ session, queueState, onVoteBan, showToast }) {
  const { currentTrack, isPlaying, progress, lastUpdate } = queueState;
  const [elapsed, setElapsed] = useState(progress || 0);
  const [payment, setPayment] = useState(null);

  useEffect(() => {
    setElapsed(progress || 0);
    if (!isPlaying) return;
    const start = Date.now();
    const id = setInterval(() => setElapsed((progress || 0) + (Date.now() - start)), 200);
    return () => clearInterval(id);
  }, [progress, lastUpdate, isPlaying]);

  const doSkip = async () => {
    try {
      const data = await api.post('/skip', { uri: currentTrack?.uri });
      if (data.shieldBlocked) showToast(data.message || `Skip blocked — ${data.remaining} shield(s) remaining`, 'error');
      else if (data.ok !== false) showToast('Track skipped');
      else showToast(data.error || 'Failed to skip', 'error');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const requestSkip = () => {
    if (session?.isOwner) { doSkip(); return; }
    setPayment({ pendingAction: 'skip', onSuccess: doSkip });
  };

  const doPurchaseShield = async (quantity) => {
    try {
      const data = await api.post('/purchaseShield', { trackUri: currentTrack?.uri, addedAt: currentTrack?.addedAt || 0, quantity });
      if (data.ok !== false) showToast(`Added ${quantity} skip shield${quantity > 1 ? 's' : ''}`);
      else showToast(data.error || 'Failed to purchase shield', 'error');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const requestShield = () => {
    if (!currentTrack) return;
    if (session?.isOwner) { doPurchaseShield(1); return; }
    setPayment({ pendingAction: 'Skip Shield', onSuccess: ({ quantity }) => doPurchaseShield(quantity || 1) });
  };

  const requestBan = () => {
    if (!currentTrack) return;
    onVoteBan(currentTrack);
  };

  const cover = coverOf(currentTrack);
  const duration = currentTrack?.duration ?? currentTrack?.duration_ms ?? 0;
  const pct = duration ? Math.min(100, (elapsed / duration) * 100) : 0;
  const shields = currentTrack?.skipShields || 0;

  return (
    <footer className="player-bottom-bar" aria-label="Now playing">
      <div id="songStats" className="player-nowplaying">
        <div className="player-nowplaying-left">
          <div id="currentlyPlaying">
            {currentTrack ? (
              <div className="current-item">
                {cover ? <img src={cover} alt={currentTrack.name} className="album-cover-small" /> : <div className="album-cover-small" style={{ background: '#282828' }} />}
                <div className="current-item-content">
                  <div className="current-item-title">{currentTrack.name}</div>
                  <div className="current-item-artist">{currentTrack.artist}</div>
                  <div className="progress-container">
                    <div className="progress-bar">
                      <div className="progress-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="progress-time"><span>{fmt(elapsed)}</span><span>{fmt(duration)}</span></div>
                  </div>
                </div>
              </div>
            ) : (
              <p style={{ color: '#b3b3b3' }}>Nothing playing right now.</p>
            )}
          </div>
        </div>

        <div className="player-nowplaying-center">
          <div className="player-controls" aria-label="Playback controls">
            <button
              className="player-control-btn player-control-btn--action" type="button"
              aria-label="Vote Ban" title="Vote Ban" disabled={!currentTrack} onClick={requestBan}
            >
              <img src="/img/ban.png" alt="Ban" className="player-control-icon" />
            </button>
            <button
              className="player-control-btn player-control-btn--primary" type="button"
              aria-label="Skip" title="Skip" disabled={!currentTrack} onClick={requestSkip}
            >
              {shields > 0 && <div id="skip-button-showie-shield">{shields}</div>}
              <img src="/img/skip.png" alt="Skip" className="player-control-icon player-control-icon--skip" />
            </button>
            <button
              className="player-control-btn player-control-btn--action" type="button"
              aria-label="Skip Shield" title="Skip Shield" disabled={!currentTrack} onClick={requestShield}
            >
              <img src="/img/skipShield.png" alt="Skip Shield" className="player-control-icon" />
            </button>
          </div>
        </div>

        {/* dont touch the {} around this comment leave them empty */}
        <div className="player-nowplaying-right" />
      </div>
      <PaymentModal request={payment} onClose={() => setPayment(null)} />
    </footer>
  );
}
