import React, { useEffect, useMemo, useRef, useState } from 'react';

const LETTERS = 'JUKEBAR'.split('');

const TIPS = [
  `I'm up juking my bar`,
  'Stream Brodying it 3!',
  'Now in React.js!',
  'Jubekar!',
  "Go play space elves on jetbikes",
  'Shapes that go!',
  `I'm the Jukeboy! I'm the Jukeboy! I'm the Jukeboy! I'm the Jukeboy!`,
];

// fancy loading screen!
// and yes it is entirely useless for the most part it loads within like 2 seconds but i wanted a loading screen so here it is
export function BootScreen({ ready, minMs = 5000, maxMs = 10000, onDone }) {
  const [progress, setProgress] = useState(0);
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * TIPS.length));
  const [fading, setFading] = useState(false);
  const startRef = useRef(null);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  if (startRef.current === null) startRef.current = Date.now();

  useEffect(() => {
    document.fonts?.load("400 4em 'miners'")?.catch(() => {});
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (doneRef.current) return;
      const elapsed = Date.now() - startRef.current;
      const effectiveDuration = ready ? Math.min(minMs, maxMs) : maxMs;
      const pct = Math.min(100, (elapsed / effectiveDuration) * 100);
      setProgress(pct);

      const canFinish = elapsed >= effectiveDuration;
      if (canFinish) {
        doneRef.current = true;
        setProgress(100);
        setFading(true);
        setTimeout(() => onDoneRef.current?.(), 420);
      }
    }, 80);
    return () => clearInterval(id);
  }, [ready, minMs, maxMs]);

  useEffect(() => {
    const id = setInterval(() => setTipIndex((i) => (i + 1) % TIPS.length), 3500);
    return () => clearInterval(id);
  }, []);

  // lil progress bar for the loading screen
  const fillStyle = useMemo(() => ({ clipPath: `inset(0 ${100 - progress}% 0 0)` }), [progress]);

  return (
    <div className={`boot-screen${fading ? ' boot-screen--fading' : ''}`}>
      <div className="boot-logo-wrap">
        <div className="boot-logo boot-logo--base" aria-hidden="true">
          {LETTERS.map((ch, i) => (
            <span className="boot-letter" style={{ animationDelay: `${i * 0.09}s` }} key={`base-${i}`}>{ch}</span>
          ))}
        </div>
        <div className="boot-logo boot-logo--fill" style={fillStyle} aria-hidden="true">
          {LETTERS.map((ch, i) => (
            <span className="boot-letter" style={{ animationDelay: `${i * 0.09}s` }} key={`fill-${i}`}>{ch}</span>
          ))}
        </div>
        <span className="boot-logo-sr">Jukebar</span>
      </div>

      <p className="boot-status">Initializing Spotify...</p>
      <p className="boot-tip" key={tipIndex}>{TIPS[tipIndex]}</p>
    </div>
  );
}
