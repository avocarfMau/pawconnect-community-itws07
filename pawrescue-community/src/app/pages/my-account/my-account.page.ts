import { Component, OnInit, OnDestroy, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonContent,
  IonButton,
  IonIcon,
  IonSpinner
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  personCircleOutline,
  personOutline,
  mailOutline,
  callOutline,
  locationOutline,
  refreshOutline,
  logOutOutline,
  shieldCheckmarkOutline,
  createOutline,
  checkmarkOutline,
  closeOutline
} from 'ionicons/icons';
import { firstValueFrom, isObservable, timeout } from 'rxjs';
import { AuthService, UpdateProfileRequest } from '../../services/auth';

// =====================================
// PAWRESCUE COMMUNITY - MY ACCOUNT
// Initial profile visibility + fast return visits; one request at a time
// =====================================

export interface ResidentAccountProfile {
  id: number;
  full_name: string;
  email: string;
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  contact_number?: string | null;
  barangay?: string | null;
  role?: string | null;
}

interface AccountResponse {
  success?: boolean;
  message?: string;
  user?: ResidentAccountProfile | null;
  id?: number;
  full_name?: string;
  email?: string;
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  contact_number?: string | null;
  barangay?: string | null;
  role?: string | null;
}

interface ProfileSnapshot {
  // In-memory only. Never reuse another account's profile.
  token: string;
  profile: ResidentAccountProfile;
  loadedAt: number;
}

// Keep the last verified profile while Ionic recreates the page.
// Nothing is written to localStorage/sessionStorage except the existing
// authentication token managed by AuthService.
let lastProfileSnapshot: ProfileSnapshot | null = null;

// Revalidate on re-entry after this interval; the Refresh button always
// asks the server for the latest information.
const PROFILE_REFRESH_INTERVAL_MS = 30_000;

@Component({
  selector: 'app-my-account',
  templateUrl: './my-account.page.html',
  styleUrls: ['./my-account.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonContent,
    IonButton,
    IonIcon,
    IonSpinner
  ]
})
export class MyAccountPage implements OnInit, OnDestroy {
  profile: ResidentAccountProfile | null = null;
  loading = true;
  loggingOut = false;
  errorMessage = '';
  logoutError = '';

  // Edit Profile state. The HTML will bind these fields with ngModel.
  editingProfile = false;
  savingProfile = false;
  editError = '';
  editSuccess = '';
  editForm: UpdateProfileRequest = {
    first_name: '',
    middle_name: '',
    last_name: '',
    username: '',
    contact_number: ''
  };

  private destroyed = false;
  private firstEntrance = true;
  private loadVersion = 0;
  private profileToken: string | null = null;
  private lastLoadedAt = 0;
  private activeLoad: {
    token: string;
    version: number;
    promise: Promise<void>;
  } | null = null;

  constructor(
    private readonly router: Router,
    private readonly authService: AuthService,
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef
  ) {
    addIcons({
      arrowBackOutline,
      personCircleOutline,
      personOutline,
      mailOutline,
      callOutline,
      locationOutline,
      refreshOutline,
      logOutOutline,
      shieldCheckmarkOutline,
      createOutline,
      checkmarkOutline,
      closeOutline
    });

    // If the user already visited My Account in this app session, show the
    // verified details before starting a background refresh.
    this.restoreProfileSnapshot();
  }

  ngOnInit(): void {
    void this.fetchProfile(false);
  }

  ionViewWillEnter(): void {
    // Ionic also calls this on the first entrance; do not duplicate ngOnInit.
    if (this.firstEntrance) {
      this.firstEntrance = false;
      return;
    }

    // Ionic lifecycle callbacks are not guaranteed to refresh the template
    // after asynchronous work on all supported WebView configurations.
    this.applyViewUpdate(() => this.restoreProfileSnapshot());
    void this.fetchProfile(false);
  }

  /**
   * Explicitly refresh the Angular view after asynchronous profile/logout work.
   * A successful HTTP response must appear on the very FIRST visit, without
   * requiring a Back -> My Account navigation to trigger change detection.
   */
  private applyViewUpdate(update: () => void): void {
    if (this.destroyed) return;

    this.zone.run(() => {
      if (this.destroyed) return;
      update();
      this.cdr.markForCheck();
      this.cdr.detectChanges();
    });
  }

  private getSessionToken(): string {
    return this.authService.getToken() || '';
  }

  private restoreProfileSnapshot(): void {
    const token = this.getSessionToken();

    // Immediately discard old identity data when the session changes.
    if (!token || (lastProfileSnapshot && lastProfileSnapshot.token !== token)) {
      lastProfileSnapshot = null;
    }

    if (this.profileToken && this.profileToken !== token) {
      ++this.loadVersion;
      this.profile = null;
      this.profileToken = null;
      this.lastLoadedAt = 0;
      this.editingProfile = false;
      this.savingProfile = false;
      this.editError = '';
      this.editSuccess = '';
    }

    if (token && lastProfileSnapshot?.token === token) {
      this.profile = lastProfileSnapshot.profile;
      this.profileToken = token;
      this.lastLoadedAt = lastProfileSnapshot.loadedAt;
      this.loading = false;
    }
  }

  private parseProfile(response: AccountResponse): ResidentAccountProfile | null {
    const user = response.user || response;

    if (
      !user ||
      typeof user.id !== 'number' ||
      !Number.isInteger(user.id) ||
      user.id <= 0 ||
      typeof user.full_name !== 'string' ||
      typeof user.email !== 'string'
    ) {
      return null;
    }

    return {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      first_name: typeof user.first_name === 'string' ? user.first_name : null,
      middle_name: typeof user.middle_name === 'string' ? user.middle_name : null,
      last_name: typeof user.last_name === 'string' ? user.last_name : null,
      username: typeof user.username === 'string' ? user.username : null,
      contact_number: typeof user.contact_number === 'string' ? user.contact_number : null,
      barangay: typeof user.barangay === 'string' ? user.barangay : null,
      role: typeof user.role === 'string' ? user.role : null
    };
  }

  // Used by the existing HTML Refresh and Try Again buttons.
  // These explicitly request the latest profile from the server.
  async loadProfile(): Promise<void> {
    await this.fetchProfile(true);
  }

  private async fetchProfile(force: boolean): Promise<void> {
    if (this.destroyed || this.loggingOut || this.savingProfile) return;

    const token = this.getSessionToken();
    this.restoreProfileSnapshot();

    if (!token) {
      ++this.loadVersion;
      this.profile = null;
      this.profileToken = null;
      this.lastLoadedAt = 0;
      this.loading = false;
      this.errorMessage = 'Your session has expired. Please log in again.';
      this.editingProfile = false;
      return;
    }

    // Route re-entries shortly after a successful fetch need no new GET.
    if (
      !force &&
      this.profile &&
      this.profileToken === token &&
      Date.now() - this.lastLoadedAt < PROFILE_REFRESH_INTERVAL_MS
    ) {
      this.loading = false;
      return;
    }

    // If the view re-enters while a GET is running, reuse that request.
    if (this.activeLoad?.token === token) {
      return this.activeLoad.promise;
    }

    const version = ++this.loadVersion;
    const startedAt = performance.now();

    // Only show the full-page spinner if no profile exists yet.
    // Cached information stays visible during background revalidation.
    this.loading = this.profile === null;
    this.errorMessage = '';

    const promise = this.performProfileRequest(token, version, startedAt);
    this.activeLoad = { token, version, promise };
    return promise;
  }

  private async performProfileRequest(
    token: string,
    version: number,
    startedAt: number
  ): Promise<void> {
    try {
      // Reuse the existing AuthService endpoint, rather than maintaining a
      // separate base URL in this page.
      const response: AccountResponse = await firstValueFrom(
        this.authService.getProfile().pipe(timeout(12000))
      );

      if (
        this.destroyed ||
        this.loggingOut ||
        version !== this.loadVersion ||
        token !== this.getSessionToken()
      ) return;

      if (response.success === false) {
        throw new Error(response.message || 'Unable to load your account.');
      }

      const user = this.parseProfile(response);
      if (!user) {
        throw new Error('The account service returned incomplete profile information.');
      }

      if (user.role && user.role !== 'resident') {
        throw new Error('This page is available to resident accounts only.');
      }

      const loadedAt = Date.now();
      this.applyViewUpdate(() => {
        this.profile = user;
        this.profileToken = token;
        this.lastLoadedAt = loadedAt;
        this.errorMessage = '';
        lastProfileSnapshot = { token, profile: user, loadedAt };
      });

      console.info(
        '[PawRescue My Account] Profile loaded in',
        Math.round(performance.now() - startedAt),
        'ms'
      );
    } catch (error: any) {
      if (
        this.destroyed ||
        this.loggingOut ||
        version !== this.loadVersion ||
        token !== this.getSessionToken()
      ) return;

      this.applyViewUpdate(() => {
        if (error?.status === 401 || error?.status === 403) {
          // Invalid or forbidden sessions must never keep displaying old data.
          this.profile = null;
          this.profileToken = null;
          this.lastLoadedAt = 0;
          lastProfileSnapshot = null;
          this.editingProfile = false;
          this.editError = '';
        }

        this.errorMessage = error?.status === 401
          ? 'Your session has expired. Please log in again.'
          : error?.status === 403
            ? 'This page is available to resident accounts only.'
            : error?.name === 'TimeoutError'
              ? 'Loading your account took too long. Check your connection and refresh.'
              : error?.error?.message || error?.message ||
                'Unable to load your account. Please try again.';
      });

      console.warn(
        '[PawRescue My Account] Profile request failed after',
        Math.round(performance.now() - startedAt),
        'ms'
      );
    } finally {
      if (this.activeLoad?.version === version) {
        this.activeLoad = null;
      }

      if (!this.destroyed && version === this.loadVersion) {
        this.applyViewUpdate(() => { this.loading = false; });
      }
    }
  }

  // =====================================
  // EDIT RESIDENT PROFILE
  // =====================================
  // Do not try to infer first and last names by splitting full_name:
  // names may contain spaces and the backend now returns the saved parts.
  async openEditProfile(): Promise<void> {
    if (this.destroyed || this.loggingOut || this.savingProfile || !this.profile) return;

    // Old in-memory snapshots may predate the new me.php fields.
    if (!this.profile.first_name?.trim() || !this.profile.last_name?.trim()) {
      await this.fetchProfile(true);
    }

    if (this.destroyed || !this.profile || this.loggingOut) return;

    if (!this.profile.first_name?.trim() || !this.profile.last_name?.trim()) {
      this.applyViewUpdate(() => {
        this.editError = 'Your name details are not available yet. Refresh your profile and try again.';
      });
      return;
    }

    this.applyViewUpdate(() => {
      this.editForm = {
        first_name: this.profile!.first_name!.trim(),
        middle_name: (this.profile!.middle_name ?? '').trim(),
        last_name: this.profile!.last_name!.trim(),
        username: (this.profile!.username ?? '').trim(),
        contact_number: (this.profile!.contact_number ?? '').trim()
      };
      this.editError = '';
      this.editSuccess = '';
      this.editingProfile = true;
    });
  }

  cancelEditProfile(): void {
    if (this.destroyed || this.savingProfile) return;

    this.applyViewUpdate(() => {
      this.editingProfile = false;
      this.editError = '';
    });
  }

  private validateEditForm(data: UpdateProfileRequest): string | null {
    const firstName = data.first_name;
    const middleName = data.middle_name;
    const lastName = data.last_name;

    if (!firstName || !lastName || !data.username || !data.contact_number) {
      return 'Please complete all required profile fields.';
    }

    if ([firstName, middleName, lastName].some(name => /[\x00-\x1F\x7F]/.test(name))) {
      return 'Names must not contain line breaks or control characters.';
    }

    const length = (value: string): number => Array.from(value).length;

    if ([firstName, middleName, lastName].some(name => length(name) > 100)) {
      return 'Each name field must not exceed 100 characters.';
    }

    const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ');
    if (length(fullName) > 150) {
      return 'Combined full name must not exceed 150 characters.';
    }

    if (!/^[a-zA-Z0-9_]{3,50}$/.test(data.username)) {
      return 'Username must be 3–50 characters using only letters, numbers, or underscores.';
    }

    if (!/^\+?[0-9]{10,15}$/.test(data.contact_number)) {
      return 'Enter a valid contact number with 10–15 digits (an optional leading + is allowed).';
    }

    return null;
  }

  // =====================================
  // INSTANT PROFILE SAVE (OPTIMISTIC UI)
  // =====================================
  // The user sees the proposed changes immediately, but the status message
  // clearly says that saving is still in progress. We only mark them saved
  // and update the verified cache after the backend confirms success.
  // On failure, restore the old profile and keep the entered form values.
  async saveProfile(): Promise<void> {
    if (
      this.destroyed || this.loggingOut || this.savingProfile ||
      !this.editingProfile || !this.profile
    ) return;

    const token = this.getSessionToken();
    if (!token || this.profileToken !== token) {
      this.applyViewUpdate(() => {
        this.editError = 'Your session has expired. Please log in again.';
      });
      return;
    }

    // Submit only fields supported by the existing PHP endpoint.
    const request: UpdateProfileRequest = {
      first_name: this.editForm.first_name.trim(),
      middle_name: this.editForm.middle_name.trim(),
      last_name: this.editForm.last_name.trim(),
      username: this.editForm.username.trim(),
      contact_number: this.editForm.contact_number.trim()
    };

    const validationError = this.validateEditForm(request);
    if (validationError) {
      this.applyViewUpdate(() => {
        this.editError = validationError;
      });
      return;
    }

    // Preserve the original server-confirmed account for an honest rollback.
    const previousProfile: ResidentAccountProfile = { ...this.profile };
    const sameValue = (a: string | null | undefined, b: string) =>
      (a ?? '').trim() === b;

    // No need to wait on a network request when nothing changed.
    if (
      sameValue(previousProfile.first_name, request.first_name) &&
      sameValue(previousProfile.middle_name, request.middle_name) &&
      sameValue(previousProfile.last_name, request.last_name) &&
      sameValue(previousProfile.username, request.username) &&
      sameValue(previousProfile.contact_number, request.contact_number)
    ) {
      this.applyViewUpdate(() => {
        this.editingProfile = false;
        this.editError = '';
        this.editSuccess = 'No changes to save.';
      });
      return;
    }

    const fullName = [request.first_name, request.middle_name, request.last_name]
      .filter(Boolean)
      .join(' ');
    const optimisticProfile: ResidentAccountProfile = {
      ...previousProfile,
      first_name: request.first_name,
      middle_name: request.middle_name || null,
      last_name: request.last_name,
      full_name: fullName,
      username: request.username,
      contact_number: request.contact_number
    };

    // Stop an older profile GET from overwriting this submitted change.
    ++this.loadVersion;
    this.activeLoad = null;
    const startedAt = performance.now();

    // Update the view *before* waiting for the HTTP request. The status
    // deliberately does NOT claim success until we receive confirmation.
    this.applyViewUpdate(() => {
      this.profile = optimisticProfile;
      this.loading = false;
      this.editingProfile = false;
      this.savingProfile = true;
      this.editError = '';
      this.errorMessage = '';
      this.editSuccess = 'Changes shown. Saving to your account…';
    });

    try {
      const response = await firstValueFrom(
        this.authService.updateProfile(request).pipe(timeout(15000))
      );

      // If the logged-in identity has changed, do not expose or cache data.
      if (token !== this.getSessionToken()) return;

      if (!response?.success) {
        throw new Error(response?.message || 'Unable to save profile changes.');
      }

      const updatedProfile = this.parseProfile(response);
      if (
        !updatedProfile ||
        updatedProfile.id !== previousProfile.id ||
        (updatedProfile.role && updatedProfile.role !== 'resident')
      ) {
        throw new Error('The server returned invalid updated account information.');
      }

      // update_profile.php does not provide barangay; retain its former value.
      const savedProfile: ResidentAccountProfile = {
        ...updatedProfile,
        barangay: updatedProfile.barangay ?? previousProfile.barangay ?? null
      };
      const loadedAt = Date.now();

      // Only verified server data enters the shared in-memory snapshot.
      lastProfileSnapshot = { token, profile: savedProfile, loadedAt };

      if (!this.destroyed) {
        this.applyViewUpdate(() => {
          this.profile = savedProfile;
          this.profileToken = token;
          this.lastLoadedAt = loadedAt;
          this.editingProfile = false;
          this.editError = '';
          this.editSuccess = response.message || 'Profile updated successfully.';
        });
      }

      console.info(
        '[PawRescue My Account] Profile saved in',
        Math.round(performance.now() - startedAt),
        'ms'
      );
    } catch (error: any) {
      if (token !== this.getSessionToken()) return;

      // The HTTP request failed, so discard the optimistic display.
      // Retain the entered editForm values to make correction/retry easy.
      lastProfileSnapshot = { token, profile: previousProfile, loadedAt: this.lastLoadedAt };

      if (!this.destroyed) {
        this.applyViewUpdate(() => {
          this.profile = previousProfile;
          this.editSuccess = '';
          this.editError = error?.status === 401
            ? 'Your session has expired. Please log in again.'
            : error?.status === 403
              ? 'This resident account cannot be edited.'
              : error?.name === 'TimeoutError'
                ? 'The save could not be confirmed. Your previous details are shown. Refresh to check what is saved before trying again.'
                : error?.error?.message || error?.message ||
                  'Unable to save your profile. Please try again.';

          if (error?.status === 401 || error?.status === 403) {
            this.profile = null;
            this.profileToken = null;
            this.lastLoadedAt = 0;
            lastProfileSnapshot = null;
            this.editingProfile = false;
            this.errorMessage = error?.status === 401
              ? 'Your session has expired. Please log in again.'
              : 'This resident account cannot be edited.';
          } else {
            // For an uncertain timeout allow Refresh from the summary,
            // otherwise reopen the form with the resident's entered values.
            this.editingProfile = error?.name !== 'TimeoutError';
          }
        });
      }

      console.warn(
        '[PawRescue My Account] Profile save was not confirmed after',
        Math.round(performance.now() - startedAt),
        'ms'
      );
    } finally {
      if (!this.destroyed) {
        this.applyViewUpdate(() => {
          this.savingProfile = false;
        });
      }
    }
  }

  get displayName(): string {
    return this.profile?.full_name?.trim() || 'My Account';
  }

  get initials(): string {
    const name = this.profile?.full_name?.trim() || '';
    if (!name) return '?';
    return name.split(/\s+/).slice(0, 2).map(word => word[0].toUpperCase()).join('');
  }

  goBack(): void {
    this.router.navigateByUrl('/home');
  }

  goToLogin(): void {
    this.router.navigateByUrl('/login', { replaceUrl: true });
  }

  async logout(): Promise<void> {
    if (this.destroyed || this.loggingOut || this.savingProfile) return;
    if (!window.confirm('Log out of PawRescue Community?')) return;

    this.applyViewUpdate(() => {
      this.loggingOut = true;
      this.logoutError = '';
    });

    try {
      // Keep the existing server-side token revocation behavior.
      const result: unknown = this.authService.logout();

      if (isObservable(result)) {
        const success = await firstValueFrom(result.pipe(timeout(15000)));
        if (success !== true) {
          throw new Error('Unable to log out. Please try again.');
        }
      } else if (result === false) {
        throw new Error('Unable to log out. Please try again.');
      }

      if (this.destroyed) return;

      // Remove both visible and in-memory profile information on logout.
      this.applyViewUpdate(() => {
        ++this.loadVersion;
        lastProfileSnapshot = null;
        this.profile = null;
        this.profileToken = null;
        this.lastLoadedAt = 0;
        this.editingProfile = false;
        this.editError = '';
        this.editSuccess = '';
      });
      await this.zone.run(() =>
        this.router.navigateByUrl('/login', { replaceUrl: true })
      );
    } catch (error: any) {
      if (this.destroyed) return;
      this.applyViewUpdate(() => {
        this.logoutError = error?.name === 'TimeoutError'
          ? 'Logout took too long. Check your connection and try again.'
          : error?.message || 'Unable to log out. Please try again.';
      });
    } finally {
      if (!this.destroyed) {
        this.applyViewUpdate(() => { this.loggingOut = false; });
      }
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    ++this.loadVersion;
    this.activeLoad = null;
  }
}
