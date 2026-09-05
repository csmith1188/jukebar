import { theme } from 'antd';

export const jukebarTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#1db954',
    colorPrimaryActive: '#09702d',
    colorPrimaryHover: '#1ed760',
    colorBgLayout: '#121212',
    colorBgBase: '#121212',
    colorBgContainer: '#181818',
    colorBgElevated: '#212121',
    colorBorder: '#535353',
    colorBorderSecondary: 'rgba(255, 255, 255, 0.08)',
    colorText: '#ffffff',
    colorTextSecondary: '#b3b3b3',
    colorError: '#ff4444',
    colorLink: '#1db954',
    colorLinkHover: '#1ed760',
    fontFamily: "'Outfit', sans-serif",
    borderRadius: 8,
    borderRadiusLG: 12,
    wireframe: false,
  },
  components: {
    Modal: {
      contentBg: '#181818',
      headerBg: '#181818',
      titleColor: '#ffffff',
    },
    Tabs: {
      itemSelectedColor: '#1db954',
      itemActiveColor: '#1db954',
      itemHoverColor: '#1ed760',
      inkBarColor: '#1db954',
    },
    Table: {
      headerBg: '#181818',
      headerColor: '#b3b3b3',
      rowHoverBg: 'rgba(255, 255, 255, 0.06)',
      colorBgContainer: '#181818',
    },
    Card: {
      colorBgContainer: '#181818',
    },
    Progress: {
      defaultColor: '#1db954',
    },
  },
};
