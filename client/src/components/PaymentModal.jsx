import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, InputNumber, Switch, Button, Alert, Typography, Tag, Space } from 'antd';
import { api } from '../api.js';

const { Text } = Typography;

const REASON_BY_ACTION = {
  play: 'Jukebar Payment - Play Track',
  skip: 'Jukebar Payment - Skip Track',
  'Skip Shield': 'Jukebar Payment - Purchase Skip Shield',
  'Ban Vote': 'Jukebar Payment - Initiate Ban Vote',
  createPlaylist: 'Jukebar Payment - Create Playlist',
  addPlaylistSong: 'Jukebar Payment - Add Song to Playlist',
  removePlaylistSong: 'Jukebar Payment - Remove Song from Playlist',
  customPlaylistPlay: 'Jukebar Payment - Play Custom Playlist',
};

export function PaymentModal({ request, onClose }) {
  const [pin, setPin] = useState('');
  const [savePin, setSavePin] = useState(false);
  const [anonMode, setAnonMode] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [amount, setAmount] = useState(null);
  const [discountApplied, setDiscountApplied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const pendingAction = request?.pendingAction;
  const isShield = pendingAction === 'Skip Shield';

  useEffect(() => {
    if (!request) return;
    setPin('');
    setError(null);
    setQuantity(1);
    api.post('/getPin').then((d) => {
      if (d.userPin) { setPin(d.userPin); setSavePin(true); }
    }).catch(() => { });
    api.post('/getAmount', {
      pendingAction,
      playlistId: request.playlistId || null,
      ...(request.songCount != null ? { songCount: request.songCount } : {}),
    }).then((d) => {
      setAmount(d.amount);
      setDiscountApplied(!!d.discountApplied);
    }).catch(() => setAmount(null));
  }, [request]);

  const displayAmount = isShield && amount != null ? amount * quantity : amount;

  const submit = async () => {
    if (!pin) { setError('Please enter your PIN.'); return; }
    setBusy(true);
    setError(null);
    try {
      if (savePin) await api.post('/savePin', { pin }).catch(() => { });
      const body = { pin, reason: REASON_BY_ACTION[pendingAction] || 'Jukebar Payment', pendingAction };
      if (request.playlistId) body.playlistId = request.playlistId;
      if (request.songCount != null) body.songCount = request.songCount;
      const result = await api.post('/transfer', body);
      if (result.ok) {
        onClose();
        request.onSuccess?.({ anonMode, quantity });
      } else {
        setError(result.error || 'Transfer failed');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!request} onCancel={onClose} footer={null} title="Transfer" destroyOnClose>
      <div className="row price-display" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <Text>
          Purchase Cost: <strong>{displayAmount == null ? '…' : `${displayAmount} Digipogs`}</strong>
        </Text>
        {discountApplied && <Tag color="gold">Leaderboard discount applied!</Tag>}
      </div>

      <Form layout="vertical" onFinish={submit}>
        {isShield && (
          <Form.Item label="How many shields? (max 1000)">
            <InputNumber
              min={1} max={1000} value={quantity} style={{ width: '100%' }}
              onChange={(v) => setQuantity(Math.max(1, Math.min(1000, v || 1)))}
            />
          </Form.Item>
        )}

        <Form.Item label="PIN">
          <Input.Password
            maxLength={6} inputMode="numeric" placeholder="Input your PIN" value={pin}
            onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </Form.Item>

        <Form.Item>
          <Space align="start">
            <Switch checked={savePin} onChange={setSavePin} />
            <div>
              <div>Save PIN for next purchase</div>
              <Text type="secondary" style={{ fontSize: '0.8em' }}>Changing your PIN will require re-entry for future transactions.</Text>
            </div>
          </Space>
        </Form.Item>

        {pendingAction === 'play' && (
          <Form.Item>
            <Space align="start">
              <Switch checked={anonMode} onChange={setAnonMode} />
              <div>
                <div>Anonymous Mode</div>
                <Text type="secondary" style={{ fontSize: '0.8em' }}>
                  Hides your name from the public queue display. Teachers can still view who added the song, and it
                  will appear in your transaction history.
                </Text>
              </div>
            </Space>
          </Form.Item>
        )}

        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

        <Button type="primary" htmlType="submit" loading={busy} block>Send Transfer</Button>
      </Form>
    </Modal>
  );
}
