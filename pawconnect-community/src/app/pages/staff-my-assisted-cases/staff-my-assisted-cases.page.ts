import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit, inject } from '@angular/core';
import {
  HttpClient,
  HttpErrorResponse,
  HttpHeaders,
  HttpParams
} from '@angular/common/http';
import { Router } from '@angular/router';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { IonContent, IonIcon, IonSpinner } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  alertCircleOutline,
  calendarOutline,
  checkmarkCircleOutline,
  chevronForwardOutline,
  homeOutline,
  locationOutline,
  pawOutline,
  personCircleOutline,
  refreshOutline,
  timeOutline
} from 'ionicons/icons';
import { Subscription, timeout } from 'rxjs';

import { getApiBaseUrl } from '../../config/ip-config';
import { AuthService } from '../../services/auth';

// ============================================================
// PAWCONNECT — MVO STAFF: MY ASSISTED CASES
// ============================================================
// GET /animal_assistance/get_my_assisted_cases.php?limit=20&offset=0
//
// The PHP endpoint authenticates the staff member and filters:
//   status = 'rescued' AND rescued_by_user_id = logged-in staff ID.
// Never send a client-supplied user ID to select somebody else's cases.
//
// The /staff-my-assisted-cases route is protected with staffGuard.
// This page loads on initial entry, refreshes on return, and updates Angular's
// view immediately after responses in Ionic/Capacitor.
// ============================================================

export interface MyAssistedCase {
  id: number;
  found_report_id: number;
  status: 'rescued';
  assistance_reason: string;
  assistance_details: string | null;
  staff_notes: string | null;
  rescue_note: string | null;
  rescue_proof_path: string | null;
  rescued_at: string | null;
  rescued_by_user_id: number | null;
  created_at: string;
  updated_at: string;

  report_type: 'found';
  animal_type: 'dog' | 'cat';
  pet_name: string | null;
  description: string | null;
  incident_date: string | null;
  location_address: string | null;
  latitude: number | null;
  longitude: number | null;
  photo_path: string | null;
  report_status: string;
  report_created_at: string;
  reporter_user_id: number;
  reporter_name: string;
}

interface MyAssistedCasesResponse {
  success: boolean;
  message: string;
  total: number;
  count: number;
  limit: number;
  offset: number;
  has_more: boolean;
  cases: MyAssistedCase[];
}

@Component({
  selector: 'app-staff-my-assisted-cases',
  templateUrl: './staff-my-assisted-cases.page.html',
  styleUrls: ['./staff-my-assisted-cases.page.scss'],
  standalone: true,
  imports: [CommonModule, IonContent, IonIcon, IonSpinner]
})
export class StaffMyAssistedCasesPage implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);

  private readonly endpoint =
    `${getApiBaseUrl().replace(/\/$/, '')}/animal_assistance/get_my_assisted_cases.php`;
  // Source photos are saved by the Found Pet reporting API. The database
  // may still contain an old /pawrescue_api/ path after the project rename.
  // Resolve only safe pet-upload filenames against our configured API host.
  private readonly apiBaseUrl = getApiBaseUrl().replace(/\/+$/, '');
  private readonly failedPhotoIds = new Set<number>();
  private readonly photoAttemptByCaseId = new Map<number, number>();
  private readonly pageSize = 20;

  private casesSubscription?: Subscription;
  private requestVersion = 0;
  private destroyed = false;
  private firstEntry = true;
  private loadedForToken: string | null = null;
  private nextOffset = 0;

  cases: MyAssistedCase[] = [];
  totalCases = 0;
  hasMore = false;
  hasLoaded = false;
  loading = false;
  loadingMore = false;
  errorMessage = '';
  lastUpdated: Date | null = null;

  constructor() {
    addIcons({
      alertCircleOutline,
      calendarOutline,
      checkmarkCircleOutline,
      chevronForwardOutline,
      homeOutline,
      locationOutline,
      pawOutline,
      personCircleOutline,
      refreshOutline,
      timeOutline
    });
  }

  // The first request must start even when the Ionic enter lifecycle does
  // not fire reliably for the initial navigation.
  ngOnInit(): void {
    this.refreshCases();
  }

  // Cached Ionic views do not run ngOnInit again. Refresh on return so a
  // newly rescued case appears immediately without a manual Refresh button.
  ionViewWillEnter(): void {
    if (this.firstEntry) {
      this.firstEntry = false;
      return;
    }
    this.refreshCases();
  }

  ionViewWillLeave(): void {
    this.cancelPendingRequest();
  }

  // HTTP callbacks on some mobile WebViews do not repaint immediately. All
  // asynchronous loading/result/error state changes go through this helper.
  private updateView(update: () => void): void {
    if (this.destroyed) return;
    this.zone.run(() => {
      if (this.destroyed) return;
      update();
      this.cdr.markForCheck();
      this.cdr.detectChanges();
    });
  }

  private cancelPendingRequest(): void {
    ++this.requestVersion;
    this.casesSubscription?.unsubscribe();
    this.casesSubscription = undefined;
    this.loading = false;
    this.loadingMore = false;
  }

  // Used by first-entry, return-entry, and the error state's Try Again.
  // There is deliberately no visible Refresh button in the current HTML.
  refreshCases(): void {
    if (this.destroyed) return;
    this.fetchCases(false);
  }

  loadMore(): void {
    if (this.destroyed || this.loading || this.loadingMore || !this.hasMore) {
      return;
    }
    this.fetchCases(true);
  }

  private fetchCases(append: boolean): void {
    if (this.destroyed) return;

    const token = this.authService.getToken();
    if (!token) {
      this.clearCaseData();
      void this.router.navigateByUrl('/login', { replaceUrl: true });
      return;
    }

    // Never show cached cases from another signed-in staff account.
    if (this.loadedForToken !== token) {
      this.clearCaseData();
      this.loadedForToken = token;
      append = false;
    }

    this.casesSubscription?.unsubscribe();
    const version = ++this.requestVersion;
    const requestedOffset = append ? this.nextOffset : 0;

    this.updateView(() => {
      this.errorMessage = '';
      this.loading = !append;
      this.loadingMore = append;
    });

    const params = new HttpParams()
      .set('limit', String(this.pageSize))
      .set('offset', String(requestedOffset))
      // Avoid stale cached lists after a rescue is completed.
      .set('_t', String(Date.now()));
    const headers = new HttpHeaders({
      Authorization: `Bearer ${token}`
    });

    this.casesSubscription = this.http.get<MyAssistedCasesResponse>(
      this.endpoint,
      { headers, params }
    ).pipe(timeout(15000)).subscribe({
      next: (response) => {
        if (this.destroyed || version !== this.requestVersion ||
            this.authService.getToken() !== token) {
          return;
        }

        this.updateView(() => {
          this.loading = false;
          this.loadingMore = false;
          this.hasLoaded = true;

          if (!response?.success || !Array.isArray(response.cases) ||
              !Number.isInteger(response.total) || response.total < 0) {
            if (!append) this.resetList();
            this.errorMessage = response?.message ||
              'The server returned an invalid My Assisted Cases response.';
            return;
          }

          // The PHP API is authoritative about ownership. Only accept
          // correctly shaped rescued cases for rendering; never infer
          // ownership on the client or send a staff_id in the request.
          const incoming = response.cases.filter(item =>
            item !== null &&
            Number.isSafeInteger(item.id) &&
            item.id > 0 &&
            item.status === 'rescued'
          );

          if (append) {
            const seen = new Set(this.cases.map(item => item.id));
            this.cases = [
              ...this.cases,
              ...incoming.filter(item => !seen.has(item.id))
            ];
          } else {
            this.cases = incoming;
            this.failedPhotoIds.clear();
            this.photoAttemptByCaseId.clear();
          }

          this.totalCases = response.total;
          // Count the raw returned page, not the deduplicated display list.
          this.nextOffset = requestedOffset + response.cases.length;
          this.hasMore = Boolean(response.has_more) &&
            this.nextOffset < response.total &&
            response.cases.length > 0;
          this.lastUpdated = new Date();
          this.errorMessage = '';
        });
      },
      error: (error: HttpErrorResponse | Error) => {
        if (this.destroyed || version !== this.requestVersion ||
            this.authService.getToken() !== token) {
          return;
        }

        const status = error instanceof HttpErrorResponse ? error.status : null;
        // Do not log authentication tokens or resident data.
        console.warn('[PawConnect My Assisted Cases] Load failed', {
          status,
          timeout: error?.name === 'TimeoutError'
        });

        if (status === 401 || status === 403) {
          this.updateView(() => {
            this.clearCaseData();
            this.errorMessage = 'Your staff session was rejected. Please sign in again.';
          });
          void this.router.navigateByUrl('/login', { replaceUrl: true });
          return;
        }

        this.updateView(() => {
          this.loading = false;
          this.loadingMore = false;
          this.hasLoaded = true;
          this.errorMessage = error?.name === 'TimeoutError'
            ? 'The request took too long. Check your connection and try again.'
            : status === 0
              ? 'Cannot connect to the server. Check your connection and try again.'
              : status === 404
                ? 'My Assisted Cases API was not found. Check that get_my_assisted_cases.php exists in pawconnect_api/animal_assistance/.'
                : status === 500
                  ? 'The server could not retrieve your assisted cases. Check the PHP error log.'
                  : 'Unable to load your assisted cases. Please try again.';
        });
      }
    });
  }

  private resetList(): void {
    this.failedPhotoIds.clear();
    this.photoAttemptByCaseId.clear();
    this.cases = [];
    this.totalCases = 0;
    this.hasMore = false;
    this.nextOffset = 0;
  }

  private clearCaseData(): void {
    this.casesSubscription?.unsubscribe();
    this.requestVersion += 1;
    this.loadedForToken = null;
    this.resetList();
    this.hasLoaded = false;
    this.loading = false;
    this.loadingMore = false;
    this.errorMessage = '';
    this.lastUpdated = null;
  }

  /**
   * The API returns photo_path as a stored path, NOT a browser-ready URL.
   * For example: /pawrescue_api/uploads/pets/<filename>.jpg
   * A relative /pawrescue_api URL would be requested against the wrong
   * origin/path in Ionic. Build a URL using the configured active API root.
   */
  private getPhotoCandidates(photoPath: string | null): string[] {
    if (typeof photoPath !== 'string' || !photoPath.trim()) return [];

    const normalized = photoPath.trim().replace(/\\/g, '/');
    const match = normalized.match(
      /(?:^|\/)uploads\/pets\/([a-zA-Z0-9_-]{1,128}\.(?:jpg|jpeg|png|webp))$/i
    );
    if (!match) return [];

    const filename = match[1];
    const sources = [`${this.apiBaseUrl}/uploads/pets/${filename}`];

    // Compatibility fallback: when an old upload was left in the legacy
    // XAMPP project during the PawConnect rename, try it on the same host.
    // This is only enabled for the exact known development folder mapping.
    const activeSuffix = '/pawconnect-community-itws07/pawconnect_api';
    if (this.apiBaseUrl.endsWith(activeSuffix)) {
      sources.push(
        `${this.apiBaseUrl.slice(0, -activeSuffix.length)}` +
        `/pawrescue-community-itws07/pawconnect_api/uploads/pets/${filename}`
      );
    }

    return sources;
  }

  getCasePhotoUrl(item: MyAssistedCase): string | null {
    if (this.failedPhotoIds.has(item.id)) return null;
    const sources = this.getPhotoCandidates(item.photo_path);
    const index = this.photoAttemptByCaseId.get(item.id) ?? 0;
    return sources[index] ?? null;
  }

  onCasePhotoError(item: MyAssistedCase): void {
    const sources = this.getPhotoCandidates(item.photo_path);
    const nextIndex = (this.photoAttemptByCaseId.get(item.id) ?? 0) + 1;
    this.updateView(() => {
      if (nextIndex < sources.length) {
        this.photoAttemptByCaseId.set(item.id, nextIndex);
      } else {
        this.failedPhotoIds.add(item.id);
      }
    });
  }

  getAnimalName(item: MyAssistedCase): string {
    const name = item.pet_name?.trim();
    if (name) {
      return name;
    }
    return item.animal_type === 'cat' ? 'Found Cat' : 'Found Dog';
  }

  getReasonLabel(reason: string): string {
    const labels: Record<string, string> = {
      injured: 'Injured',
      sick: 'Sick',
      trapped: 'Trapped',
      aggressive: 'Safety Concern',
      abandoned: 'Possibly Abandoned',
      roaming: 'Roaming / Unattended',
      other: 'Other Concern'
    };
    return labels[reason] || 'Animal Assistance';
  }

  trackCase(_index: number, item: MyAssistedCase): number {
    return item.id;
  }

  // Best-effort native feedback for user-initiated navigation only.
  private tapFeedback(): void {
    void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {
      // Haptics may be unavailable in a browser or on some devices.
    });
  }

  goHome(): void {
    this.tapFeedback();
    void this.router.navigateByUrl('/staff-dashboard');
  }

  // Stay within the staff-only account route.
  goAccount(): void {
    this.tapFeedback();
    void this.router.navigateByUrl('/staff-my-account');
  }

  openCase(caseId: number): void {
    if (!Number.isInteger(caseId) || caseId <= 0) {
      return;
    }
    this.tapFeedback();
    void this.router.navigate(['/staff-animal-assistance', caseId]);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.cancelPendingRequest();
  }
}
