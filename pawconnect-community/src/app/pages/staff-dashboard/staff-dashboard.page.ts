import { CommonModule } from '@angular/common';
import { Component, OnDestroy, inject } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Router } from '@angular/router';
import { IonContent, IonIcon, IonSpinner } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  pawOutline,
  heartOutline,
  documentTextOutline,
  timeOutline,
  pulseOutline,
  checkmarkCircleOutline,
  chevronForwardOutline,
  refreshOutline,
  homeOutline,
  alertCircleOutline,
  locationOutline
} from 'ionicons/icons';
import { forkJoin, Subscription } from 'rxjs';

import { getApiBaseUrl } from '../../config/ip-config';

// =====================================
// PAWCONNECT - STAFF DASHBOARD
//  Office Staff only.
// Its route must use staffGuard in app.routes.ts.
// =====================================

type AssistanceStatus =
  | 'pending'
  | 'under_review'
  | 'in_progress'
  | 'resolved';

interface DashboardAssistanceCase {
  id: number;
  found_report_id: number;
  animal_type: 'dog' | 'cat';
  pet_name: string | null;
  assistance_reason: string;
  status: AssistanceStatus;
  location_address: string;
  created_at: string;
}

interface GetCasesResponse {
  success: boolean;
  message: string;
  total: number;
  cases: DashboardAssistanceCase[];
}

interface DashboardCounts {
  total: number | null;
  pending: number | null;
  inProgress: number | null;
  resolved: number | null;
}

@Component({
  selector: 'app-staff-dashboard',
  templateUrl: './staff-dashboard.page.html',
  styleUrls: ['./staff-dashboard.page.scss'],
  standalone: true,
  imports: [CommonModule, IonContent, IonIcon, IonSpinner]
})
export class StaffDashboardPage implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  // Uses the staff-only endpoint already created in Phase 3.
  private readonly casesEndpoint =
    `${getApiBaseUrl()}/animal_assistance/get_cases.php`;

  private dashboardSubscription?: Subscription;

  loading = false;
  errorMessage = '';
  lastUpdated: Date | null = null;

  counts: DashboardCounts = {
    total: null,
    pending: null,
    inProgress: null,
    resolved: null
  };

  recentCases: DashboardAssistanceCase[] = [];

  constructor() {
    addIcons({
      pawOutline,
      heartOutline,
      documentTextOutline,
      timeOutline,
      pulseOutline,
      checkmarkCircleOutline,
      chevronForwardOutline,
      refreshOutline,
      homeOutline,
      alertCircleOutline,
      locationOutline
    });
  }

  // Ionic may keep this component alive when navigating away.
  // Refresh every time staff return to the dashboard.
  ionViewWillEnter(): void {
    this.loadDashboard();
  }

  private getHeaders(): HttpHeaders {
    // Keep the existing token key for backward compatibility.
    const token = sessionStorage.getItem('pawrescue_token') || '';
    return new HttpHeaders({ Authorization: `Bearer ${token}` });
  }

  private getCases(
    status: AssistanceStatus | 'all',
    limit: number
  ) {
    const params = new HttpParams()
      .set('status', status)
      .set('limit', String(limit))
      .set('offset', '0');

    return this.http.get<GetCasesResponse>(this.casesEndpoint, {
      headers: this.getHeaders(),
      params
    });
  }

  loadDashboard(): void {
    if (this.loading) {
      return;
    }

    this.dashboardSubscription?.unsubscribe();
    this.loading = true;
    this.errorMessage = '';

    // Each response contains an accurate server-side total.
    // Do not count the first page locally: there may be more cases.
    this.dashboardSubscription = forkJoin({
      all: this.getCases('all', 5),
      pending: this.getCases('pending', 1),
      inProgress: this.getCases('in_progress', 1),
      resolved: this.getCases('resolved', 1)
    }).subscribe({
      next: (result) => {
        this.loading = false;

        if (
          !result.all.success ||
          !result.pending.success ||
          !result.inProgress.success ||
          !result.resolved.success
        ) {
          this.errorMessage = 'Unable to load the latest assistance cases.';
          return;
        }

        this.counts = {
          total: result.all.total,
          pending: result.pending.total,
          inProgress: result.inProgress.total,
          resolved: result.resolved.total
        };

        this.recentCases = Array.isArray(result.all.cases)
          ? result.all.cases
          : [];
        this.lastUpdated = new Date();
      },
      error: (error) => {
        this.loading = false;
        console.error('[PawConnect Staff Dashboard]', error);

        if (error?.status === 401 || error?.status === 403) {
          // Staff-only access is also enforced by PHP and staffGuard.
          void this.router.navigateByUrl('/login');
          return;
        }

        this.errorMessage =
          'Could not load assistance cases. Check your connection and try again.';
      }
    });
  }

  refreshDashboard(): void {
    this.loadDashboard();
  }

  // These pages/routes will be added after the staff dashboard files.
  openAnimalAssistance(): void {
    void this.router.navigateByUrl('/staff-animal-assistance');
  }

  openCase(caseId: number): void {
    if (!Number.isInteger(caseId) || caseId <= 0) {
      return;
    }

    void this.router.navigate(['/staff-animal-assistance', caseId]);
  }

  getStatusLabel(status: AssistanceStatus): string {
    switch (status) {
      case 'pending': return 'Pending';
      case 'under_review': return 'Under Review';
      case 'in_progress': return 'In Progress';
      case 'resolved': return 'Resolved';
      default: return 'Unknown';
    }
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

  trackCase(_index: number, item: DashboardAssistanceCase): number {
    return item.id;
  }

  ngOnDestroy(): void {
    this.dashboardSubscription?.unsubscribe();
  }
}
