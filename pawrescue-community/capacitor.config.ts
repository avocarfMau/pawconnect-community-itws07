/// <reference types="@capacitor/push-notifications" />
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.ionic.starter',
  appName: 'pawrescue-community',
  webDir: 'www',

  // Display incoming push notifications when the app is in the foreground.
  // Android uses 'alert' to show a notification; 'sound' enables its sound.
  // 'badge' applies to supported platforms (primarily iOS).
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
