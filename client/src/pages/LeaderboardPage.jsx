import React, { useEffect, useState } from 'react';
import { Table, Modal, Button, Tag, Typography, Alert, Skeleton } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { fetchCached } from '../bootPrefetch.js';

const { Title, Paragraph, Text } = Typography;

const BASE_SONG_COST = 50;
const DISCOUNTS = [
  { place: '1st', pogs: 10 },
  { place: '2nd', pogs: 5 },
  { place: '3rd', pogs: 3 },
];

const RANK_COLOR = { 1: '#FFD700', 2: '#C0C0C0', 3: '#CD7F32' };

function LeaderboardInfoModal({ open, onClose }) {
  return (
    <Modal open={open} onCancel={onClose} footer={null} title="How the Leaderboard Works" destroyOnClose className="leaderboard-info-content">
      <div className="leaderboard-info-body">
        <Paragraph>
          The leaderboard tracks a <strong>rolling 7-day window</strong>, it updates continuously
          as new plays roll in and old ones fall off. Rankings are based on total
          songs played within that window.
        </Paragraph>
        <Paragraph>The top 3 users on the leaderboard get a discount on the standard song queue price ({BASE_SONG_COST} Digipogs):</Paragraph>
        <ul className="leaderboard-info-list">
          {DISCOUNTS.map((d) => (
            <li key={d.place}>
              <span className="leaderboard-info-place">{d.place}</span>
              <span className="leaderboard-info-pct">{Math.round((d.pogs / BASE_SONG_COST) * 100)}% off</span>
              <span className="leaderboard-info-pogs">-{d.pogs} Digipogs off the normal price</span>
            </li>
          ))}
        </ul>
        <Text type="secondary" className="leaderboard-info-note">
          The discount only applies to regularly queueing a song it doesn't
          apply to skips, ban votes, skip shields, or playlist actions.
        </Text>
      </div>
    </Modal>
  );
}

export function LeaderboardPage() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await fetchCached('/api/leaderboard');
        if (!cancelled) setRows(data.leaderboard || []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    load();
    const id = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const dataSource = (rows || []).map((user, i) => ({ ...user, rank: i + 1, key: i }));

  const columns = [
    {
      title: 'Rank',
      dataIndex: 'rank',
      key: 'rank',
      width: 90,
      render: (rank) => (
        <span style={{ fontWeight: 700, fontSize: '1.1em', color: RANK_COLOR[rank] || undefined }}>#{rank}</span>
      ),
    },
    {
      title: 'Name',
      dataIndex: 'displayName',
      key: 'name',
      render: (name, user) => (
        <span>
          {name}
          {/* ignore this */}
          {!!user.isBanned && <Tag color="error" style={{ marginLeft: 8 }}>BANNED LOL</Tag>}
        </span>
      ),
    },
    {
      title: 'Plays',
      dataIndex: 'songsPlayed',
      key: 'plays',
      align: 'right',
      render: (v) => (v === 1 ? '1 play' : `${v} plays`),
    },
  ];

  return (
    <div className="main-content">
      <Button
        className="leaderboard-info-button"
        shape="circle"
        icon={<InfoCircleOutlined />}
        title="How the leaderboard works"
        aria-label="How the leaderboard works"
        onClick={() => setInfoOpen(true)}
      />
      <Title level={1} className="leaderboard-title">Weekly Leaderboard</Title>
      <div className="leaderboard-container">
        {error && <Alert type="error" message={error} showIcon />}
        {!error && rows === null && <Skeleton active paragraph={{ rows: 6 }} />}
        {!error && rows && (
          <Table
            rowKey="key"
            columns={columns}
            dataSource={dataSource}
            pagination={false}
            rowClassName={(row) => (row.rank <= 3 ? `leaderboard-rank-${row.rank}` : '')}
          />
        )}
      </div>

      <LeaderboardInfoModal open={infoOpen} onClose={() => setInfoOpen(false)} />
    </div>
  );
}
