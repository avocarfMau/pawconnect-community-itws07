import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { getApiBaseUrl } from '../config/ip-config';
import { Observable, of, from, map, catchError, throwError, firstValueFrom } from 'rxjs';
import { PushNotificationService } from './push-notifications';

// =====================================
// PAWRESCUE COMMUNITY - AUTH SERVICE
// =====================================

// =====================================
// USER INFORMATION
// =====================================
export interface User {
  id: number;
  full_name: string;
  email: string;
  username: string;
  role: 'resident' | 'staff';

  // Login responses may omit these fields; auth/me.php returns them.
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  contact_number?: string | null;
  barangay?: string | null;
}

// =====================================
// LOGIN RESPONSE
// =====================================
export interface LoginResponse {
  success: boolean;
  message: string;
  token: string;
  token_type: string;
  expires_at: string;
  user: User;
}

// =====================================
// REGISTRATION REQUEST
// =====================================
export interface RegisterRequest {
  first_name: string;
  middle_name: string;
  last_name: string;
  email: string;
  username: string;
  contact_number: string;
  password: string;
  confirm_password: string;
}

// =====================================
// REGISTRATION RESPONSE
// =====================================
export interface RegisterResponse {
  success: boolean;
  message: string;
}

// =====================================
// AUTHENTICATED PROFILE RESPONSE
// =====================================
export interface ProfileResponse {
  success: boolean;
  message?: string;
  user: User;
}

// =====================================
// EDIT PROFILE REQUEST / RESPONSE
// =====================================
// Email, password, role, and status are deliberately not editable here.
export interface UpdateProfileRequest {
  first_name: string;
  middle_name: string; // Empty string is allowed.
  last_name: string;
  username: string;
  contact_number: string;
}

export interface UpdateProfileResponse extends ProfileResponse {
  message: string;
  user: User;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly pushNotifications = inject(PushNotificationService);
  private activeLogout: Promise<boolean> | null = null;

  // Shared backend configuration; update the IP only in ip-config.ts.
  private readonly apiUrl = `${getApiBaseUrl()}/auth`;

  private authHeaders(token: string): HttpHeaders {
    return new HttpHeaders({
      Authorization: `Bearer ${token}`
    });
  }

  // =====================================
  // LOGIN
  // =====================================
  login(login: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(
      `${this.apiUrl}/login.php`,
      { login, password }
    );
  }

  // =====================================
  // REGISTRATION
  // =====================================
  register(data: RegisterRequest): Observable<RegisterResponse> {
    return this.http.post<RegisterResponse>(
      `${this.apiUrl}/register.php`,
      data
    );
  }

  // =====================================
  // SAVE AUTHENTICATION SESSION
  // =====================================
  saveSession(response: LoginResponse): void {
    sessionStorage.setItem('pawrescue_token', response.token);
  }

  // =====================================
  // GET SAVED TOKEN
  // =====================================
  getToken(): string | null {
    return sessionStorage.getItem('pawrescue_token');
  }

  // =====================================
  // GET AUTHENTICATED USER PROFILE
  // =====================================
  // Calls the same existing auth/me.php endpoint used by session checks.
  // The backend determines identity from the Bearer token, not a user ID
  // passed by the frontend. No personal data is stored in localStorage.
  getProfile(): Observable<ProfileResponse> {
    const token = this.getToken();

    if (!token) {
      return throwError(() => new Error('Please log in to view your profile.'));
    }

    return this.http.get<ProfileResponse>(
      `${this.apiUrl}/me.php`,
      { headers: this.authHeaders(token) }
    );
  }

  // =====================================
  // UPDATE RESIDENT PROFILE
  // =====================================
  // The backend identifies the resident from the Bearer token.
  // Only the editable fields are sent to update_profile.php.
  updateProfile(data: UpdateProfileRequest): Observable<UpdateProfileResponse> {
    const token = this.getToken();

    if (!token) {
      return throwError(() => new Error('Please log in before editing your profile.'));
    }

    const body: UpdateProfileRequest = {
      first_name: data.first_name.trim(),
      middle_name: data.middle_name.trim(),
      last_name: data.last_name.trim(),
      username: data.username.trim(),
      contact_number: data.contact_number.trim()
    };

    return this.http.post<UpdateProfileResponse>(
      `${this.apiUrl}/update_profile.php`,
      body,
      { headers: this.authHeaders(token) }
    );
  }

  // =====================================
  // VERIFY SESSION
  // =====================================
  verifySession(requiredRole?: 'resident' | 'staff'): Observable<boolean> {
    if (!this.getToken()) {
      return of(false);
    }

    return this.getProfile().pipe(
      map(response => {
        if (!response?.success || !response.user) {
          return false;
        }

        return !requiredRole || response.user.role === requiredRole;
      }),
      catchError(error => {
        console.error(
          'Session verification failed:',
          error?.status,
          error?.message
        );

        if (error?.status === 401) {
          this.clearSession();
        }

        return of(false);
      })
    );
  }

  // =====================================
  // LOGOUT - WITH DEVICE TOKEN DEACTIVATION
  // =====================================
  // Keep the Observable<boolean> contract for existing My Account UI.
  // Deactivate the CURRENT phone's FCM token before logout.php revokes
  // the Bearer token. Never disable a resident's other devices.
  //
  // A failed deactivation of a known device token prevents logout so
  // users can retry and don't silently keep receiving another user's
  // notifications after signing out.
  logout(): Observable<boolean> {
    // A second logout click must not run a second server-side sequence.
    if (this.activeLogout) {
      return from(this.activeLogout);
    }

    const token = this.getToken();

    if (!token) {
      this.clearSession();
      this.pushNotifications.resetAfterLogout();
      return of(true);
    }

    const operation = this.logoutWithPushDeactivation(token);
    this.activeLogout = operation;

    // Always release the in-flight guard, including unexpected failures.
    void operation.then(
      () => {
        if (this.activeLogout === operation) {
          this.activeLogout = null;
        }
      },
      () => {
        if (this.activeLogout === operation) {
          this.activeLogout = null;
        }
      }
    );

    return from(operation);
  }

  private async logoutWithPushDeactivation(token: string): Promise<boolean> {
    try {
      // If a new session replaced this one, never log out the new user.
      if (this.getToken() !== token) {
        return false;
      }

      // This waits for any pending device-token save, then deactivates
      // only the token attached to the currently authenticated resident.
      const pushDeactivated =
        await this.pushNotifications.deactivateCurrentDeviceForLogout();

      if (!pushDeactivated) {
        // The push service clears its logout guard on failure.
        // Keep the account signed in so the action can be retried.
        return false;
      }

      if (this.getToken() !== token) {
        // Session changed while awaiting Firebase token deactivation.
        return false;
      }

      try {
        const response = await firstValueFrom(
          this.http.post<{ success: boolean; message: string }>(
            `${this.apiUrl}/logout.php`,
            {},
            { headers: this.authHeaders(token) }
          )
        );

        if (response?.success) {
          this.finishLogout(token);
          return true;
        }

        // The normal auth logout failed. Keep the session active and
        // restore push registration for the still-logged-in resident.
        await this.restorePushAfterLogoutFailure();
        return false;
      } catch (error: unknown) {
        const requestError = error as { status?: number; message?: string };

        console.error(
          'Logout request failed:',
          requestError?.status,
          requestError?.message
        );

        if (requestError?.status === 401) {
          // Preserve the previous behavior: an expired/revoked Bearer
          // token is treated as already logged out.
          this.finishLogout(token);
          return true;
        }

        await this.restorePushAfterLogoutFailure();
        return false;
      }
    } catch (error: unknown) {
      // Do not surface tokens or credential values in diagnostics.
      console.error('Unable to complete push-safe logout.');
      return false;
    }
  }

  private async restorePushAfterLogoutFailure(): Promise<void> {
    try {
      await this.pushNotifications.restorePushAfterFailedLogout();
    } catch {
      // Failure to restore push should not clear the login session.
      console.warn('Push registration could not be restored after logout failed.');
    }
  }

  private finishLogout(originalToken: string): void {
    if (this.getToken() === originalToken) {
      this.clearSession();
      this.pushNotifications.resetAfterLogout();
    }
  }

  // =====================================
  // CLEAR AUTHENTICATION SESSION
  // =====================================
  clearSession(): void {
    sessionStorage.removeItem('pawrescue_token');
  }
}
