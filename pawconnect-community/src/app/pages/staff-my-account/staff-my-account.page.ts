import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  NgZone,
  OnDestroy,
  OnInit,
  inject
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { Capacitor } from '@capacitor/core';
import {
  HttpClient,
  HttpErrorResponse,
  HttpHeaders
} from '@angular/common/http';
import { Router } from '@angular/router';
import { IonContent, IonIcon, IonSpinner } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  alertCircleOutline,
  arrowBackOutline,
  callOutline,
  checkmarkCircleOutline,
  checkmarkOutline,
  closeOutline,
  createOutline,
  homeOutline,
  logOutOutline,
  mailOutline,
  pawOutline,
  personCircleOutline,
  personOutline,
  refreshOutline,
  shieldCheckmarkOutline
} from 'ionicons/icons';
import { firstValueFrom, timeout } from 'rxjs';

import {
  AuthService,
  UpdateProfileRequest,
  User
} from '../../services/auth';
import { getApiBaseUrl } from '../../config/ip-config';

// ============================================================
// PAWCONNECT — BARANGAY STAFF — MY ACCOUNT
//
// This screen is completely separate from the resident My Account.
// Profile details load AUTOMATICALLY on first entry and on return.
// There is no need for a Refresh button. The refreshProfile() method
// is retained only for the HTML's "Try Again" error action until
// the companion HTML is updated.
//
// Profile read: GET /auth/me.php (existing AuthService.getProfile())
// Profile edit: POST /auth/update_staff_profile.php (staff-only)
// Logout: existing AuthService.logout() (preserves push-token cleanup)
//
// Email / role / password are NOT editable.
// Do not call the resident-only /auth/update_profile.php endpoint.
// ============================================================

interface StaffUpdateProfileResponse {
  success: boolean;
  message: string;
  user: User;
}

@Component({
  selector: 'app-staff-my-account',
  templateUrl: './staff-my-account.page.html',
  styleUrls: ['./staff-my-account.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonContent,
    IonIcon,
    IonSpinner
  ]
})
export class StaffMyAccountPage implements OnInit, OnDestroy {
  private readonly authService = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);

  private readonly staffProfileUpdateUrl =
    `${getApiBaseUrl().replace(/\/$/, '')}/auth/update_staff_profile.php`;

  // Native Android feedback only. Never block account actions if unavailable.
  private hapticImpact(style: ImpactStyle = ImpactStyle.Light): void {
    if (!Capacitor.isNativePlatform()) return;
    void Haptics.impact({ style }).catch(() => undefined);
  }

  private hapticNotification(type: NotificationType): void {
    if (!Capacitor.isNativePlatform()) return;
    void Haptics.notification({ type }).catch(() => undefined);
  }

  private destroyed = false;
  private requestVersion = 0;
  private profileToken: string | null = null;
  private activeProfileLoad: Promise<void> | null = null;

  profile: User | null = null;
  loading = false;
  savingProfile = false;
  loggingOut = false;

  errorMessage = '';
  logoutError = '';
  editError = '';
  editSuccess = '';

  lastUpdated: Date | null = null;
  editingProfile = false;

  editForm: UpdateProfileRequest = {
    first_name: '',
    middle_name: '',
    last_name: '',
    username: '',
    contact_number: ''
  };

  constructor() {
    addIcons({
      alertCircleOutline,
      arrowBackOutline,
      callOutline,
      checkmarkCircleOutline,
      checkmarkOutline,
      closeOutline,
      createOutline,
      homeOutline,
      logOutOutline,
      mailOutline,
      pawOutline,
      personCircleOutline,
      personOutline,
      refreshOutline,
      shieldCheckmarkOutline
    });
  }

  // Load as soon as the Angular page is created.
  ngOnInit(): void {
    void this.loadProfile();
  }

  // Ionic may cache a page and skip ngOnInit on later visits.
  // Revalidate automatically every time staff return to this tab.
  ionViewWillEnter(): void {
    void this.loadProfile();
  }

  ionViewWillLeave(): void {
    // Discard delayed responses from a page that is no longer active.
    ++this.requestVersion;
    this.activeProfileLoad = null;
    this.editingProfile = false;
    this.loading = false;
  }

  private applyViewUpdate(update: () => void): void {
    if (this.destroyed) {
      return;
    }

    this.zone.run(() => {
      if (this.destroyed) {
        return;
      }
      update();
      this.cdr.markForCheck();
      this.cdr.detectChanges();
    });
  }

  // Called automatically by Angular and Ionic. Also used for
  // "Try Again" if the automatic request fails.
  async loadProfile(): Promise<void> {
    if (this.destroyed || this.loggingOut || this.savingProfile) {
      return;
    }

    const token = this.authService.getToken();
    if (!token) {
      this.clearProfile();
      void this.router.navigateByUrl('/login', { replaceUrl: true });
      return;
    }

    if (this.profileToken !== token) {
      this.clearProfile();
      this.profileToken = token;
    }

    // Do not issue two simultaneous GETs when both ngOnInit()
    // and ionViewWillEnter() fire on initial page entry.
    if (this.activeProfileLoad) {
      return this.activeProfileLoad;
    }

    const version = ++this.requestVersion;

    this.applyViewUpdate(() => {
      this.loading = true;
      this.errorMessage = '';
    });

    const operation = this.performProfileLoad(token, version);
    this.activeProfileLoad = operation;

    try {
      await operation;
    } finally {
      if (this.activeProfileLoad === operation) {
        this.activeProfileLoad = null;
      }
    }
  }

  private async performProfileLoad(
    token: string,
    version: number
  ): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.authService.getProfile().pipe(timeout(15000))
      );

      if (!this.isCurrentRequest(token, version)) {
        return;
      }

      const staff = response?.user;
      if (
        !response?.success ||
        !staff ||
        staff.role !== 'staff' ||
        !Number.isInteger(staff.id) ||
        staff.id < 1
      ) {
        this.applyViewUpdate(() => {
          this.clearProfile();
          this.errorMessage =
            'This account does not have permission to access the Barangay Staff profile.';
        });
        return;
      }

      this.applyViewUpdate(() => {
        this.profile = staff;
        this.profileToken = token;
        this.lastUpdated = new Date();
        this.errorMessage = '';
      });
    } catch (error: unknown) {
      if (!this.isCurrentRequest(token, version)) {
        return;
      }

      const httpError = error instanceof HttpErrorResponse ? error : null;

      if (httpError?.status === 401) {
        this.applyViewUpdate(() => this.clearProfile());
        void this.router.navigateByUrl('/login', { replaceUrl: true });
        return;
      }

      this.applyViewUpdate(() => {
        // For a temporary network failure, keep a previously verified
        // profile belonging to the same session instead of replacing
        // it with empty fields. Forbidden sessions are always cleared.
        if (httpError?.status === 403) {
          this.clearProfile();
        }

        this.errorMessage =
          httpError?.status === 403
            ? 'Access to this staff profile was denied.'
            : error instanceof Error && error.name === 'TimeoutError'
              ? 'Loading your profile timed out. Please try again.'
              : httpError?.status === 0
                ? 'Cannot connect to the server. Check your connection and try again.'
                : 'Unable to load your staff account. Please try again.';
      });
    } finally {
      if (this.isCurrentRequest(token, version)) {
        this.applyViewUpdate(() => {
          this.loading = false;
        });
      }
    }
  }

  // Retained for the "Try Again" button in the current HTML.
  // The separate Refresh button will be removed in the HTML update.
  refreshProfile(): void {
    this.hapticImpact();
    void this.loadProfile();
  }

  // ============================================================
  // EDIT PROFILE — MATCHES THE RESIDENT ACCOUNT EXPERIENCE,
  // BUT SAVES THROUGH THE NEW STAFF-ONLY PHP ENDPOINT.
  // ============================================================

  async openEditProfile(): Promise<void> {
    if (
      !this.profile ||
      this.loading ||
      this.loggingOut ||
      this.savingProfile
    ) {
      return;
    }

    // Saved name parts come from /auth/me.php. Never guess by
    // splitting a full name that may contain multiple words.
    if (!this.profile.first_name?.trim() || !this.profile.last_name?.trim()) {
      await this.loadProfile();
    }

    const current = this.profile;
    if (!current || !current.first_name?.trim() || !current.last_name?.trim()) {
      this.applyViewUpdate(() => {
        this.editError =
          'Your name details are not available. Please reopen My Account and try again.';
      });
      return;
    }

    this.hapticImpact();
    this.applyViewUpdate(() => {
      this.editForm = {
        first_name: current.first_name!.trim(),
        middle_name: (current.middle_name ?? '').trim(),
        last_name: current.last_name!.trim(),
        username: (current.username ?? '').trim(),
        contact_number: (current.contact_number ?? '').trim()
      };
      this.editingProfile = true;
      this.editError = '';
      this.editSuccess = '';
    });
  }

  cancelEditProfile(): void {
    if (this.savingProfile || this.loggingOut) {
      return;
    }

    this.hapticImpact();
    this.applyViewUpdate(() => {
      this.editingProfile = false;
      this.editError = '';
    });
  }

  private validateEditForm(data: UpdateProfileRequest): string | null {
    if (
      !data.first_name ||
      !data.last_name ||
      !data.username ||
      !data.contact_number
    ) {
      return 'Please complete all required profile fields.';
    }

    const names = [data.first_name, data.middle_name, data.last_name];
    if (names.some((name) => /[\x00-\x1F\x7F]/.test(name))) {
      return 'Names must not contain line breaks or control characters.';
    }

    if (names.some((name) => Array.from(name).length > 100)) {
      return 'Each name field must contain 100 characters or fewer.';
    }

    const fullName = names.filter(Boolean).join(' ');
    if (Array.from(fullName).length > 150) {
      return 'Combined full name must contain 150 characters or fewer.';
    }

    if (!/^[a-zA-Z0-9_]{3,50}$/.test(data.username)) {
      return 'Username must have 3–50 letters, numbers, or underscores.';
    }

    if (!/^\+?[0-9]{10,15}$/.test(data.contact_number)) {
      return 'Enter a contact number with 10–15 digits and an optional leading +.';
    }

    return null;
  }

  async saveProfile(): Promise<void> {
    if (
      !this.editingProfile ||
      !this.profile ||
      this.loading ||
      this.loggingOut ||
      this.savingProfile
    ) {
      return;
    }

    const token = this.authService.getToken();
    const previous = this.profile;
    if (!token || token !== this.profileToken) {
      this.applyViewUpdate(() => {
        this.editError = 'Your session has expired. Please log in again.';
        this.hapticNotification(NotificationType.Error);
      });
      return;
    }

    const request: UpdateProfileRequest = {
      first_name: this.editForm.first_name.trim(),
      middle_name: this.editForm.middle_name.trim(),
      last_name: this.editForm.last_name.trim(),
      username: this.editForm.username.trim(),
      contact_number: this.editForm.contact_number.trim()
    };

    const validationError = this.validateEditForm(request);
    if (validationError) {
      this.hapticNotification(NotificationType.Error);
      this.applyViewUpdate(() => {
        this.editError = validationError;
      });
      return;
    }

    const unchanged =
      (previous.first_name ?? '').trim() === request.first_name &&
      (previous.middle_name ?? '').trim() === request.middle_name &&
      (previous.last_name ?? '').trim() === request.last_name &&
      (previous.username ?? '').trim() === request.username &&
      (previous.contact_number ?? '').trim() === request.contact_number;

    if (unchanged) {
      this.applyViewUpdate(() => {
        this.editingProfile = false;
        this.editError = '';
        this.editSuccess = 'No changes to save.';
      });
      return;
    }

    this.hapticImpact(ImpactStyle.Medium);
    this.applyViewUpdate(() => {
      this.savingProfile = true;
      this.editError = '';
      this.editSuccess = '';
    });

    try {
      const response = await firstValueFrom(
        this.http.post<StaffUpdateProfileResponse>(
          this.staffProfileUpdateUrl,
          request,
          {
            headers: new HttpHeaders({
              Authorization: `Bearer ${token}`
            })
          }
        ).pipe(timeout(15000))
      );

      if (
        this.destroyed ||
        this.authService.getToken() !== token ||
        this.profileToken !== token
      ) {
        return;
      }

      const updated = response?.user;
      if (
        !response?.success ||
        !updated ||
        updated.id !== previous.id ||
        updated.role !== 'staff' ||
        updated.email !== previous.email
      ) {
        throw new Error('The server did not confirm a valid staff profile update.');
      }

      this.hapticNotification(NotificationType.Success);
      this.applyViewUpdate(() => {
        this.profile = updated;
        this.editingProfile = false;
        this.editError = '';
        this.editSuccess = response.message || 'Profile updated successfully.';
        this.lastUpdated = new Date();
      });
    } catch (error: unknown) {
      if (
        this.destroyed ||
        this.authService.getToken() !== token ||
        this.profileToken !== token
      ) {
        return;
      }

      const httpError = error instanceof HttpErrorResponse ? error : null;
      const serverMessage: unknown = httpError?.error?.message;

      this.hapticNotification(NotificationType.Error);
      this.applyViewUpdate(() => {
        // Keep the form and entries intact so staff can correct/retry.
        this.editingProfile = true;
        this.editSuccess = '';
        this.editError =
          httpError?.status === 401
            ? 'Your session expired. Sign in again before editing.'
            : httpError?.status === 403
              ? 'This staff account cannot be edited.'
              : error instanceof Error && error.name === 'TimeoutError'
                ? 'The update was not confirmed. Check your connection and try again.'
                : typeof serverMessage === 'string'
                  ? serverMessage
                  : error instanceof Error && !httpError
                    ? error.message
                    : 'Unable to update your profile. Please try again.';
      });
    } finally {
      if (!this.destroyed && this.authService.getToken() === token) {
        this.applyViewUpdate(() => {
          this.savingProfile = false;
        });
      }
    }
  }

  get displayName(): string {
    return this.profile?.full_name?.trim() || 'Barangay Staff';
  }

  get initials(): string {
    return this.getInitials();
  }

  getInitials(): string {
    const name = this.profile?.full_name?.trim() || '';
    if (!name) {
      return 'BS';
    }

    return name.split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('');
  }

  // ============================================================
  // STAFF-ONLY BOTTOM NAVIGATION
  // ============================================================

  goHome(): void {
    if (!this.loggingOut && !this.savingProfile) {
      this.hapticImpact();
      void this.router.navigateByUrl('/staff-dashboard');
    }
  }

  goMyAssistedCases(): void {
    if (!this.loggingOut && !this.savingProfile) {
      this.hapticImpact();
      void this.router.navigateByUrl('/staff-my-assisted-cases');
    }
  }

  // ============================================================
  // SECURE LOGOUT — REUSE THE EXISTING AUTH SERVICE
  // ============================================================

  async logout(): Promise<void> {
    if (this.destroyed || this.loggingOut || this.savingProfile) {
      return;
    }

    if (!window.confirm('Log out of PawConnect Staff Portal?')) {
      return;
    }

    this.hapticImpact(ImpactStyle.Medium);
    this.applyViewUpdate(() => {
      this.loggingOut = true;
      this.logoutError = '';
      this.errorMessage = '';
    });

    ++this.requestVersion;

    try {
      const success = await firstValueFrom(
        this.authService.logout().pipe(timeout(20000))
      );

      if (this.destroyed) {
        return;
      }

      if (success !== true) {
        this.hapticNotification(NotificationType.Error);
        this.applyViewUpdate(() => {
          this.logoutError = 'Unable to log out. Please try again.';
        });
        return;
      }

      this.applyViewUpdate(() => {
        this.clearProfile();
        this.editingProfile = false;
        this.editError = '';
        this.editSuccess = '';
      });

      this.hapticNotification(NotificationType.Success);
      await this.router.navigateByUrl('/login', { replaceUrl: true });
    } catch (error: unknown) {
      if (this.destroyed) {
        return;
      }

      this.hapticNotification(NotificationType.Error);
      this.applyViewUpdate(() => {
        this.logoutError =
          error instanceof Error && error.name === 'TimeoutError'
            ? 'Logout took too long. Check your connection and try again.'
            : 'Unable to log out. Please try again.';
      });
    } finally {
      this.applyViewUpdate(() => {
        this.loggingOut = false;
      });
    }
  }

  private isCurrentRequest(token: string, version: number): boolean {
    return !this.destroyed &&
      version === this.requestVersion &&
      this.authService.getToken() === token;
  }

  private clearProfile(): void {
    this.profile = null;
    this.profileToken = null;
    this.lastUpdated = null;
    this.loading = false;
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    ++this.requestVersion;
    this.activeProfileLoad = null;
    this.clearProfile();
  }
}
