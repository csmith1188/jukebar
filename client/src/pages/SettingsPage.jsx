import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  App as AntdApp, Form, ColorPicker, Slider, Select, Input, Table, Modal, Button, Popconfirm, Typography, Spin,
} from 'antd';
import { api } from '../api.js';
import { fetchCached } from '../bootPrefetch.js';
import { useAppMessage } from '../useAppMessage.js';

const { Title, Paragraph, Text } = Typography;

const BLANK_DEFAULTS = {
  text_color: '#ffffff',
  bg_color: '#000000',
  progress_fg1: '#00ff00',
  progress_fg2: '#29ff29',
  scroll_speed: 50,
  skip_sound: '',
  shield_sound: '',
};

const BLANK_OVERRIDE = {
  id: null,
  match_type: 'artist',
  match_value: '',
  match_artist: '',
  text_color: '#ffffff',
  progress_fg1: '#00ff00',
  progress_fg2: '#29ff29',
  scroll_speed: 50,
  skip_sound: '',
  shield_sound: '',
};

function SoundSelect({ value, sounds, onChange }) {
  return (
    <Select
      value={value || ''}
      onChange={onChange}
      style={{ width: '100%' }}
      options={[{ value: '', label: 'None' }, ...sounds.map((s) => ({ value: s, label: s }))]}
    />
  );
}

function ColorField({ label, value, onChange }) {
  return (
    <Form.Item label={label}>
      <ColorPicker value={value} onChange={(c) => onChange(c.toHexString())} showText format="hex" />
    </Form.Item>
  );
}

export function SettingsPage({ session }) {
  const canManage = (session?.userPermission ?? 0) >= 4 || session?.isOwner;

  const [defaults, setDefaults] = useState(BLANK_DEFAULTS);
  const [overrides, setOverrides] = useState([]);
  const [sounds, setSounds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [modalOverride, setModalOverride] = useState(null); // null = closed
  const { showToast } = useAppMessage();
  const { modal } = AntdApp.useApp();

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [defaultsRes, overridesRes, soundsRes] = await Promise.all([
        fetchCached('/api/settings/defaults'),
        fetchCached('/api/settings/overrides'),
        fetchCached('/api/settings/sounds'),
      ]);
      setDefaults({ ...BLANK_DEFAULTS, ...(defaultsRes.defaults || {}) });
      setOverrides(overridesRes.overrides || []);
      setSounds(soundsRes.sounds || []);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canManage) loadAll();
    else setLoading(false);
  }, [canManage, loadAll]);

  const saveDefaults = async () => {
    try {
      await api.put('/api/settings/defaults', defaults);
      showToast('Default settings saved');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const resetDefaults = () => {
    modal.confirm({
      title: 'Reset JukePix defaults?',
      content: 'Reset JukePix defaults back to their original values?',
      okText: 'Reset',
      onOk: async () => {
        try {
          await api.post('/api/settings/defaults/reset');
          showToast('Defaults reset');
          loadAll();
        } catch (err) {
          showToast(err.message, 'error');
        }
      },
    });
  };

  const saveOverride = async () => {
    const o = modalOverride;
    if (!o.match_value.trim()) {
      showToast('Match value is required', 'error');
      return;
    }
    const body = {
      match_type: o.match_type,
      match_value: o.match_value.trim(),
      match_artist: o.match_type === 'song' && o.match_artist.trim() ? o.match_artist.trim() : null,
      text_color: o.text_color,
      progress_fg1: o.progress_fg1,
      progress_fg2: o.progress_fg2,
      scroll_speed: Number(o.scroll_speed) || 50,
      skip_sound: o.skip_sound || null,
      shield_sound: o.shield_sound || null,
    };
    try {
      if (o.id) await api.put(`/api/settings/overrides/${o.id}`, body);
      else await api.post('/api/settings/overrides', body);
      showToast('Override saved');
      setModalOverride(null);
      loadAll();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const deleteOverride = async (id) => {
    try {
      await api.del(`/api/settings/overrides/${id}`);
      showToast('Override deleted');
      setOverrides((list) => list.filter((o) => o.id !== id));
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const previewStyle = useMemo(
    () => ({ background: defaults.bg_color, color: defaults.text_color }),
    [defaults.bg_color, defaults.text_color]
  );
  const previewFillStyle = useMemo(
    () => ({ background: `linear-gradient(90deg, ${defaults.progress_fg1}, ${defaults.progress_fg2})` }),
    [defaults.progress_fg1, defaults.progress_fg2]
  );

  if (!canManage) {
    return (
      <main className="main-content">
        <div className="page-error">Only teachers can view JukePix settings.</div>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="main-content">
        <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />
      </main>
    );
  }
  if (loadError) return <main className="main-content"><div className="page-error">{loadError}</div></main>;

  const swatch = (hex) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="color-swatch" style={{ background: hex }} />
      {hex}
    </span>
  );

  const columns = [
    { title: 'Type', dataIndex: 'match_type', key: 'type' },
    {
      title: 'Match Value', key: 'match',
      render: (_, o) => `${o.match_value}${o.match_artist ? ` (${o.match_artist})` : ''}`,
    },
    { title: 'Text', key: 'text', render: (_, o) => swatch(o.text_color) },
    { title: 'Bar 1', key: 'bar1', render: (_, o) => swatch(o.progress_fg1) },
    { title: 'Bar 2', key: 'bar2', render: (_, o) => swatch(o.progress_fg2) },
    { title: 'Speed', dataIndex: 'scroll_speed', key: 'speed' },
    {
      title: '', key: 'actions', align: 'right',
      render: (_, o) => (
        <div className="override-actions">
          <Button
            size="small"
            onClick={() => setModalOverride({
              id: o.id,
              match_type: o.match_type,
              match_value: o.match_value,
              match_artist: o.match_artist || '',
              text_color: o.text_color,
              progress_fg1: o.progress_fg1,
              progress_fg2: o.progress_fg2,
              scroll_speed: o.scroll_speed,
              skip_sound: o.skip_sound || '',
              shield_sound: o.shield_sound || '',
            })}
          >
            Edit
          </Button>
          <Popconfirm title="Delete this override?" okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => deleteOverride(o.id)}>
            <Button size="small" danger>Delete</Button>
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div className="settings-container">
      <Title level={2}>JukePix Settings</Title>
      <Paragraph className="subtitle">Configure display colors, progress bar, and sounds for the JukePix LED strip.</Paragraph>

      <div className="settings-section">
        <Title level={4}>Global Defaults</Title>
        <Paragraph className="priority-hint">
          These are the <strong>base settings</strong> used for every track unless overridden by an artist or song rule below.
        </Paragraph>

        <Form layout="vertical" className="form-grid">
          <ColorField label="Text Color" value={defaults.text_color} onChange={(v) => setDefaults((d) => ({ ...d, text_color: v }))} />
          <ColorField label="Background Color" value={defaults.bg_color} onChange={(v) => setDefaults((d) => ({ ...d, bg_color: v }))} />
          <ColorField label="Progress Bar Color 1" value={defaults.progress_fg1} onChange={(v) => setDefaults((d) => ({ ...d, progress_fg1: v }))} />
          <ColorField label="Progress Bar Color 2" value={defaults.progress_fg2} onChange={(v) => setDefaults((d) => ({ ...d, progress_fg2: v }))} />

          <Form.Item label={`Scroll Speed (${defaults.scroll_speed})`} className="full-width">
            <Slider min={10} max={200} value={defaults.scroll_speed} onChange={(v) => setDefaults((d) => ({ ...d, scroll_speed: v }))} />
          </Form.Item>

          <Form.Item label="Skip Sound">
            <SoundSelect value={defaults.skip_sound} sounds={sounds} onChange={(v) => setDefaults((d) => ({ ...d, skip_sound: v }))} />
          </Form.Item>
          <Form.Item label="Shield Sound">
            <SoundSelect value={defaults.shield_sound} sounds={sounds} onChange={(v) => setDefaults((d) => ({ ...d, shield_sound: v }))} />
          </Form.Item>
        </Form>

        <div style={{ marginTop: 20 }}>
          <Text style={{ fontSize: '0.85em', color: '#b3b3b3', fontWeight: 500 }}>Preview</Text>
          <div className="preview-text" style={previewStyle}>♪♫ Track Name - Artist ♪♫</div>
          <div className="preview-bar" style={{ background: defaults.bg_color }}>
            <div className="preview-bar-fill" style={previewFillStyle} />
          </div>
        </div>

        <div className="btn-row">
          <Button type="primary" onClick={saveDefaults}>Save Defaults</Button>
          <Button onClick={resetDefaults}>Reset to Defaults</Button>
        </div>
      </div>

      <div className="settings-section">
        <Title level={4}>Artist &amp; Song Overrides</Title>
        <Paragraph className="priority-hint">
          Override colors for specific artists or songs. Priority: <strong>Song</strong> &gt; <strong>Artist</strong> &gt; <strong>Global Defaults</strong>.
          <br />A song override will always take precedence over an artist override.
        </Paragraph>

        <Button type="primary" size="small" style={{ marginBottom: 12 }} onClick={() => setModalOverride({ ...BLANK_OVERRIDE })}>
          + Add Override
        </Button>

        <Table
          rowKey="id"
          columns={columns}
          dataSource={overrides}
          pagination={false}
          size="small"
          locale={{ emptyText: 'No overrides configured yet.' }}
        />
      </div>

      <Modal
        open={!!modalOverride}
        onCancel={() => setModalOverride(null)}
        footer={null}
        title={modalOverride?.id ? 'Edit Override' : 'Add Override'}
        destroyOnClose
      >
        {modalOverride && (
          <Form layout="vertical" onFinish={saveOverride}>
            <Form.Item label="Type">
              <Select
                value={modalOverride.match_type}
                disabled={!!modalOverride.id}
                onChange={(v) => setModalOverride((m) => ({ ...m, match_type: v }))}
                options={[{ value: 'artist', label: 'Artist' }, { value: 'song', label: 'Song' }]}
              />
            </Form.Item>
            <Form.Item label="Match Value">
              <Input
                placeholder="e.g. Pierce The Veil"
                value={modalOverride.match_value}
                onChange={(e) => setModalOverride((m) => ({ ...m, match_value: e.target.value }))}
              />
            </Form.Item>
            {modalOverride.match_type === 'song' && (
              <Form.Item label="Artist (optional, for song specificity)">
                <Input
                  placeholder="e.g. Joji"
                  value={modalOverride.match_artist}
                  onChange={(e) => setModalOverride((m) => ({ ...m, match_artist: e.target.value }))}
                />
              </Form.Item>
            )}
            <ColorField label="Text Color" value={modalOverride.text_color} onChange={(v) => setModalOverride((m) => ({ ...m, text_color: v }))} />
            <ColorField label="Progress Bar Color 1" value={modalOverride.progress_fg1} onChange={(v) => setModalOverride((m) => ({ ...m, progress_fg1: v }))} />
            <ColorField label="Progress Bar Color 2" value={modalOverride.progress_fg2} onChange={(v) => setModalOverride((m) => ({ ...m, progress_fg2: v }))} />
            <Form.Item label={`Scroll Speed (${modalOverride.scroll_speed})`}>
              <Slider min={10} max={200} value={modalOverride.scroll_speed} onChange={(v) => setModalOverride((m) => ({ ...m, scroll_speed: v }))} />
            </Form.Item>
            <Form.Item label="Skip Sound">
              <SoundSelect value={modalOverride.skip_sound} sounds={sounds} onChange={(v) => setModalOverride((m) => ({ ...m, skip_sound: v }))} />
            </Form.Item>
            <Form.Item label="Shield Sound">
              <SoundSelect value={modalOverride.shield_sound} sounds={sounds} onChange={(v) => setModalOverride((m) => ({ ...m, shield_sound: v }))} />
            </Form.Item>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button onClick={() => setModalOverride(null)}>Cancel</Button>
              <Button type="primary" htmlType="submit">Save</Button>
            </div>
          </Form>
        )}
      </Modal>
    </div>
  );
}
