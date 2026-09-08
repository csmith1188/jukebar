import React from 'react';
import { Spin } from 'antd';

export function Spinner({ label = 'Loading…', size = 'md' }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: size === 'sm' ? '10px 0' : '18px 0' }}
    >
      <Spin size={size === 'sm' ? 'small' : 'medium'} />
      {label && <span style={{ color: '#b3b3b3' }}>{label}</span>}
    </div>
  );
}
