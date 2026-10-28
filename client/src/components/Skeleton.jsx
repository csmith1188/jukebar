import React from 'react';
import { Skeleton } from 'antd';

export function SkeletonRows({ count = 4 }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ padding: '8px 10px' }}>
          <Skeleton active avatar={{ shape: 'square', size: 44 }} paragraph={{ rows: 1, width: '45%' }} title={{ width: '60%' }} />
        </div>
      ))}
    </div>
  );
}
