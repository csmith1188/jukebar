import React, { useState } from 'react';
import { List, Avatar, Empty, Dropdown, Badge, Tooltip } from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import { api } from '../../api.js';
import { PaymentModal } from '../../components/PaymentModal.jsx';

function coverOf(item) {
  return item?.album?.image || item?.image || null;
}

export function QueueRail({ queue, session, showToast, onVoteBan }) {
  const [payment, setPayment] = useState(null);

  const doPurchaseShield = async (track, quantity) => {
    try {
      const data = await api.post('/purchaseShield', { trackUri: track.uri, addedAt: track.addedAt || 0, quantity });
      if (data.ok !== false) showToast(`Added ${quantity} skip shield${quantity > 1 ? 's' : ''}`);
      else showToast(data.error || 'Failed to purchase shield', 'error');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const requestShield = (track) => {
    if (session?.isOwner) { doPurchaseShield(track, 1); return; }
    setPayment({ pendingAction: 'Skip Shield', onSuccess: ({ quantity }) => doPurchaseShield(track, quantity || 1) });
  };

  const requestBan = (track) => {
    onVoteBan?.(track);
  };

  const menuItemsFor = (item) => [
    { key: 'shield', label: 'Skip Shield', icon: <img src="/img/skipShield.png" alt="" width={16} height={16} />, onClick: () => requestShield(item) },
    { key: 'ban', label: 'Vote Ban', danger: true, icon: <img src="/img/ban.png" alt="" width={16} height={16} />, onClick: () => requestBan(item) },
  ];

  return (
    <aside className="player-right-rail" aria-label="Queue">
      <div className="player-rail-title">Queue</div>
      <hr className="player-rail-divider" />
      <div className="player-rail-queue">
        {(!queue || queue.length === 0) ? (
          <Empty description="Nothing queued yet, search to add a song." image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <List
            itemLayout="horizontal"
            dataSource={queue}
            renderItem={(item, i) => {
              const cover = coverOf(item);
              const shieldCount = item.skipShields || 0;
              const avatar = <Avatar shape="square" size={44} src={cover || undefined}>{!cover && '♪'}</Avatar>;
              return (
                <List.Item key={`${item.uri}-${item.addedAt || i}`} className={`queue-item${shieldCount > 0 ? ' queue-item--shielded' : ''}`}>
                  <List.Item.Meta
                    avatar={shieldCount > 0 ? (
                      <Tooltip title={(
                        <span><img src="/img/skipShield.png" alt="" className="queue-item-shield-badge-icon" /> {shieldCount} skip shield{shieldCount > 1 ? 's' : ''} active</span>
                      )}>
                        <Badge count={shieldCount} color="gold" size="small" offset={[-2, 2]}>
                          {avatar}
                        </Badge>
                      </Tooltip>
                    ) : avatar}
                    title={<span className="queue-item-title" title={item.name}>{item.name}</span>}
                    description={(
                      <>
                        <div className="queue-item-artist" title={item.artist}>{item.artist}</div>
                        <div className="queue-item-added-by">Added by {item.isAnon ? 'Anonymous' : (item.addedBy || 'Spotify')}</div>
                      </>
                    )}
                  />
                  <div className="queue-item-actions">
                    <Dropdown menu={{ items: menuItemsFor(item) }} trigger={['click']} placement="bottomRight">
                      <button type="button" className="ellipsis-button" title="More options" onClick={(e) => e.stopPropagation()}>
                        <MoreOutlined />
                      </button>
                    </Dropdown>
                  </div>
                </List.Item>
              );
            }}
          />
        )}
      </div>
      <PaymentModal request={payment} onClose={() => setPayment(null)} />
    </aside>
  );
}
