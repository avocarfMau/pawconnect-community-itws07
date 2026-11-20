import { CommonModule } from '@angular/common';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import {
  ChangeDetectorRef,
  Component,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  inject
} from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { NavigationEnd, Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  alertCircleOutline,
  checkmarkCircleOutline,
  chevronForwardOutline,
  documentTextOutline,
  heartOutline,
  homeOutline,
  pawOutline,
  timeOutline
} from 'ionicons/icons';
import { filter, forkJoin, Subscription, timeout } from 'rxjs';

import { getApiBaseUrl } from '../../config/ip-config';
import { AuthService } from '../../services/auth';

// ============================================================
// PAWCONNECT — MUNICIPAL VETERINARY OFFICE STAFF DASHBOARD
//
// Displays only Total, Pending and Rescued case counts.
// The existing get_cases.php endpoint remains COMPLETELY UNCHANGED.
// No Recent Cases, Historical Cases or manual Refresh button.
//
// All totals come from each get_cases.php response's `total` field,
// NOT the number of case objects in its paginated `cases` array.
//
// Updates automatically on first visit, return to Home, app resume,
// and every 30 seconds while the Staff Dashboard is visible.
// ============================================================

type CountFilter = 'all' | 'pending' | 'rescued';

interface GetCasesCountResponse {
  success: boolean;
  message?: string;
  total: number;
}

interface DashboardCounts {
  total: number | null;
  pending: number | null;
  rescued: number | null;
}

@Component({
  selector: 'app-staff-dashboard',
  templateUrl: './staff-dashboard.page.html',
  styleUrls: ['./staff-dashboard.page.scss'],
  standalone: true,
  imports: [CommonModule, IonContent, IonIcon]
})
export class StaffDashboardPage implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);

  private readonly casesEndpoint =
    `${getApiBaseUrl().replace(/\/$/, '')}/animal_assistance/get_cases.php`;

  private readonly pollIntervalMs = 30_000;
  private readonly duplicateEntryWindowMs = 700;

  private countsSubscription?: Subscription;
  private routerSubscription?: Subscription;
  private pollTimer?: ReturnType<typeof setInterval>;
  private destroyed = false;
  private lastRequestStartedAt = 0;
  private wasDashboardRoute = false;

  loading = false;
  errorMessage = '';
  lastUpdated: Date | null = null;

  counts: DashboardCounts = {
    total: null,
    pending: null,
    rescued: null
  };

  constructor() {
    addIcons({
      alertCircleOutline,
      checkmarkCircleOutline,
      chevronForwardOutline,
      documentTextOutline,
      heartOutline,
      homeOutline,
      pawOutline,
      timeOutline
    });
  }

  ngOnInit(): void {
    this.wasDashboardRoute = this.isDashboardRoute();

    // Load on first entry even if Ionic's cached-view hook does not run.
    if (this.wasDashboardRoute) {
      this.loadDashboard();
    }

    // Covers navigation between staff tabs when pages are cached.
    this.routerSubscription = this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe(() => {
        const onDashboard = this.isDashboardRoute();

        if (onDashboard && !this.wasDashboardRoute) {
          this.lastRequestStartedAt = 0;
          this.loadDashboard();
        } else if (!onDashboard && this.wasDashboardRoute) {
          this.cancelRequest();
          this.lastRequestStartedAt = 0;
        }

        this.wasDashboardRoute = onDashboard;
      });

    // Quiet, low-frequency automatic refresh; never poll other pages.
    this.pollTimer = setInterval(() => {
      if (this.isDashboardVisible() && !this.loading) {
        this.loadDashboard();
      }
    }, this.pollIntervalMs);
  }

  // Ionic calls this when the Staff Dashboard becomes the active page.
  ionViewWillEnter(): void {
    this.loadDashboard();
  }

  ionViewWillLeave(): void {
    this.cancelRequest();
    this.lastRequestStartedAt = 0;
  }

  // Reload when returning to the app from background/another tab.
  @HostListener('document:visibilitychange')
  onVisibilityChange(): void {
    if (this.isDashboardVisible()) {
      this.loadDashboard();
    }
  }

  @HostListener('document:resume')
  onAppResume(): void {
    if (this.isDashboardVisible()) {
      this.loadDashboard();
    }
  }

  private isDashboardRoute(): boolean {
    return this.router.url.split(/[?#]/)[0] === '/staff-dashboard';
  }

  private isDashboardVisible(): boolean {
    return !this.destroyed &&
      this.isDashboardRoute() &&
      (typeof document === 'undefined' || document.visibilityState === 'visible');
  }

  private getCasesCount(
    status: CountFilter,
    token: string,
    requestTime: number
  ) {
    // The existing endpoint always computes its `total` separately from
    // pagination. limit=1 minimizes unnecessary case details transferred.
    const params = new HttpParams()
      .set('status', status)
      .set('limit', '1')
      .set('offset', '0')
      .set('_t', String(requestTime));

    return this.http.get<GetCasesCountResponse>(this.casesEndpoint, {
      headers: new HttpHeaders({ Authorization: `Bearer ${token}` }),
      params
    });
  }

  // Public to preserve existing calls, though the Refresh button is gone.
  loadDashboard(): void {
    if (this.destroyed || !this.isDashboardRoute()) {
      return;
    }

    const token = this.auth.getToken();
    if (!token) {
      this.resetCounts();
      void this.router.navigateByUrl('/login', { replaceUrl: true });
      return;
    }

    const now = Date.now();

    // Angular and Ionic entry hooks can fire together. One request group
    // per entry avoids redundant traffic but never prevents later refreshes.
    if (
      now - this.lastRequestStartedAt < this.duplicateEntryWindowMs ||
      this.loading
    ) {
      return;
    }

    this.lastRequestStartedAt = now;

    this.applyViewUpdate(() => {
      this.loading = true;
      this.errorMessage = '';
    });

    // Three status-filtered requests, using the SAME existing endpoint.
    // forkJoin updates all three cards together once every request succeeds.
    this.countsSubscription = forkJoin({
      all: this.getCasesCount('all', token, now),
      pending: this.getCasesCount('pending', token, now),
      rescued: this.getCasesCount('rescued', token, now)
    }).pipe(timeout(15000)).subscribe({
      next: (results) => {
        if (!this.isCurrentSession(token)) {
          return;
        }

        const total = results.all.total;
        const pending = results.pending.total;
        const rescued = results.rescued.total;

        if (
          !results.all.success ||
          !results.pending.success ||
          !results.rescued.success ||
          !this.isValidCount(total) ||
          !this.isValidCount(pending) ||
          !this.isValidCount(rescued) ||
          pending + rescued > total
        ) {
          this.applyViewUpdate(() => {
            this.loading = false;
            this.errorMessage = 'The server returned incomplete case statistics.';
          });
          return;
        }

        this.applyViewUpdate(() => {
          this.counts = { total, pending, rescued };
          this.lastUpdated = new Date();
          this.loading = false;
          this.errorMessage = '';
        });
      },
      error: (error: unknown) => {
        if (!this.isCurrentSession(token)) {
          return;
        }

        const httpError = error as { status?: number };
        if (httpError?.status === 401 || httpError?.status === 403) {
          this.resetCounts();
          this.cancelRequest();
          void this.router.navigateByUrl('/login', { replaceUrl: true });
          return;
        }

        // Preserve the last verified values on temporary failures.
        this.applyViewUpdate(() => {
          this.loading = false;
          this.errorMessage = httpError?.status === 0
            ? 'Cannot connect to the server. The dashboard will retry automatically.'
            : error instanceof Error && error.name === 'TimeoutError'
              ? 'Loading timed out. The dashboard will retry automatically.'
              : 'Unable to update case statistics. The dashboard will retry automatically.';
        });
      }
    });
  }

  private isValidCount(value: unknown): value is number {
    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0;
  }

  private isCurrentSession(token: string): boolean {
    return !this.destroyed &&
      this.isDashboardRoute() &&
      this.auth.getToken() === token;
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

  private cancelRequest(): void {
    this.countsSubscription?.unsubscribe();
    this.countsSubscription = undefined;
    if (this.loading && !this.destroyed) {
      this.applyViewUpdate(() => {
        this.loading = false;
      });
    }
  }

  private resetCounts(): void {
    this.applyViewUpdate(() => {
      this.counts = { total: null, pending: null, rescued: null };
      this.lastUpdated = null;
      this.loading = false;
    });
  }

  private tapFeedback(): void {
    void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {
      // Haptics may be unavailable on some devices; navigation still works.
    });
  }

  openAnimalAssistance(): void {
    this.tapFeedback();
    void this.router.navigateByUrl('/staff-animal-assistance');
  }

  openMyAssistedCases(): void {
    this.tapFeedback();
    void this.router.navigateByUrl('/staff-my-assisted-cases');
  }

  openMyAccount(): void {
    this.tapFeedback();
    void this.router.navigateByUrl('/staff-my-account');
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.countsSubscription?.unsubscribe();
    this.routerSubscription?.unsubscribe();
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}
