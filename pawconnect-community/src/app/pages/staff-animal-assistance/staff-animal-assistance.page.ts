import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Router } from '@angular/router';
import { IonContent, IonIcon, IonSpinner } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  pawOutline,
  chevronForwardOutline,
  locationOutline,
  alertCircleOutline,
  documentTextOutline
} from 'ionicons/icons';
import { Subscription } from 'rxjs';

import { getApiBaseUrl } from '../../config/ip-config';
import { AuthService } from '../../services/auth';

// ============================================================
// PAWCONNECT - ANIMAL ASSISTANCE MANAGEMENT (STAFF CASE LIST)
// ============================================================
// Cases originate ONLY from resident Found Pet reports marked
// as requiring assistance. The original Found Pet workflow is
// independent of this staff-only case management workflow.
//
// PHP endpoint: /animal_assistance/get_cases.php
// Route: /staff-animal-assistance (staffGuard)
// Loads All automatically; each status tab loads in one tap.
// The existing get_cases.php endpoint is unchanged.
// ============================================================

export type AssistanceStatus =
  | 'pending'
  | 'under_review'
  | 'in_progress'
  | 'resolved'
  | 'rescued';

export type AssistanceFilter = AssistanceStatus | 'all';

export interface StaffAssistanceCase {
  id: number;
  found_report_id: number;
  assistance_reason: string;
  assistance_details: string | null;
  status: AssistanceStatus;
  staff_notes: string | null;
  reviewed_at: string | null;
  resolved_at: string | null;
  // Rescue documentation is returned by the updated staff-only get_cases.php.
  rescue_proof_path: string | null;
  rescue_note: string | null;
  rescued_at: string | null;
  rescued_by_user_id: number | null;
  created_at: string;
  updated_at: string;

  report_type: 'found';
  animal_type: string;
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

interface GetCasesResponse {
  success: boolean;
  message: string;
  status_filter: AssistanceFilter;
  total: number;
  count: number;
  limit: number;
  offset: number;
  has_more: boolean;
  cases: StaffAssistanceCase[];
}

@Component({
  selector: 'app-staff-animal-assistance',
  templateUrl: './staff-animal-assistance.page.html',
  styleUrls: ['./staff-animal-assistance.page.scss'],
  standalone: true,
  imports: [ CommonModule, IonContent, IonIcon, IonSpinner]
})
export class StaffAnimalAssistancePage implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);

  private readonly apiBaseUrl = getApiBaseUrl().replace(/\/$/, '');
  private readonly endpoint = `${this.apiBaseUrl}/animal_assistance/get_cases.php`;
  private readonly pageSize = 20; // The PHP API accepts 1-50 per request.

  private requestSubscription?: Subscription;
  private requestVersion = 0;
  private destroyed = false;
  private firstEntry = true;

  readonly filters: { value: AssistanceFilter; label: string }[] = [
    { value: 'all', label: 'All Cases' },
    { value: 'pending', label: 'Pending' },
    { value: 'rescued', label: 'Rescued' }
  ];

  selectedFilter: AssistanceFilter = 'all';
  cases: StaffAssistanceCase[] = [];
  totalCases = 0;
  hasMore = false;
  loading = false;
  loadingMore = false;
  errorMessage = '';
  lastUpdated: Date | null = null;
  hasLoaded = false;

  constructor() {
    addIcons({
      arrowBackOutline,
      pawOutline,
          chevronForwardOutline,
      locationOutline,
      alertCircleOutline,
      documentTextOutline
    });
  }

  // Angular creates this page before Ionic fires its enter event.
  // Fetch on the FIRST visit even if the Ionic enter hook doesn't fire.
  ngOnInit(): void {
    this.refreshCases();
  }

  // Ionic caches pages when navigating to Case Details. Revalidate on return.
  // Avoid firing a duplicate GET during the first ngOnInit/enter pair.
  ionViewWillEnter(): void {
    if (this.firstEntry) {
      this.firstEntry = false;
      return;
    }
    this.refreshCases();
  }

  ionViewWillLeave(): void {
    // Responses from the list must not update an inactive page.
    this.cancelPendingRequest();
  }

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
    this.requestSubscription?.unsubscribe();
    this.requestSubscription = undefined;
    this.loading = false;
    this.loadingMore = false;
  }

  setFilter(filter: AssistanceFilter): void {
    if (this.destroyed) return;

    // Selecting All/Pending/Rescued should require only ONE tap.
    // A repeated tap on the active filter can retry a failed or empty load.
    if (this.selectedFilter === filter && this.hasLoaded && !this.errorMessage) {
      return;
    }

    this.cancelPendingRequest();
    this.updateView(() => {
      this.selectedFilter = filter;
      this.cases = [];
      this.totalCases = 0;
      this.hasMore = false;
      this.hasLoaded = false;
      this.errorMessage = '';
      this.lastUpdated = null;
    });
    this.refreshCases();
  }

  refreshCases(): void {
    if (this.destroyed) return;
    this.fetchCases(false);
  }

  loadMore(): void {
    if (this.loading || this.loadingMore || !this.hasMore) {
      return;
    }
    this.fetchCases(true);
  }

  private fetchCases(append: boolean): void {
    if (this.destroyed) return;
    const token = this.authService.getToken();
    if (!token) {
      void this.router.navigateByUrl('/login', { replaceUrl: true });
      return;
    }

    // Cancel any earlier request; ignore late results that belong to
    // another filter or a superseded refresh.
    this.requestSubscription?.unsubscribe();
    const currentVersion = ++this.requestVersion;
    const offset = append ? this.cases.length : 0;
    const requestedFilter = this.selectedFilter;

    this.updateView(() => {
      this.errorMessage = '';
      this.loading = !append;
      this.loadingMore = append;
    });

    const params = new HttpParams()
      .set('status', requestedFilter)
      .set('limit', String(this.pageSize))
      .set('offset', String(offset));
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });

    this.requestSubscription = this.http.get<GetCasesResponse>(this.endpoint, {
      headers,
      params
    }).subscribe({
      next: (response) => {
        if (this.destroyed || currentVersion !== this.requestVersion ||
            requestedFilter !== this.selectedFilter ||
            this.authService.getToken() !== token) {
          return;
        }

        // An Angular view update is required on some Ionic/WebView
        // configurations; otherwise the list may appear only AFTER a tap.
        this.updateView(() => {
          this.loading = false;
          this.loadingMore = false;

          if (!response?.success || !Array.isArray(response.cases)) {
            this.errorMessage = response?.message || 'Unable to load assistance cases.';
            this.hasLoaded = false;
            return;
          }

          // Each API item includes the numeric case ID used by View Details.
          // The database may store legacy /pawrescue_api/uploads/pets/... paths.
          // A Capacitor WebView cannot resolve those paths against the PHP API.
          // Normalize to the configured API URL before the existing HTML binds [src].
          const incoming = response.cases.map((item) => ({
            ...item,
            photo_path: this.resolveCasePhotoUrl(item.photo_path)
          }));
          if (append) {
            const existingIds = new Set(this.cases.map(item => item.id));
            this.cases = [
              ...this.cases,
              ...incoming.filter(item => !existingIds.has(item.id))
            ];
          } else {
            this.cases = incoming;
          }

          this.totalCases = response.total;
          this.hasMore = response.has_more;
          this.lastUpdated = new Date();
          this.hasLoaded = true;
          this.errorMessage = '';
        });
      },
      error: (error: HttpErrorResponse) => {
        if (this.destroyed || currentVersion !== this.requestVersion) return;

        this.updateView(() => {
          this.loading = false;
          this.loadingMore = false;
          this.hasLoaded = true;
          this.errorMessage = error.status === 0
            ? 'Cannot connect to the server. Check your connection and try again.'
            : error.status === 401 || error.status === 403
              ? 'Your staff session was rejected. Sign in again.'
              : 'Unable to retrieve assistance cases. Please try again.';
        });

        if (error.status === 401 || error.status === 403) {
          void this.router.navigateByUrl('/login', { replaceUrl: true });
        }
      }
    });
  }

  openCase(caseId: number): void {
    const numericId = Number(caseId);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) return;

    this.cancelPendingRequest();
    // Matches app.routes.ts: staff-animal-assistance/:id.
    // Awaiting navigation lets us surface a navigation failure rather than
    // leaving a seemingly unresponsive View Details button.
    void this.zone.run(async () => {
      try {
        const navigated = await this.router.navigateByUrl(
          `/staff-animal-assistance/${numericId}`
        );
        if (!navigated && !this.destroyed &&
            this.router.url.startsWith('/staff-animal-assistance') &&
            this.router.url === '/staff-animal-assistance') {
          this.updateView(() => {
            this.errorMessage = 'Unable to open Case Details. Please try again.';
          });
        }
      } catch (error) {
        console.error('[PawConnect] Case Details navigation failed.', error);
        this.updateView(() => {
          this.errorMessage = 'Could not open Case Details. Please try again.';
        });
      }
    });
  }

  backToDashboard(): void {
    void this.router.navigateByUrl('/staff-dashboard');
  }

  // Rebuild only expected pet-upload URLs against the API base. Accept
  // historical pawrescue_api and current pawconnect_api path prefixes while
  // refusing arbitrary external URLs or unexpected file locations.
  private resolveCasePhotoUrl(rawPath: string | null): string | null {
    if (typeof rawPath !== 'string' || !rawPath.trim()) return null;

    const normalized = rawPath.trim().replace(/\\/g, '/');
    const match = normalized.match(
      /(?:^|\/)uploads\/pets\/([a-f0-9]{32}\.(?:jpg|jpeg|png|webp))$/i
    );
    return match ? `${this.apiBaseUrl}/uploads/pets/${match[1]}` : null;
  }

  getCaseName(item: StaffAssistanceCase): string {
    const name = item.pet_name?.trim();
    if (name) {
      return name;
    }
    return item.animal_type.toLowerCase() === 'cat' ? 'Found Cat' : 'Found Dog';
  }

  getStatusLabel(status: AssistanceStatus): string {
    const labels: Record<AssistanceStatus, string> = {
      pending: 'Pending',
      under_review: 'Under Review',
      in_progress: 'In Progress',
      resolved: 'Resolved',
      rescued: 'Rescued'
    };
    return labels[status] || 'Unknown';
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

  trackCase(_index: number, item: StaffAssistanceCase): number {
    return item.id;
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.cancelPendingRequest();
  }
}
