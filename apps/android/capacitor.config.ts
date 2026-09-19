import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'cn.ayan.relay',
  appName: 'Relay',
  webDir: '../../dist/web',
  android: {
    allowMixedContent: false,
    loggingBehavior: 'none'
  }
};

export default config;
