import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.chatterang.inference',
  appName: 'Chatterang',
  webDir: 'dist',
  // Inference is CPU/GPU-bound and long-running; keep the webview alive.
  ios: {
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: true,
    backgroundColor: '#17120F',
  },
  android: {
    backgroundColor: '#17120F',
    // Large model files are streamed to app-private storage, never to
    // shared media directories.
    allowMixedContent: false,
  },
  plugins: {
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true,
    },
    StatusBar: {
      overlaysWebView: true,
      style: 'DARK',
    },
  },
};

export default config;
