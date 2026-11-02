import {
  Component,
  ElementRef,
  ViewChild,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
  HostListener,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
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
  pawOutline,
  calendarOutline,
  locationOutline,
  mapOutline,
  closeOutline,
  refreshOutline,
  imageOutline,
  checkmarkCircleOutline,
  createOutline,
  chevronBackOutline,
  chevronForwardOutline,
  expandOutline,
  shieldCheckmarkOutline
} from 'ionicons/icons';
import { Subscription, finalize, timeout } from 'rxjs';
import * as L from 'leaflet';
import { PetReportsService, PetReport } from '../../services/pet-reports';

type ReportFilter = 'all' | 'lost' | 'found';
type AnimalFilter = 'all' | 'dog' | 'cat';
type ReportStatusFilter = 'unresolved' | 'pending' | 'under_review' | 'in_progress' | 'resolved' | 'closed' | 'all';
@Component({
  selector: 'app-my-reports',
  templateUrl: './my-reports.page.html',
  styleUrls: ['./my-reports.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    IonContent,
    IonButton,
    IonIcon,
    IonSpinner
  ]
})
export class MyReportsPage implements OnInit, OnDestroy {
  private reportsService = inject(PetReportsService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  // =====================================
  // REPORT INFORMATION
  // =====================================
  // Fetch reports for the current Lost / Found filter, then filter statuses locally.
  private allReports: PetReport[] = [];
  reports: PetReport[] = [];
  selectedFilter: ReportFilter = 'all';
  // Client-side animal type filter; works together with report type and status.
  selectedAnimalFilter: AnimalFilter = 'all';
  // Show every report status by default (Pending, Resolved, etc.).
  selectedStatusFilter: ReportStatusFilter = 'all';
  // =====================================
  // LOADING AND ERROR STATES
  // =====================================
  loading = false;
  refreshing = false;
  errorMessage = '';
  private reportsRequest?: Subscription;
  private resolveRequest?: Subscription;
  resolvingReportId: number | null = null;
  resolveMessage = '';
  private destroyed = false;
  private requestId = 0;
  private initialLoadStarted = false;
  private firstPageEntry = true;

  // =====================================
  // READ-ONLY FOUND PET CLAIM AVAILABILITY
  // =====================================
  // This is only a status hint for the My Reports cards.
  // All claim management takes place in the separate /my-claims page.
  // The backend remains the authority for manual report resolution.
  private availabilityRequest?: Subscription;
  private restrictedFoundReportIds = new Set<number>();

  // =====================================
  // REPORT LOCATION MAP
  // =====================================
  showLocationMap = false;
  selectedReport: PetReport | null = null;
  private reportMap: L.Map | null = null;
  private reportMarker: L.Marker | null = null;
  private mapResizeTimer: ReturnType<typeof setTimeout> | null = null;
  // =====================================
  // MULTIPLE PHOTO GALLERY
  // =====================================
  // Each report remembers its selected image.
  private photoIndexes = new Map<number, number>();
  // Hide inaccessible images without hiding the report card.
  private brokenPhotoUrls = new Set<string>();
  // Full-screen gallery state.
  photoViewerReport: PetReport | null = null;
  // Separate detail view so the list stays compact on mobile.
  detailReport: PetReport | null = null;
  // Swipe state for the gallery and full-screen viewer.
  private photoTouchStartX: number | null = null;
  private photoTouchStartY: number | null = null;
  private photoTouchReportId: number | null = null;
  private lastPhotoSwipeAt = 0;
  @ViewChild('reportLocationMap')
  set reportLocationMapElement(
    element: ElementRef<HTMLDivElement> | undefined
  ) {
    if (
      element &&
      this.showLocationMap &&
      this.selectedReport &&
      !this.reportMap &&
      !this.destroyed
    ) {
      this.initializeReportMap(element.nativeElement);
    }
  }
  constructor() {
    addIcons({
      arrowBackOutline,
      pawOutline,
      calendarOutline,
      locationOutline,
      mapOutline,
      closeOutline,
      refreshOutline,
      imageOutline,
      checkmarkCircleOutline,
      createOutline,
      chevronBackOutline,
      chevronForwardOutline,
      expandOutline,
      shieldCheckmarkOutline
    });
  }
  // =====================================
  // PAGE LIFECYCLE
  // =====================================
  ngOnInit(): void {
    this.initialLoadStarted = true;
    this.loadReports();
  }

  ionViewWillEnter(): void {
    if (this.firstPageEntry) {
      this.firstPageEntry = false;
      if (!this.initialLoadStarted) {
        this.initialLoadStarted = true;
        this.loadReports();
      }
      return;
    }
    this.loadReports();
  }

  ionViewDidLeave(): void {
    ++this.requestId;
    this.reportsRequest?.unsubscribe();
    this.resolveRequest?.unsubscribe();
    this.availabilityRequest?.unsubscribe();
    this.restrictedFoundReportIds.clear();
    this.resolvingReportId = null;
    this.closePhotoViewer();
    this.closeLocationMap();
    this.detailReport = null;
    this.loading = false;
    this.refreshing = false;
  }

  // =====================================
  // LOAD MY REPORTS
  // =====================================
  loadReports(): void {
    if (this.destroyed) {
      return;
    }
    ++this.requestId;
    this.reportsRequest?.unsubscribe();
    const currentRequestId = this.requestId;
    const filter = this.selectedFilter;
    this.loading = this.reports.length === 0;
    this.refreshing = !this.loading;
    this.errorMessage = '';
    console.log('[MY REPORTS] Loading reports');
    console.log('[MY REPORTS] Selected filter:', filter);
    this.cdr.detectChanges();
    this.reportsRequest = this.reportsService
      .getMyReports(filter)
      .pipe(
        timeout(15000),
        finalize(() => {
          console.log('[MY REPORTS] Request finalized');
          if (
            this.destroyed ||
            currentRequestId !== this.requestId
          ) {
            return;
          }
          this.loading = false;
          this.refreshing = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (response) => {
          console.log('[MY REPORTS] API Response:', response);
          if (
            this.destroyed ||
            currentRequestId !== this.requestId
          ) {
            return;
          }
          if (response && response.success) {
            this.allReports = Array.isArray(response.reports)
              ? response.reports
              : [];
            this.updateVisibleReports();
            if (this.detailReport) {
              this.detailReport = this.reports.find(
                item => item.id === this.detailReport?.id
              ) ?? null;
            }
            // Recheck photos after a deliberate report refresh.
            this.brokenPhotoUrls.clear();
            // Keep an already-open photo viewer updated.
            if (this.photoViewerReport) {
              this.photoViewerReport = this.reports.find(
                item => item.id === this.photoViewerReport?.id
              ) ?? null;
            }
            this.errorMessage = '';
            this.loadFoundPetAvailability();
          } else {
            this.allReports = [];
            this.updateVisibleReports();
            this.availabilityRequest?.unsubscribe();
            this.restrictedFoundReportIds.clear();
            this.errorMessage =
              response?.message ||
              'Unable to retrieve your reports.';
          }
          this.loading = false;
          this.refreshing = false;
          this.cdr.detectChanges();
        },
        error: (error) => {
          console.error('[MY REPORTS] API Error:', error);
          if (
            this.destroyed ||
            currentRequestId !== this.requestId
          ) {
            return;
          }
          this.allReports = [];
          this.updateVisibleReports();
          this.availabilityRequest?.unsubscribe();
          this.restrictedFoundReportIds.clear();
          if (error.name === 'TimeoutError') {
            this.errorMessage =
              'Reports are taking too long to load. Please try again.';
          } else if (error.status === 401) {
            this.errorMessage =
              'Your session has expired. Please log in again.';
          } else if (error.status === 403) {
            this.errorMessage =
              'You do not have permission to view these reports.';
          } else if (error.status === 0) {
            this.errorMessage =
              'Unable to connect to the server. Check your connection.';
          } else {
            this.errorMessage =
              error.error?.message ||
              'Unable to load your reports.';
          }
          this.loading = false;
          this.refreshing = false;
          this.cdr.detectChanges();
        }
      });
  }
  // =====================================
  // FILTER REPORTS BY STATUS
  // =====================================
  // This is only a view filter. The PHP endpoint changes status when resolved.
  private updateVisibleReports(): void {
    const activeStatuses = new Set(['pending', 'under_review', 'in_progress']);

    this.reports = this.allReports.filter(report => {
      const animalMatches = this.selectedAnimalFilter === 'all' ||
        String(report.animal_type || '').toLowerCase() === this.selectedAnimalFilter;
      if (!animalMatches) return false;

      if (this.selectedStatusFilter === 'all') return true;
      if (this.selectedStatusFilter === 'unresolved') {
        return activeStatuses.has(report.status);
      }
      return report.status === this.selectedStatusFilter;
    });
  }

  changeStatusFilter(status: string): void {
    const allowedStatuses: ReportStatusFilter[] = [
      'unresolved', 'pending', 'under_review', 'in_progress',
      'resolved', 'closed', 'all'
    ];
    if (
      this.destroyed ||
      this.resolvingReportId !== null ||
      !allowedStatuses.includes(status as ReportStatusFilter) ||
      this.selectedStatusFilter === status
    ) {
      return;
    }

    this.closeReportDetails();
    this.selectedStatusFilter = status as ReportStatusFilter;
    this.errorMessage = '';
    this.resolveMessage = '';
    this.updateVisibleReports();
    // Refresh the read-only ownership-claim hint for visible Found Pet reports.
    this.loadFoundPetAvailability();
    this.cdr.detectChanges();
  }

  // =====================================
  // FILTER MY REPORTS
  // =====================================
  changeFilter(filter: ReportFilter): void {
    if (this.selectedFilter === filter) {
      return;
    }
    console.log('[MY REPORTS] Filter changed:', filter);
    this.closeReportDetails();
    this.selectedFilter = filter;
    this.allReports = [];
    this.updateVisibleReports();
    this.restrictedFoundReportIds.clear();
    this.loadReports();
  }
  // =====================================
  // FILTER BY ANIMAL TYPE (ALL / DOG / CAT)
  // =====================================
  changeAnimalFilter(animal: string): void {
    if (
      this.destroyed ||
      this.resolvingReportId !== null ||
      !['all', 'dog', 'cat'].includes(animal) ||
      this.selectedAnimalFilter === animal
    ) {
      return;
    }
    this.closeReportDetails();
    this.selectedAnimalFilter = animal as AnimalFilter;
    this.updateVisibleReports();
    this.loadFoundPetAvailability();
    this.cdr.detectChanges();
  }

  // =====================================
  // REFRESH MY REPORTS
  // =====================================
  refreshReports(): void {
    if (this.destroyed) {
      return;
    }
    console.log('[MY REPORTS] Refresh requested');
    this.refreshing = true;
    this.loadReports();
  }

  // =====================================
  // MARK REPORT AS RESOLVED
  // =====================================
  markAsResolved(report: PetReport): void {
    if (
      this.destroyed ||
      this.resolvingReportId !== null ||
      !['pending', 'under_review', 'in_progress'].includes(report.status)
    ) {
      return;
    }
    if (report.report_type === 'found' && this.hasActiveOwnershipClaim(report.id)) {
      this.errorMessage = 'This Found Pet report has an active ownership claim. Complete or resolve the claim first.';
      this.cdr.detectChanges();
      return;
    }

    const confirmationMessage =
      report.report_type === 'found'
        ? 'Have you checked the claimant’s previous pet photos and ' +
          'private identifying details, and successfully returned the pet? ' +
          'Only mark this report as resolved after the handover is completed.'
        : 'Have you found or recovered your missing pet? ' +
          'Only mark this report as resolved once your pet is safely recovered.';
    const confirmed = window.confirm(confirmationMessage);
    if (!confirmed) {
      return;
    }
    this.errorMessage = '';
    this.resolveMessage = '';
    this.resolvingReportId = report.id;
    this.cdr.detectChanges();
    this.resolveRequest = this.reportsService
      .resolveReport(report.id)
      .pipe(
        timeout(15000),
        finalize(() => {
          if (this.destroyed) {
            return;
          }
          this.resolvingReportId = null;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (response) => {
          if (this.destroyed) {
            return;
          }
          if (response.success) {
            // Move the report into Resolved immediately after server success.
            this.allReports = this.allReports.map(item =>
              item.id === report.id
                ? { ...item, status: 'resolved' }
                : item
            );
            this.updateVisibleReports();
            this.resolveMessage =
              response.message ||
              'Pet report marked as resolved successfully.';
            this.cdr.detectChanges();
            this.loadReports();
          } else {
            this.errorMessage =
              response.message || 'Unable to resolve this report.';
            this.cdr.detectChanges();
          }
        },
        error: (error) => {
          if (this.destroyed) {
            return;
          }
          console.error('[MY REPORTS] Resolve error:', error);
          if (error.status === 409) {
            this.errorMessage =
              error.error?.message ||
              'This report has already been updated. Please refresh.';
          } else if (error.status === 401) {
            this.errorMessage =
              'Your session has expired. Please log in again.';
          } else if (
            error.name === 'TimeoutError' ||
            error.status === 0
          ) {
            this.errorMessage =
              'Unable to confirm the update. Please refresh and ' +
              'check the report status before retrying.';
          } else {
            this.errorMessage =
              error.error?.message || 'Unable to resolve this report.';
          }
          this.cdr.detectChanges();
        }
      });
  }

  // =====================================
  // LIGHTWEIGHT STATUS HINT FOR FOUND PET REPORTS
  // =====================================
  // The availability endpoint exposes only report IDs and broad
  // reservation/dispute states, never evidence or pickup details.
  private loadFoundPetAvailability(): void {
    this.availabilityRequest?.unsubscribe();
    this.restrictedFoundReportIds.clear();

    const foundReportIds = new Set(
      this.reports
        .filter(report => report.report_type === 'found')
        .map(report => report.id)
    );
    if (foundReportIds.size === 0) {
      return;
    }

    const currentRequestId = this.requestId;
    this.availabilityRequest = this.reportsService
      .getFoundPetClaimAvailability()
      .pipe(timeout(10000))
      .subscribe({
        next: response => {
          if (this.destroyed || currentRequestId !== this.requestId) {
            return;
          }
          const items = response.success && Array.isArray(response.report_availability)
            ? response.report_availability
            : [];
          this.restrictedFoundReportIds = new Set(
            items
              .filter(item =>
                foundReportIds.has(item.report_id) &&
                (item.availability === 'reserved' || item.availability === 'under_dispute')
              )
              .map(item => item.report_id)
          );
          this.cdr.detectChanges();
        },
        error: () => {
          // This is merely a hint. The PHP resolve_report.php endpoint
          // still blocks resolution of reports with active claims.
          if (this.destroyed || currentRequestId !== this.requestId) {
            return;
          }
          this.restrictedFoundReportIds.clear();
          this.cdr.detectChanges();
        }
      });
  }

  hasActiveOwnershipClaim(reportId: number): boolean {
    // Pending claims are not listed by the public availability API.
    // The server validates *all* active claims upon report resolution.
    return this.restrictedFoundReportIds.has(reportId);
  }

  // =====================================
  // EDIT PET REPORT
  // =====================================
  editReport(report: PetReport): void {
    if (
      this.destroyed ||
      this.loading ||
      this.resolvingReportId !== null ||
      !['pending', 'under_review', 'in_progress'].includes(report.status)
    ) {
      return;
    }
    this.closePhotoViewer();
    this.closeLocationMap();
    this.detailReport = null;
    this.router.navigate(
      ['/edit-report', report.id],
      {
        state: { report }
      }
    );
  }
  // =====================================
  // REPORT DETAILS VIEW
  // =====================================
  openReportDetails(report: PetReport): void {
    if (this.destroyed) return;
    this.closePhotoViewer();
    this.closeLocationMap();
    this.detailReport = report;
    this.cdr.detectChanges();
  }

  closeReportDetails(): void {
    this.closePhotoViewer();
    this.closeLocationMap();
    this.detailReport = null;
    if (!this.destroyed) this.cdr.detectChanges();
  }

  // =====================================
  // MULTIPLE PHOTO GALLERY: VALID PHOTO URLS
  // =====================================
  getReportPhotos(report: PetReport): string[] {
    // This service also supports legacy reports with one photo.
    return this.reportsService.getReportPhotoUrls(report)
      .filter(url => !this.brokenPhotoUrls.has(url));
  }
  // =====================================
  // CURRENT PHOTO POSITION
  // =====================================
  getCurrentPhotoIndex(report: PetReport): number {
    const count = this.getReportPhotos(report).length;
    if (count === 0) {
      return 0;
    }
    const index = this.photoIndexes.get(report.id) ?? 0;
    return Math.max(0, Math.min(index, count - 1));
  }
  getCurrentPhotoUrl(report: PetReport): string | null {
    const photos = this.getReportPhotos(report);
    return photos[this.getCurrentPhotoIndex(report)] ?? null;
  }
  // =====================================
  // PHOTO NAVIGATION (WRAP AT ENDS)
  // =====================================
  changePhoto(report: PetReport, direction: number): void {
    const count = this.getReportPhotos(report).length;
    if (count < 2) {
      return;
    }
    const index = this.getCurrentPhotoIndex(report);
    const next = (index + direction + count) % count;
    this.photoIndexes.set(report.id, next);
    this.cdr.detectChanges();
  }
  selectPhoto(report: PetReport, index: number): void {
    const count = this.getReportPhotos(report).length;
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      return;
    }
    this.photoIndexes.set(report.id, index);
    this.cdr.detectChanges();
  }
  // =====================================
  // FULL-SCREEN PET PHOTO VIEWER
  // =====================================
  openPhotoViewer(report: PetReport): void {
    if (
      this.destroyed ||
      this.getReportPhotos(report).length === 0 ||
      Date.now() - this.lastPhotoSwipeAt < 350
    ) {
      return;
    }
    this.closeLocationMap();
    this.photoViewerReport = report;
    this.cdr.detectChanges();
  }
  closePhotoViewer(): void {
    this.photoViewerReport = null;
    this.resetPhotoTouch();
    if (!this.destroyed) {
      this.cdr.detectChanges();
    }
  }
  // =====================================
  // TOUCH SWIPING: IGNORE VERTICAL SCROLL
  // =====================================
  onPhotoTouchStart(event: TouchEvent, report: PetReport): void {
    if (event.touches.length !== 1) {
      this.resetPhotoTouch();
      return;
    }
    this.photoTouchStartX = event.touches[0].clientX;
    this.photoTouchStartY = event.touches[0].clientY;
    this.photoTouchReportId = report.id;
  }
  onPhotoTouchEnd(event: TouchEvent, report: PetReport): void {
    if (
      this.photoTouchStartX === null ||
      this.photoTouchStartY === null ||
      this.photoTouchReportId !== report.id ||
      event.changedTouches.length === 0
    ) {
      this.resetPhotoTouch();
      return;
    }
    const deltaX = event.changedTouches[0].clientX - this.photoTouchStartX;
    const deltaY = event.changedTouches[0].clientY - this.photoTouchStartY;
    this.resetPhotoTouch();
    if (
      this.getReportPhotos(report).length < 2 ||
      Math.abs(deltaX) < 45 ||
      Math.abs(deltaX) < Math.abs(deltaY) * 1.25
    ) {
      return;
    }
    // Some phones dispatch click after a swipe: do not open the viewer.
    this.lastPhotoSwipeAt = Date.now();
    this.changePhoto(report, deltaX < 0 ? 1 : -1);
  }
  private resetPhotoTouch(): void {
    this.photoTouchStartX = null;
    this.photoTouchStartY = null;
    this.photoTouchReportId = null;
  }
  // =====================================
  // SKIP BROKEN IMAGES
  // =====================================
  onPhotoLoadError(photoUrl: string): void {
    if (!photoUrl || this.brokenPhotoUrls.has(photoUrl)) {
      return;
    }
    this.brokenPhotoUrls.add(photoUrl);
    if (
      this.photoViewerReport &&
      this.getReportPhotos(this.photoViewerReport).length === 0
    ) {
      this.closePhotoViewer();
    } else {
      this.cdr.detectChanges();
    }
  }
  // =====================================
  // KEYBOARD ACCESSIBILITY IN PHOTO VIEWER
  // =====================================
  @HostListener('document:keydown', ['$event'])
  onGalleryKeydown(event: KeyboardEvent): void {
    if (!this.photoViewerReport) {
      if (event.key === 'Escape' && this.showLocationMap) {
        event.preventDefault();
        this.closeLocationMap();
      } else if (event.key === 'Escape' && this.detailReport) {
        event.preventDefault();
        this.closeReportDetails();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closePhotoViewer();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.changePhoto(this.photoViewerReport, 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.changePhoto(this.photoViewerReport, -1);
    }
  }
  // =====================================
  // PET PHOTO URL
  // =====================================
  getPhotoUrl(photoPath: string | null): string | null {
    return this.reportsService.getPhotoUrl(photoPath);
  }
  // =====================================
  // REPORT STATUS LABEL
  // =====================================
  getStatusLabel(status: string): string {
    if (!status) {
      return 'Unknown';
    }
    return status
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  // =====================================
  // VALIDATE REPORT COORDINATES
  // =====================================
  hasLocation(report: PetReport): boolean {
    if (
      report.latitude === null ||
      report.longitude === null ||
      report.latitude === undefined ||
      report.longitude === undefined ||
      report.latitude === '' ||
      report.longitude === ''
    ) {
      return false;
    }
    const lat = Number(report.latitude);
    const lng = Number(report.longitude);
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    );
  }
  // =====================================
  // CREATE RED LOCATION MARKER
  // =====================================
  private createLocationIcon(): L.DivIcon {
    const svg = `
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="44"
        height="56"
        viewBox="0 0 44 56"
        aria-hidden="true"
      >
        <path
          d="M22 2 C10.4 2 2 10.8 2 22 C2 37.5 22 54 22 54 C22 54 42 37.5 42 22 C42 10.8 33.6 2 22 2 Z"
          fill="#e53935"
          stroke="#ffffff"
          stroke-width="2.5"
        />
        <circle
          cx="22"
          cy="21"
          r="11"
          fill="#ffffff"
        />
        <circle
          cx="22"
          cy="21"
          r="5"
          fill="#e53935"
        />
      </svg>
    `;
    return L.divIcon({
      className: 'pawrescue-custom-marker',
      html: svg,
      iconSize: [44, 56],
      iconAnchor: [22, 54],
      popupAnchor: [0, -48]
    });
  }
  // =====================================
  // VIEW REPORT LOCATION
  // =====================================
  viewLocation(report: PetReport): void {
    if (!this.hasLocation(report) || this.destroyed) {
      return;
    }
    this.closePhotoViewer();
    this.destroyReportMap();
    this.selectedReport = report;
    this.showLocationMap = true;
    this.cdr.detectChanges();
  }
  // =====================================
  // INITIALIZE LEAFLET MAP
  // =====================================
  private initializeReportMap(
    container: HTMLDivElement
  ): void {
    if (
      this.destroyed ||
      this.reportMap ||
      !this.showLocationMap ||
      !this.selectedReport ||
      !this.hasLocation(this.selectedReport)
    ) {
      return;
    }
    const report = this.selectedReport;
    const coordinates: L.LatLngExpression = [
      Number(report.latitude),
      Number(report.longitude)
    ];
    try {
      this.reportMap = L.map(container, {
        center: coordinates,
        zoom: 16,
        zoomControl: true,
        scrollWheelZoom: false
      });
      L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors'
        }
      ).addTo(this.reportMap);
      this.reportMarker = L.marker(coordinates, {
        icon: this.createLocationIcon(),
        draggable: false,
        keyboard: true,
        zIndexOffset: 1000
      }).addTo(this.reportMap);
      const popupContainer = document.createElement('div');
      const petName = document.createElement('strong');
      const locationText = document.createElement('p');
      petName.textContent = report.pet_name || 'Reported Pet';
      locationText.textContent =
        report.location_address || 'Location not specified';
      locationText.style.margin = '6px 0 0';
      locationText.style.lineHeight = '1.5';
      popupContainer.appendChild(petName);
      popupContainer.appendChild(locationText);
      this.reportMarker.bindPopup(popupContainer);
      this.reportMarker.on('click', () => {
        this.reportMarker?.openPopup();
      });
      this.mapResizeTimer = setTimeout(() => {
        if (
          this.destroyed ||
          !this.showLocationMap ||
          !this.reportMap
        ) {
          return;
        }
        this.reportMap.invalidateSize();
        this.reportMap.setView(coordinates, 16, { animate: false });
      }, 150);
    } catch (error) {
      console.error('[MY REPORTS] Map initialization error:', error);
      this.destroyReportMap();
    }
  }
  // =====================================
  // CLOSE REPORT LOCATION MAP
  // =====================================
  closeLocationMap(): void {
    this.showLocationMap = false;
    this.selectedReport = null;
    this.destroyReportMap();
  }
  // =====================================
  // CLEAN UP LEAFLET MAP
  // =====================================
  private destroyReportMap(): void {
    if (this.mapResizeTimer !== null) {
      clearTimeout(this.mapResizeTimer);
      this.mapResizeTimer = null;
    }
    if (this.reportMarker) {
      this.reportMarker.off();
      this.reportMarker = null;
    }
    if (this.reportMap) {
      this.reportMap.off();
      this.reportMap.remove();
      this.reportMap = null;
    }
  }
  // =====================================
  // TRACK REPORT CARDS
  // =====================================
  trackReport(index: number, report: PetReport): number {
    return report.id;
  }
  // =====================================
  // NAVIGATION
  // =====================================
  goBack(): void {
    if (this.detailReport) {
      this.closeReportDetails();
      return;
    }
    this.closePhotoViewer();
    this.closeLocationMap();
    this.router.navigateByUrl('/home');
  }
  // =====================================
  // COMPONENT CLEANUP
  // =====================================
  ngOnDestroy(): void {
    this.destroyed = true;
    ++this.requestId;
    this.reportsRequest?.unsubscribe();
    this.resolveRequest?.unsubscribe();
    this.availabilityRequest?.unsubscribe();
    this.restrictedFoundReportIds.clear();
    this.photoViewerReport = null;
    this.detailReport = null;
    this.resetPhotoTouch();
    this.photoIndexes.clear();
    this.brokenPhotoUrls.clear();
    this.destroyReportMap();
  }
}
