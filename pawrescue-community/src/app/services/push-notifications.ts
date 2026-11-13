import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import {
  PushNotifications,
  type ActionPerformed,
  type PushNotificationSchema,
  type Token
} from '@capacitor/push-notifications';
import { BehaviorSubject, Subject, firstValueFrom } from 'rxjs';
import { getApiBaseUrl } from '../config/ip-config';

interface SaveDeviceTokenResponse {
  success: boolean;
  message: string;
  registered: boolean;
  platform: string;
}

interface DeactivateDeviceTokenResponse {
  success: boolean;
  message: string;
  deactivated: boolean;
}

type TokenSaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * PawConnect - Capacitor/FCM registration and token storage.
 *
 * AppComponent calls registerForPush() after authenticated navigation.
 * The native registration event supplies the FCM token to this service,
 * which uploads it to the authenticated PHP API.
 *
 * Diagnostics deliberately log only safe STATE information, NEVER Firebase
 * tokens, resident auth tokens, service-account credentials or message data.
 */
@Injectable({ providedIn: 'root' })
export class PushNotificationService {
  private readonly http = inject(HttpClient);

  // Shared XAMPP backend address used by PawConnect services.
  private readonly apiBaseUrl = getApiBaseUrl();
  private readonly saveDeviceTokenUrl =
    `${this.apiBaseUrl}/push_notifications/save_device_token.php`;
  private readonly deactivateDeviceTokenUrl =
    `${this.apiBaseUrl}/push_notifications/deactivate_device_token.php`;

  private readonly tokenSubject = new BehaviorSubject<string | null>(null);
  readonly token$ = this.tokenSubject.asObservable();

  private readonly receivedSubject = new Subject<PushNotificationSchema>();
  readonly received$ = this.receivedSubject.asObservable();

  private readonly openedSubject = new Subject<ActionPerformed>();
  readonly opened$ = this.openedSubject.asObservable();

  private readonly errorSubject = new Subject<string>();
  readonly errors$ = this.errorSubject.asObservable();

  private readonly tokenSaveStatusSubject =
    new BehaviorSubject<TokenSaveStatus>('idle');
  readonly tokenSaveStatus$ = this.tokenSaveStatusSubject.asObservable();

  private listenersReady: Promise<void> | null = null;
  private readonly listenerHandles: PluginListenerHandle[] = [];

  // AppComponent invokes registerForPush() only after a residentGuard-protected
  // route succeeds. Bind that registration to the current session so that a
  // delayed Firebase callback cannot attach the token to a staff account.
  // Never persist this marker or treat it as a substitute for PHP authorization.
  private residentRegistrationSession: string | null = null;

  // Deduplicate successful token uploads within the current app process.
  private lastSavedFor: { session: string; deviceToken: string } | null = null;
  private activeUpload: Promise<boolean> | null = null;

  // Maintain logout ordering: finish uploads before token deactivation.
  private logoutSession: string | null = null;
  private activeDeactivation: Promise<boolean> | null = null;

  private logStatus(message: string): void {
    console.info(`[PawConnect Push] ${message}`);
  }

  private logWarning(message: string): void {
    console.warn(`[PawConnect Push] ${message}`);
  }

  // Avoid injecting AuthService here (it would create a dependency cycle).
  // If AuthService changes its storage key, update this method too.
  private getSessionToken(): string | null {
    return sessionStorage.getItem('pawrescue_token');
  }

  isSupported(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  }

  private async ensureListeners(): Promise<void> {
    if (this.listenersReady) {
      return this.listenersReady;
    }

    this.listenersReady = this.installListeners();
    try {
      await this.listenersReady;
    } catch (error) {
      this.listenersReady = null;
      throw error;
    }
  }

  private async installListeners(): Promise<void> {
    this.listenerHandles.push(
      await PushNotifications.addListener('registration', (token: Token) => {
        // Do not log the token itself.
        this.tokenSubject.next(token.value);
        this.logStatus('FCM registration event received; device token available.');
        void this.syncTokenWithBackend();
      })
    );

    this.listenerHandles.push(
      await PushNotifications.addListener('registrationError', () => {
        this.logWarning('Native Firebase registration returned an error.');
        this.errorSubject.next('Firebase push registration failed.');
      })
    );

    this.listenerHandles.push(
      await PushNotifications.addListener(
        'pushNotificationReceived',
        (notification: PushNotificationSchema) => {
          // Foreground delivery is not the same as a system-tray notification.
          this.logStatus('Push received while PawConnect was in the foreground.');
          this.receivedSubject.next(notification);
        }
      )
    );

    this.listenerHandles.push(
      await PushNotifications.addListener(
        'pushNotificationActionPerformed',
        (action: ActionPerformed) => {
          this.logStatus('Resident tapped a delivered push notification.');
          this.openedSubject.next(action);
        }
      )
    );
  }

  /**
   * Request notification permission and begin native FCM registration.
   * 'registered' means the register() call completed, not that a token has
   * been uploaded or a notification has been displayed.
   */
  async registerForPush(): Promise<'registered' | 'denied' | 'not-native'> {
    if (!this.isSupported()) {
      this.logStatus('Native Android push is unavailable in this environment.');
      return 'not-native';
    }

    // This method is called only from resident-protected navigation.
    // Capture its session before async permission and native operations.
    const session = this.getSessionToken();
    if (!session) {
      throw new Error('Resident push registration requires an active session.');
    }

    await this.ensureListeners();

    let permission = await PushNotifications.checkPermissions();
    this.logStatus(`Notification permission before request: ${permission.receive}.`);

    if (permission.receive !== 'granted') {
      permission = await PushNotifications.requestPermissions();
      this.logStatus(`Notification permission after request: ${permission.receive}.`);
    }

    if (permission.receive !== 'granted') {
      this.logWarning('Notification permission not granted; FCM registration skipped.');
      this.errorSubject.next(
        'Notifications are not allowed. Enable them in Android app settings.'
      );
      return 'denied';
    }

    // The account may have changed while the Android permission prompt was
    // open. Never authorize an old resident registration for a new session.
    if (this.getSessionToken() !== session) {
      throw new Error('Session changed during push registration.');
    }

    // Resident route authorization has already succeeded in the route guard.
    this.residentRegistrationSession = session;

    try {
      this.logStatus('Starting native FCM registration.');
      await PushNotifications.register();
      this.logStatus('Native FCM register() completed; checking token event/upload.');

      // Reassociate a token cached during an earlier sign-in if present.
      if (this.tokenSubject.value) {
        void this.syncTokenWithBackend();
      }

      return 'registered';
    } catch {
      this.logWarning('Native FCM register() threw an exception.');
      this.errorSubject.next('Unable to start Firebase push registration.');
      throw new Error('Unable to start Firebase push registration.');
    }
  }

  /** Save the FCM token under the currently authenticated resident. */
  async syncTokenWithBackend(): Promise<boolean> {
    if (!this.isSupported()) {
      return false;
    }

    if (this.activeUpload) {
      await this.activeUpload;
    }

    const deviceToken = this.tokenSubject.value;
    const session = this.getSessionToken();

    if (!deviceToken) {
      this.logWarning('No FCM device token is available for upload yet.');
      return false;
    }

    if (!session) {
      this.logWarning('No authenticated resident session; token upload skipped.');
      return false;
    }

    // Token callbacks can arrive after switching accounts. Only upload while
    // the same resident session that initiated native registration is active.
    if (this.residentRegistrationSession !== session) {
      this.logStatus('Skipping token upload for a session without resident push registration.');
      return false;
    }

    if (this.logoutSession === session) {
      return false;
    }

    if (
      this.lastSavedFor?.session === session &&
      this.lastSavedFor.deviceToken === deviceToken
    ) {
      this.logStatus('Device token was already saved for this app session.');
      return true;
    }

    if (this.activeUpload) {
      await this.activeUpload;
      return this.syncTokenWithBackend();
    }

    const upload = this.saveForSession(session, deviceToken);
    this.activeUpload = upload;

    try {
      return await upload;
    } finally {
      if (this.activeUpload === upload) {
        this.activeUpload = null;
      }
    }
  }

  private async saveForSession(
    session: string,
    deviceToken: string
  ): Promise<boolean> {
    if (
      this.getSessionToken() !== session ||
      this.residentRegistrationSession !== session ||
      this.logoutSession === session
    ) {
      return false;
    }

    this.tokenSaveStatusSubject.next('saving');
    this.logStatus('Saving FCM device token to PawConnect backend.');

    try {
      const response = await firstValueFrom(
        this.http.post<SaveDeviceTokenResponse>(
          this.saveDeviceTokenUrl,
          { device_token: deviceToken },
          {
            headers: new HttpHeaders({
              Authorization: `Bearer ${session}`
            })
          }
        )
      );

      if (!response.success || !response.registered) {
        throw new Error('Backend did not confirm device registration.');
      }

      this.lastSavedFor = { session, deviceToken };
      this.tokenSaveStatusSubject.next('saved');
      this.logStatus('Backend confirmed that the FCM device token was saved.');
      return true;
    } catch (error) {
      this.tokenSaveStatusSubject.next('failed');

      // HTTP 0 commonly indicates an unreachable server, cleartext/CORS issue,
      // or network failure; HTTP 401 indicates auth rejection. No response
      // body, device token, Authorization header or URL is logged.
      const httpStatus = error instanceof HttpErrorResponse
        ? String(error.status)
        : 'unavailable';
      this.logWarning(`FCM token upload failed; HTTP status: ${httpStatus}.`);

      this.errorSubject.next(
        'Firebase token received, but PawConnect could not save the device.'
      );
      return false;
    }
  }

  /**
   * Deactivate this device for the current account before auth/logout.php.
   * If a known token fails deactivation, callers should allow a retry.
   */
  async deactivateCurrentDeviceForLogout(): Promise<boolean> {
    if (!this.isSupported()) {
      return true;
    }

    const session = this.getSessionToken();
    if (!session) {
      return true;
    }

    // Staff sessions never initiate resident Firebase registration. Do not
    // call the resident-only deactivation endpoint during a staff logout.
    // AuthService can proceed to auth/logout.php normally.
    if (this.residentRegistrationSession !== session) {
      this.logStatus('No resident push registration for this session; skipping deactivation.');
      return true;
    }

    if (this.activeDeactivation) {
      return this.activeDeactivation;
    }

    this.logoutSession = session;
    const deactivation = this.deactivateForSession(session);
    this.activeDeactivation = deactivation;

    try {
      const success = await deactivation;
      if (!success && this.logoutSession === session) {
        this.logoutSession = null;
      }
      return success;
    } finally {
      if (this.activeDeactivation === deactivation) {
        this.activeDeactivation = null;
      }
    }
  }

  private async deactivateForSession(session: string): Promise<boolean> {
    if (this.activeUpload) {
      await this.activeUpload;
    }

    if (this.getSessionToken() !== session) {
      return false;
    }

    const deviceToken = this.tokenSubject.value;
    if (!deviceToken) {
      // No known current token to submit; an older server token may exist.
      return true;
    }

    try {
      const response = await firstValueFrom(
        this.http.post<DeactivateDeviceTokenResponse>(
          this.deactivateDeviceTokenUrl,
          { device_token: deviceToken },
          {
            headers: new HttpHeaders({
              Authorization: `Bearer ${session}`
            })
          }
        )
      );

      if (!response.success) {
        throw new Error('Backend did not confirm token deactivation.');
      }

      if (this.lastSavedFor?.session === session) {
        this.lastSavedFor = null;
      }

      this.tokenSaveStatusSubject.next('idle');
      return true;
    } catch {
      this.errorSubject.next(
        'Unable to disable push notifications for this device. Try logging out again.'
      );
      return false;
    }
  }

  /** Re-enable token saving after a failed main logout request. */
  async restorePushAfterFailedLogout(): Promise<boolean> {
    const session = this.getSessionToken();
    if (!session || this.logoutSession !== session) {
      return false;
    }

    this.logoutSession = null;
    this.lastSavedFor = null;
    return this.syncTokenWithBackend();
  }

  /** Call after auth/logout.php succeeds and the local session is cleared. */
  resetAfterLogout(): void {
    this.logoutSession = null;
    this.lastSavedFor = null;
    this.residentRegistrationSession = null;
    this.tokenSaveStatusSubject.next('idle');

    // Keep the token cached for another authenticated resident on this phone.
  }

  /** For authenticated use only: never display or log the FCM token. */
  getCurrentToken(): string | null {
    return this.tokenSubject.value;
  }
}
