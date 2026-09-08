import React, { useEffect, useRef, useState } from 'react';
const LAST_SEEN_KEY = 'changelog_last_seen';

export function ChangelogModal({ changelog, changelogLatestKey }) {
  const entries = Array.isArray(changelog) ? changelog : [];
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0); // 0 is the newest entry
  const openedForKey = useRef(null);

  useEffect(() => {
    if (!changelogLatestKey || openedForKey.current === changelogLatestKey) return;
    openedForKey.current = changelogLatestKey;
    try {
      if (window.localStorage.getItem(LAST_SEEN_KEY) !== changelogLatestKey) {
        setOpen(true);
      }
    } catch {
      // private mode aka quota just wont auto open
    }
  }, [changelogLatestKey]);

  const markSeen = () => {
    if (!changelogLatestKey) return;
    try {
      window.localStorage.setItem(LAST_SEEN_KEY, changelogLatestKey);
    } catch {
      // ignore
    }
  };

  const close = () => {
    setOpen(false);
    markSeen();
  };
  const goOlder = () => setIndex((i) => Math.min(entries.length - 1, i + 1));
  const goNewer = () => setIndex((i) => Math.max(0, i - 1));

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === 'ArrowLeft') goNewer();
      if (e.key === 'ArrowRight') goOlder();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, entries.length]);

  return (
    <>
      <button id="changelog-button" className="changelog-button" title="View Changelog" onClick={() => setOpen(true)}>
        <img src="/img/changelog.png" alt="Changelog" />
      </button>

      <div
        id="changelogModal"
        className="changelog-modal"
        style={{ display: open ? 'flex' : 'none' }}
        onClick={(e) => e.target === e.currentTarget && close()}
      >
        <div className="changelog-content">
          <button id="close-changelog" className="close-changelog" onClick={close}>&times;</button>
          <div className="changelog-container">
            <header className="changelog-header">
              <h1>Jukebar Changelog</h1>
              <p>Track all the latest updates, fixes, and improvements</p>
              {entries.length > 0 && (
                <div className="changelog-nav">
                  <button
                    className="changelog-nav-btn"
                    aria-label="Previous version"
                    disabled={index === entries.length - 1}
                    onClick={goOlder}
                  >
                    ← Prev
                  </button>
                  <span className="changelog-version-display">{entries.length - index} / {entries.length}</span>
                  <button
                    className="changelog-nav-btn"
                    aria-label="Next version"
                    disabled={index === 0}
                    onClick={goNewer}
                  >
                    Next →
                  </button>
                </div>
              )}
            </header>

            {entries.length === 0 && (
              <p style={{ padding: 20, textAlign: 'center', color: '#b3b3b3' }}>No changelog entries found.</p>
            )}

            {entries.map((entry, idx) => (
              <section className={`version-block${idx === index ? ' active' : ''}`} key={`${entry.version}-${idx}`}>
                <div className="version-header">
                  <h2>{entry.version}</h2>
                  <span className="release-date">{entry.releaseDate}</span>
                </div>
                <div className="changes">
                  <h3>What&apos;s new?</h3>
                  <ul>
                    {Array.isArray(entry.changes) && entry.changes.map((change, cidx) => (
                      <li key={cidx} dangerouslySetInnerHTML={{ __html: change.text }} />
                    ))}
                  </ul>
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
