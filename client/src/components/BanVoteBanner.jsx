// this is the banner that shows up when a ban vote is started (i know very helpful comment)
import React, { useState } from 'react';
import { Card, Button, Statistic, Space, Tag } from 'antd';
import { MinusOutlined, PlusOutlined } from '@ant-design/icons';

const { Countdown } = Statistic;

export function BanVoteBanner({ vote, onVote }) {
  const [minimized, setMinimized] = useState(false);

  if (!vote) return null;

  return (
    <Card
      className={`ban-vote-modal ${minimized ? 'minimized' : ''}`}
      size="small"
      title={vote.status || 'Ban vote in progress...'}
      extra={(
        <Button
          type="text" size="small" style={{ color: '#000' }}
          icon={minimized ? <PlusOutlined /> : <MinusOutlined />}
          title="Minimize/Maximize"
          onClick={() => setMinimized((m) => !m)}
        />
      )}
    >
      {!minimized && (
        <div className="ban-vote-content">
          <h3>{vote.trackName ? `Ban "${vote.trackName}" by ${vote.trackArtist}?` : 'Ban vote'}</h3>
          <Space wrap style={{ marginBottom: 12 }}>
            <Tag>Yes: <strong>{vote.yesVotes ?? 0}</strong></Tag>
            <Tag>No: <strong>{vote.noVotes ?? 0}</strong></Tag>
            <Tag>Online: <strong>{vote.onlineCount ?? vote.totalOnline ?? 0}</strong></Tag>
          </Space>
          <Space style={{ marginBottom: 12 }}>
            <Button type="primary" onClick={() => onVote('yes')}>Vote Yes</Button>
            <Button danger onClick={() => onVote('no')}>Vote No</Button>
          </Space>
          {vote.expiresAt && <Countdown value={vote.expiresAt} format="s[s remaining]" valueStyle={{ fontSize: '0.9em', color: '#b3b3b3' }} />}
        </div>
      )}
    </Card>
  );
}
