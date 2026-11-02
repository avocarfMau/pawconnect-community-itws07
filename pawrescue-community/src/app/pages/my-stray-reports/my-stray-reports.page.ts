import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { Subscription } from 'rxjs';
import {
  StrayReport,
  StrayReportStatus,
  StrayAssistanceReason,
  StrayReportsService,
} from '../../services/stray-reports';

// ============================================================
// PAWRESCUE COMMUNITY - MY STRAY REPORTS
// src/app/pages/my-stray-reports/my-stray-reports.page.ts
// Uses the existing stray/get_my_reports.php API.
// Report cards navigate to /stray-report-details/:id (no dropdown).
// ============================================================

@Component({
  selector: 'app-my-stray-reports',
  standalone: true,
  imports: [
    CommonModule,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonButton,
    IonSpinner,
  ],
  templateUrl: './my-stray-reports.page.html',
  styleUrls: ['./my-stray-reports.page.scss'],
})
export class MyStrayReportsPage implements OnInit, OnDestroy {
  private readonly strayReportsService = inject(StrayReportsService);
  private readonly router = inject(Router);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private requestSubscription?: Subscription;
  private readonly pageSize = 10;
  private initialized = false;
  private readonly failedPhotoUrls = new Set<string>();

  reports: StrayReport[] = [];
  total = 0;
  hasMore = false;
  hasLoaded = false;
  isLoading = false;
  isLoadingMore = false;
  errorMessage = '';

  ngOnInit(): void {
    this.refreshReports();
  }

  // Ionic keeps pages alive in its router outlet; refresh on return.
  ionViewWillEnter(): void {
    if (this.initialized && !this.isLoading) {
      this.refreshReports();
    }
  }

  refreshReports(): void {
    this.requestSubscription?.unsubscribe();
    this.reports = [];
    this.total = 0;
    this.hasMore = false;
    this.errorMessage = '';
    this.isLoading = true;
    this.isLoadingMore = false;
    this.failedPhotoUrls.clear();
    this.changeDetector.markForCheck();

    this.requestSubscription = this.strayReportsService.getMyReports(this.pageSize, 0)
      .subscribe({
        next: (response) => {
          this.isLoading = false;
          this.hasLoaded = true;
          this.initialized = true;
          if (!response.success) {
            this.errorMessage = response.message || 'Unable to retrieve your reports.';
            this.changeDetector.markForCheck();
            return;
          }
          this.reports = response.reports;
          this.total = response.total;
          this.hasMore = response.has_more;
          this.changeDetector.markForCheck();
        },
        error: (error: HttpErrorResponse) => {
          this.isLoading = false;
          this.hasLoaded = true;
          this.initialized = true;
          this.errorMessage = this.formatError(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  loadMore(): void {
    if (this.isLoading || this.isLoadingMore || !this.hasMore) return;

    this.errorMessage = '';
    this.isLoadingMore = true;
    this.changeDetector.markForCheck();
    this.requestSubscription = this.strayReportsService
      .getMyReports(this.pageSize, this.reports.length)
      .subscribe({
        next: (response) => {
          this.isLoadingMore = false;
          if (!response.success) {
            this.errorMessage = response.message || 'Unable to load more reports.';
            this.changeDetector.markForCheck();
            return;
          }
          const existingIds = new Set(this.reports.map((report) => report.id));
          this.reports = [
            ...this.reports,
            ...response.reports.filter((report) => !existingIds.has(report.id)),
          ];
          this.total = response.total;
          this.hasMore = response.has_more;
          this.changeDetector.markForCheck();
        },
        error: (error: HttpErrorResponse) => {
          this.isLoadingMore = false;
          this.errorMessage = this.formatError(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  retry(): void {
    if (this.reports.length > 0) {
      this.loadMore();
    } else {
      this.refreshReports();
    }
  }

  createReport(): void {
    void this.router.navigateByUrl('/report-stray');
  }

  // Navigate to the dedicated report details page; do not expand the list card.
  viewReportDetails(reportId: number): void {
    if (!Number.isSafeInteger(reportId) || reportId <= 0) return;
    void this.router.navigate(['/stray-report-details', reportId]);
  }

  // Compatibility with the current HTML until the next HTML update.
  // The existing button invokes toggleDetails(), so forward it to the new page.
  toggleDetails(reportId: number): void {
    this.viewReportDetails(reportId);
  }

  // Keep the old template valid without opening any accordion content.
  isExpanded(_reportId: number): boolean {
    return false;
  }

  coverUrl(report: StrayReport): string | null {
    const url = report.cover_photo_url;
    return url && !this.failedPhotoUrls.has(url) ? url : null;
  }

  hasPhotoFailed(url: string): boolean {
    return this.failedPhotoUrls.has(url);
  }

  photoFailed(url: string): void {
    this.failedPhotoUrls.add(url);
    this.changeDetector.markForCheck();
  }

  animalLabel(report: StrayReport): string {
    return report.animal_type === 'dog' ? 'Dog' : 'Cat';
  }

  reasonLabel(reason: StrayAssistanceReason): string {
    const labels: Record<StrayAssistanceReason, string> = {
      injured: 'Injured',
      sick: 'Sick',
      trapped: 'Trapped',
      aggressive: 'Aggressive / safety concern',
      abandoned: 'Possibly abandoned',
      roaming: 'Roaming / unattended',
      other: 'Other concern',
    };
    return labels[reason] ?? reason;
  }

  statusLabel(status: StrayReportStatus): string {
    const labels: Record<StrayReportStatus, string> = {
      pending: 'Pending',
      under_review: 'Under Review',
      in_progress: 'In Progress',
      resolved: 'Resolved',
      rejected: 'Rejected',
    };
    return labels[status] ?? status;
  }

  displayDateTime(value: string | null): string {
    if (!value) return 'Not available';
    // Show the timestamp as recorded by the server; avoid browser timezone changes.
    return value.replace('T', ' ').slice(0, 16);
  }

  trackByReportId(_index: number, report: StrayReport): number {
    return report.id;
  }

  trackByPhotoId(_index: number, photo: { id: number }): number {
    return photo.id;
  }

  private formatError(error: HttpErrorResponse): string {
    if (error.status === 0) {
      return 'Cannot connect to the PawRescue server. Check XAMPP and your API network address.';
    }
    if (error.status === 401 || error.status === 403) {
      return 'Your session has expired or access was denied. Please log in again.';
    }
    return typeof error.error?.message === 'string'
      ? error.error.message
      : 'Unable to retrieve reports. Please try again.';
  }

  ngOnDestroy(): void {
    this.requestSubscription?.unsubscribe();
  }
}
