import { useCallback } from 'react';
import { App as AntdApp } from 'antd';

export function useAppMessage() {
  const { message } = AntdApp.useApp();

  const showToast = useCallback((text, type = 'success') => {
    const kind = type === 'error' ? 'error' : type === 'info' ? 'info' : 'success';
    message[kind](text);
  }, [message]);

  return { showToast, message };
}
