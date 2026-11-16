import { CommonModule } from '@angular/common';
import { Component, OnDestroy, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Router } from '@angular/router';
import { IonContent, IonIcon, IonSpinner, IonHeader, IonToolbar } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  pawOutline,
  refreshOutline,
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
// Route to add later: /staff-animal-assistance (staffGuard)
// Companion files to add next:
//   staff-animal-assistance.page.html
//   staff-animal-assistance.page.scss
// ============================================================

export type AssistanceStatus =
  | 'pending'
  | 'under_review'
  | 'in_progress'
  | 'resolved';

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
export class StaffAnimalAssistancePage implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  private readonly endpoint = `${getApiBaseUrl()}/animal_assistance/get_cases.php`;
  private readonly pageSize = 20; // The PHP API accepts 1-50 per request.

  private requestSubscription?: Subscription;
  private requestVersion = 0;

  readonly filters: { value: AssistanceFilter; label: string }[] = [
    { value: 'all', label: 'All Cases' },
    { value: 'pending', label: 'Pending' },
    { value: 'under_review', label: 'Under Review' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'resolved', label: 'Resolved' }
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
      refreshOutline,
      chevronForwardOutline,
      locationOutline,
      alertCircleOutline,
      documentTextOutline
    });
  }

  // Ionic may keep pages alive; always refresh after returning from
  // a case details page, since a staff member may have updated it.
  ionViewWillEnter(): void {
    this.refreshCases();
  }

  setFilter(filter: AssistanceFilter): void {
    if (this.selectedFilter === filter) {
      return;
    }
    this.selectedFilter = filter;
    // Do not display cases from the previous filter while this one loads.
    this.cases = [];
    this.totalCases = 0;
    this.hasMore = false;
    this.hasLoaded = false;
    this.refreshCases();
  }

  refreshCases(): void {
    this.fetchCases(false);
  }

  loadMore(): void {
    if (this.loading || this.loadingMore || !this.hasMore) {
      return;
    }
    this.fetchCases(true);
  }

  private fetchCases(append: boolean): void {
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

    this.errorMessage = '';
    this.loading = !append;
    this.loadingMore = append;

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
        if (currentVersion !== this.requestVersion ||
            requestedFilter !== this.selectedFilter) {
          return;
        }

        this.loading = false;
        this.loadingMore = false;

        if (!response.success || !Array.isArray(response.cases)) {
          this.errorMessage = response.message || 'Unable to load assistance cases.';
          return;
        }

        // A fresh filter/refresh replaces the list. Load More appends
        // only IDs not already shown, avoiding duplicate cards.
        const incoming = response.cases;
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
      },
      error: (error: HttpErrorResponse) => {
        if (currentVersion !== this.requestVersion) {
          return;
        }
        this.loading = false;
        this.loadingMore = false;
        this.hasLoaded = true;

        if (error.status === 401 || error.status === 403) {
          // Server-side permission checks remain authoritative.
          void this.router.navigateByUrl('/login', { replaceUrl: true });
          return;
        }

        this.errorMessage = error.status === 0
          ? 'Cannot connect to the server. Check your connection and try again.'
          : 'Unable to retrieve assistance cases. Please try again.';
      }
    });
  }

  openCase(caseId: number): void {
    if (!Number.isInteger(caseId) || caseId <= 0) {
      return;
    }
    // The staff case details page will be implemented after the list.
    void this.router.navigate(['/staff-animal-assistance', caseId]);
  }

  backToDashboard(): void {
    void this.router.navigateByUrl('/staff-dashboard');
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
      resolved: 'Resolved'
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
    this.requestVersion++;
    this.requestSubscription?.unsubscribe();
  }
}
