import {
  Component,
  inject,
  OnDestroy,
  ChangeDetectorRef,
  ElementRef,
  ViewChild,
  NgZone,
  HostListener
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import {
  IonContent,
  IonIcon,
  IonSpinner,
  IonButton
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  locationOutline,
  calendarOutline,
  pawOutline,
  addOutline,
  refreshOutline,
  mapOutline,
  closeOutline,
  chevronBackOutline,
  chevronForwardOutline,
  expandOutline,
  shieldCheckmarkOutline,
  imagesOutline,
  checkmarkCircleOutline
} from 'ionicons/icons';
import {
  Subscription,
  firstValueFrom,
  timeout,
  finalize
} from 'rxjs';
import * as L from 'leaflet';
import {
  PetReportsService,
  PetReport,
  FoundPetClaimAvailabilityStatus,
  SubmitLostPetRecoveryRequest
} from '../../services/pet-reports';
type ReportFilter = 'all' | 'lost' | 'found';
@Component({
  selector: 'app-lost-found',
  templateUrl: './lost-found.page.html',
  styleUrls: ['./lost-found.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonContent,
    IonIcon,
    IonSpinner,
    IonButton
  ]
})
export class LostFoundPage implements OnDestroy {
  private reportsService = inject(PetReportsService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);

  @ViewChild(IonContent) private pageContent?: IonContent;

  // =====================================
  // REPORT DATA
  // =====================================
  reports: PetReport[] = [];
  selectedFilter: ReportFilter = 'all';
  selectedDate = '';
  locationQuery = '';

  // GPS filtering is opt-in. Coordinates stay on the resident's device:
  // only the existing public report data is used to compute distances.
  nearbyCenter: { latitude: number; longitude: number } | null = null;
  nearbyRadiusKm = 5;
  nearbyLoading = false;
  nearbyError = '';
  private nearbyRequestVersion = 0;

  // Combine type (server query), incident date, address, and GPS distance.
  // Report ownership, claim, and recovery eligibility are handled separately.
  get filteredReports(): PetReport[] {
    const date = this.selectedDate;
    const location = this.locationQuery.trim().toLocaleLowerCase();
    const center = this.nearbyCenter;

    if (!date && !location && !center) {
      return this.reports;
    }

    return this.reports.filter((report) => {
      const incidentDate = String(report.incident_date ?? '').slice(0, 10);
      const address = String(report.location_address ?? '').toLocaleLowerCase();

      if (date && incidentDate !== date) return false;
      if (location && !address.includes(location)) return false;

      if (center) {
        // Reports without usable GPS cannot be assigned a reliable distance.
        if (!this.hasLocation(report)) return false;
        const distance = this.distanceInKm(
          center.latitude, center.longitude,
          Number(report.latitude), Number(report.longitude)
        );
        if (distance > this.nearbyRadiusKm) return false;
      }
      return true;
    });
  }

  private distanceInKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const radians = Math.PI / 180;
    const latitudeDiff = (lat2 - lat1) * radians;
    const longitudeDiff = (lng2 - lng1) * radians;
    const a = Math.sin(latitudeDiff / 2) ** 2 +
      Math.cos(lat1 * radians) * Math.cos(lat2 * radians) *
      Math.sin(longitudeDiff / 2) ** 2;
    return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  }
  // =====================================
  // LOADING STATES
  // =====================================
  loading = false;
  refreshing = false;
  errorMessage = '';


  // =====================================
  // FOUND PET OWNERSHIP CLAIMS
  // =====================================
  // get_reports.php doesn't expose user_id. Compare against the reports
  // returned for the verified account, not against a display name.
  private readonly myFoundReportIds = new Set<number>();
  private readonly locallySubmittedClaimReportIds = new Set<number>();
  // These sets are reloaded from authenticated, private sent-record endpoints.
  private readonly sentClaimReportIds = new Set<number>();
  private readonly sentRecoveryReportIds = new Set<number>();
  submittedStatusLoading = true;
  submittedStatusReady = false;
  private submittedStatusVersion = 0;
  private myReportsRequest?: Subscription;
  private eligibilityRequestVersion = 0;
  ownershipEligibilityLoading = false;
  ownershipEligibilityReady = false;
  ownershipEligibilityError = '';

  // =====================================
  // LIVE FOUND PET AVAILABILITY (STEP 28)
  // =====================================
  // The API supplies ONLY the IDs of unavailable Found Pet reports.
  // An absent ID can be treated as available for display only after
  // the complete availability response is successfully received.
  // submit_claim.php remains the final authority at submission time.
  private readonly foundPetAvailability =
    new Map<number, FoundPetClaimAvailabilityStatus>();
  private foundPetAvailabilityRequest?: Subscription;
  private foundPetAvailabilityRequestVersion = 0;
  foundPetAvailabilityLoading = false;
  foundPetAvailabilityReady = false;
  foundPetAvailabilityError = '';

  claimReport: PetReport | null = null;
  claimProofDescription = '';
  claimLinkedLostReportId: number | null = null;
  myLostPetReports: PetReport[] = [];
  claimEvidenceFiles: File[] = [];
  claimSubmitting = false;
  claimPhotoUploading = false;
  claimPhotoUploadProgress = '';
  claimErrorMessage = '';
  claimSuccessMessage = '';
  claimPhotoWarning = '';

  // If the claim saved but a photo failed, keep the claim ID and only
  // retry files that haven't been confirmed uploaded. Never resend the
  // initial claim in that case (unique claims are enforced server-side).
  private savedClaimId: number | null = null;
  private unuploadedClaimPhotos: File[] = [];
  private claimFormVersion = 0;

  // =====================================
  // LOST PET — "I FOUND THIS PET" RECOVERY
  // =====================================
  // Never trust the public report's display name for ownership.
  // The logged-in resident's owned reports are checked separately,
  // and submit_recovery.php performs the final server-side checks.
  private readonly myLostReportIds = new Set<number>();
  private readonly locallySubmittedRecoveryReportIds = new Set<number>();
  myFoundPetReports: PetReport[] = [];

  recoveryReport: PetReport | null = null;
  recoveryFindingDescription = '';
  recoveryFoundLocation = '';
  recoveryFoundAt = '';
  recoveryFoundLatitude: number | null = null;
  recoveryFoundLongitude: number | null = null;
  recoveryLinkedFoundReportId: number | null = null;
  recoveryEvidenceFiles: File[] = [];
  recoverySubmitting = false;
  recoveryPhotoUploading = false;
  recoveryPhotoUploadProgress = '';
  recoveryErrorMessage = '';
  recoverySuccessMessage = '';
  recoveryPhotoWarning = '';
  recoveryLocationLoading = false;

  // Retry only failed evidence uploads after the recovery is saved.
  // Re-submitting the finding would create a conflicting duplicate.
  private savedRecoveryId: number | null = null;
  private unuploadedRecoveryPhotos: File[] = [];
  private recoveryFormVersion = 0;

  // Keep the parent report available for the retry dialog while photo
  // uploads continue separately after the finding is confirmed saved.
  private recoveryPhotoUploadReport: PetReport | null = null;
  private recoveryPhotoUploadUncertain = false;

  // =====================================
  // PHP BACKEND URL
  // =====================================
  // =====================================
  // REPORT CACHE
  // =====================================
  private cache = new Map<ReportFilter, PetReport[]>();
  private request?: Subscription;
  private destroyed = false;
  // =====================================
  // MULTIPLE PET PHOTOS / GALLERY STATE
  // =====================================
  // Each report remembers its current photo independently.
  private photoIndexes = new Map<number, number>();
  // Invalid or unavailable photos are skipped in the gallery.
  private brokenPhotoUrls = new Set<string>();
  // Full-screen photo viewer.
  photoViewerReport: PetReport | null = null;
  // Swipe gesture tracking for cards and the photo viewer.
  private photoTouchStartX: number | null = null;
  private photoTouchStartY: number | null = null;
  private photoTouchReportId: number | null = null;
  private lastPhotoSwipeAt = 0;
  // =====================================
  // VIEW LOCATION MAP STATE
  // =====================================
  showLocationMap = false;
  selectedReport: PetReport | null = null;
  private reportMap: L.Map | null = null;
  private reportMarker: L.Marker | null = null;
  private mapResizeTimer: ReturnType<typeof setTimeout> | null = null;
  // =====================================
  // MAP CONTAINER
  // =====================================
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
      locationOutline,
      calendarOutline,
      pawOutline,
      addOutline,
      refreshOutline,
      mapOutline,
      closeOutline,
      chevronBackOutline,
      chevronForwardOutline,
      expandOutline,
      shieldCheckmarkOutline,
      imagesOutline,
      checkmarkCircleOutline
    });
  }
  // =====================================
  // PAGE LIFECYCLE
  // =====================================
  ionViewWillEnter() {
    this.loadReports();
    this.loadOwnershipEligibility();
    void this.loadSubmittedStatus();
  }
  ionViewDidLeave() {
    ++this.submittedStatusVersion;
    this.submittedStatusReady = false;
    this.submittedStatusLoading = true;
    ++this.nearbyRequestVersion;
    this.nearbyLoading = false;
    this.closeLocationMap();
    this.closePhotoViewer();
    if (!this.recoverySubmitting && !this.recoveryPhotoUploading) {
      this.closeLostPetRecovery();
    }
    // A fresh entry rechecks report ownership and session identity.
    this.myReportsRequest?.unsubscribe();
    ++this.eligibilityRequestVersion;
    this.foundPetAvailabilityRequest?.unsubscribe();
    ++this.foundPetAvailabilityRequestVersion;
    this.foundPetAvailability.clear();
    this.foundPetAvailabilityReady = false;
    this.foundPetAvailabilityLoading = false;
    this.foundPetAvailabilityError = '';
    this.ownershipEligibilityLoading = false;
    this.ownershipEligibilityReady = false;
    this.myFoundReportIds.clear();
    this.myLostReportIds.clear();
    this.myFoundPetReports = [];
    this.myLostPetReports = [];
  }
  // =====================================
  // UI UPDATE HELPER
  // =====================================
  private updateUI(callback: () => void) {
    if (this.destroyed) {
      return;
    }
    this.zone.run(() => {
      callback();
      this.cdr.detectChanges();
    });
  }
  // =====================================
  // LOAD LOST AND FOUND REPORTS
  // =====================================
  loadReports(forceRefresh = false) {
    // Cancel unfinished request.
    this.request?.unsubscribe();
    // Recheck reservation status whenever the feed refreshes or its
    // filter changes; previous responses must not authorize a claim.
    this.loadFoundPetAvailability();
    const filter = this.selectedFilter;
    const cachedReports = this.cache.get(filter);
    // Show cached data while refreshing.
    if (cachedReports !== undefined) {
      this.reports = cachedReports;
    } else {
      this.reports = [];
    }
    const hasCache = cachedReports !== undefined;
    this.loading = !hasCache;
    this.refreshing = hasCache;
    this.errorMessage = '';
    const startTime = performance.now();
    this.request = this.reportsService
      .getReports(filter)
      .pipe(
        timeout(10000),
        finalize(() => {
          this.updateUI(() => {
            this.loading = false;
            this.refreshing = false;
          });
        })
      )
      .subscribe({
        next: (response) => {
          this.updateUI(() => {
            if (response.success) {
              const updatedReports = response.reports ?? [];
              // Update cached reports.
              this.cache.set(filter, updatedReports);
              // A previously broken image may become available
              // after the resident updates the report.
              this.brokenPhotoUrls.clear();
              // Keep the photo viewer in sync with refreshed data.
              if (this.photoViewerReport && this.selectedFilter === filter) {
                this.photoViewerReport =
                  updatedReports.find(
                    report => report.id === this.photoViewerReport?.id
                  ) ?? null;
              }
              // Display matching filter only.
              if (this.selectedFilter === filter) {
                this.reports = updatedReports;
              }
              console.log(
                'Pet reports loaded in',
                Math.round(performance.now() - startTime),
                'ms'
              );
            } else {
              this.errorMessage =
                response.message ||
                'Unable to retrieve pet reports.';
            }
          });
        },
        error: (error) => {
          console.error('Pet report loading error:', error);
          this.updateUI(() => {
            if (error.name === 'TimeoutError') {
              this.errorMessage =
                'Reports are taking too long to load. Please refresh.';
            } else if (error.status === 401) {
              this.errorMessage =
                'Session expired. Please log in again.';
            } else if (error.status === 0) {
              this.errorMessage =
                'Unable to connect to the server.';
            } else {
              this.errorMessage =
                'Unable to load the latest pet reports.';
            }
          });
        }
      });
  }
  // =====================================
  // FILTER REPORTS
  // =====================================
  changeFilter(filter: ReportFilter) {
    if (this.selectedFilter === filter) {
      return;
    }
    this.closePhotoViewer();
    this.selectedFilter = filter;
    this.reports = this.cache.get(filter) ?? [];
    this.loadReports();
  }
  // =====================================
  // COMMUNITY REPORT FILTER CONTROLS
  // =====================================
  onReportTypeChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value === 'all' || value === 'lost' || value === 'found') {
      this.changeFilter(value);
    }
  }

  onIncidentDateChange(event: Event): void {
    this.closePhotoViewer();
    this.selectedDate = (event.target as HTMLInputElement).value;
  }

  onLocationQueryInput(event: Event): void {
    this.closePhotoViewer();
    this.locationQuery = (event.target as HTMLInputElement).value;
  }

  onNearbyRadiusChange(event: Event): void {
    const radius = Number((event.target as HTMLSelectElement).value);
    if ([1, 3, 5, 10, 20].includes(radius)) {
      this.nearbyRadiusKm = radius;
      this.closePhotoViewer();
    }
  }

  // Use the native Android GPS bridge during USB live reload. Browser
  // geolocation is only a fallback for web builds on secure origins.
  private async getDeviceCoordinates(timeoutMs: number): Promise<{
    latitude: number;
    longitude: number;
  }> {
    if (Capacitor.isNativePlatform()) {
      let permission = await Geolocation.checkPermissions();
      if (permission.location !== 'granted' &&
          permission.coarseLocation !== 'granted') {
        permission = await Geolocation.requestPermissions();
      }
      if (permission.location !== 'granted' &&
          permission.coarseLocation !== 'granted') {
        const error = new Error('Location permission denied.');
        (error as Error & { code?: string }).code = 'LOCATION_DENIED';
        throw error;
      }
      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 0
      });
      return {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude
      };
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      throw new Error('GPS is unavailable in this browser.');
    }
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        position => resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        }),
        reject,
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
      );
    });
  }

  private gpsErrorMessage(error: unknown): string {
    const value = error as { code?: string | number; message?: string } | null;
    const code = value?.code;
    const message = String(value?.message ?? '');
    if (code === 1 || code === 'LOCATION_DENIED' ||
        code === 'OS-PLUG-GLOC-0003' || /permission denied/i.test(message)) {
      return 'Location permission denied. Allow PawRescue location access in Android settings.';
    }
    if (code === 'OS-PLUG-GLOC-0007' ||
        code === 'OS-PLUG-GLOC-0017' ||
        /location services.*(disabled|off)/i.test(message)) {
      return 'Turn on Location in your phone settings and try again.';
    }
    if (code === 3 || code === 'OS-PLUG-GLOC-0010' ||
        /timed? out/i.test(message)) {
      return 'GPS took too long. Move to an area with better signal and try again.';
    }
    if (code === 'OS-PLUG-GLOC-0018') {
      return 'Android location permissions are missing from the app manifest.';
    }
    return 'Unable to get your location. Check GPS permissions and try again.';
  }

  async useCurrentLocationFilter(): Promise<void> {
    if (this.destroyed || this.nearbyLoading) return;
    const requestVersion = ++this.nearbyRequestVersion;
    this.updateUI(() => {
      this.nearbyLoading = true;
      this.nearbyError = '';
    });

    try {
      const { latitude, longitude } = await this.getDeviceCoordinates(20000);
      if (this.destroyed || requestVersion !== this.nearbyRequestVersion) return;
      this.updateUI(() => {
        this.nearbyLoading = false;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
            Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
          this.nearbyError = 'Your device returned an invalid GPS location.';
          return;
        }
        this.closePhotoViewer();
        this.nearbyCenter = { latitude, longitude };
        this.nearbyError = '';
      });
    } catch (error) {
      if (this.destroyed || requestVersion !== this.nearbyRequestVersion) return;
      this.updateUI(() => {
        this.nearbyLoading = false;
        this.nearbyError = this.gpsErrorMessage(error);
      });
    }
  }

  clearNearbyLocationFilter(): void {
    ++this.nearbyRequestVersion;
    this.nearbyCenter = null;
    this.nearbyLoading = false;
    this.nearbyError = '';
    this.closePhotoViewer();
  }

  clearReportFilters(): void {
    this.closePhotoViewer();
    this.selectedDate = '';
    this.locationQuery = '';
    this.clearNearbyLocationFilter();
    this.nearbyRadiusKm = 5;
    if (this.selectedFilter !== 'all') {
      this.changeFilter('all');
    }
  }

  // =====================================
  // REFRESH REPORTS
  // =====================================
  refreshReports() {
    this.loadReports(true);
    this.loadOwnershipEligibility();
    void this.loadSubmittedStatus();
  }
  // =====================================
  // GET UPLOADED PET PHOTO URL
  // =====================================
  getPhotoUrl(photoPath: string | null): string | null {
    return this.reportsService.getPhotoUrl(photoPath);
  }
  // =====================================
  // GET MULTIPLE REPORT PHOTOS
  // =====================================
  getReportPhotos(report: PetReport): string[] {
    // The service handles legacy single-photo reports,
    // the new photos[] response, and path validation.
    return this.reportsService
      .getReportPhotoUrls(report)
      .filter(url => !this.brokenPhotoUrls.has(url));
  }
  // =====================================
  // GET CURRENT PHOTO INDEX
  // =====================================
  getCurrentPhotoIndex(report: PetReport): number {
    const count = this.getReportPhotos(report).length;
    if (count === 0) {
      return 0;
    }
    const index = this.photoIndexes.get(report.id) ?? 0;
    return Math.max(0, Math.min(index, count - 1));
  }
  // =====================================
  // GET CURRENT VISIBLE PET PHOTO
  // =====================================
  getCurrentPhotoUrl(report: PetReport): string | null {
    const photos = this.getReportPhotos(report);
    return photos[this.getCurrentPhotoIndex(report)] ?? null;
  }
  // =====================================
  // CHANGE PHOTO IN THE GALLERY
  // =====================================
  changePhoto(report: PetReport, direction: number) {
    const photos = this.getReportPhotos(report);
    if (photos.length < 2) {
      return;
    }
    const currentIndex = this.getCurrentPhotoIndex(report);
    // Wrap around when reaching the first/last photo.
    const nextIndex =
      (currentIndex + direction + photos.length) % photos.length;
    this.photoIndexes.set(report.id, nextIndex);
    this.cdr.detectChanges();
  }
  // =====================================
  // SELECT A SPECIFIC PHOTO
  // =====================================
  selectPhoto(report: PetReport, index: number) {
    const photos = this.getReportPhotos(report);
    if (!Number.isInteger(index) || index < 0 || index >= photos.length) {
      return;
    }
    this.photoIndexes.set(report.id, index);
    this.cdr.detectChanges();
  }
  // =====================================
  // OPEN PHOTO FULL-SCREEN VIEWER
  // =====================================
  openPhotoViewer(report: PetReport) {
    // A touch swipe may dispatch a click on some devices.
    if (
      this.destroyed ||
      Date.now() - this.lastPhotoSwipeAt < 350 ||
      this.getReportPhotos(report).length === 0
    ) {
      return;
    }
    this.photoViewerReport = report;
    this.cdr.detectChanges();
  }
  // =====================================
  // CLOSE PHOTO FULL-SCREEN VIEWER
  // =====================================
  closePhotoViewer() {
    this.photoViewerReport = null;
    this.resetPhotoTouch();
    if (!this.destroyed) {
      this.cdr.detectChanges();
    }
  }
  // =====================================
  // START PHOTO SWIPE
  // =====================================
  onPhotoTouchStart(event: TouchEvent, report: PetReport) {
    if (event.touches.length !== 1) {
      this.resetPhotoTouch();
      return;
    }
    this.photoTouchStartX = event.touches[0].clientX;
    this.photoTouchStartY = event.touches[0].clientY;
    this.photoTouchReportId = report.id;
  }
  // =====================================
  // END PHOTO SWIPE
  // =====================================
  onPhotoTouchEnd(event: TouchEvent, report: PetReport) {
    if (
      this.photoTouchStartX === null ||
      this.photoTouchStartY === null ||
      this.photoTouchReportId !== report.id ||
      event.changedTouches.length === 0
    ) {
      this.resetPhotoTouch();
      return;
    }
    const deltaX =
      event.changedTouches[0].clientX - this.photoTouchStartX;
    const deltaY =
      event.changedTouches[0].clientY - this.photoTouchStartY;
    this.resetPhotoTouch();
    // Ignore small movements and ordinary vertical scrolling.
    if (
      this.getReportPhotos(report).length < 2 ||
      Math.abs(deltaX) < 45 ||
      Math.abs(deltaX) < Math.abs(deltaY) * 1.25
    ) {
      return;
    }
    this.lastPhotoSwipeAt = Date.now();
    this.changePhoto(report, deltaX < 0 ? 1 : -1);
  }
  private resetPhotoTouch() {
    this.photoTouchStartX = null;
    this.photoTouchStartY = null;
    this.photoTouchReportId = null;
  }
  // =====================================
  // SKIP BROKEN PHOTO WITHOUT BREAKING A POST
  // =====================================
  onPhotoLoadError(photoUrl: string) {
    if (!photoUrl || this.brokenPhotoUrls.has(photoUrl)) {
      return;
    }
    this.brokenPhotoUrls.add(photoUrl);
    this.cdr.detectChanges();
  }
  // =====================================
  // KEYBOARD SUPPORT FOR PHOTO VIEWER
  // =====================================
  @HostListener('document:keydown', ['$event'])
  onGalleryKeydown(event: KeyboardEvent) {
    if (!this.photoViewerReport) {
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
  // VALIDATE SAVED COORDINATES
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
    const latitude = Number(report.latitude);
    const longitude = Number(report.longitude);
    return (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180
    );
  }
  // =====================================
  // CUSTOM RED SVG LOCATION MARKER
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
  // VIEW SAVED REPORT LOCATION
  // =====================================
  viewLocation(report: PetReport) {
    if (!this.hasLocation(report) || this.destroyed) {
      return;
    }
    // Remove previous map first.
    this.destroyReportMap();
    this.updateUI(() => {
      this.selectedReport = report;
      this.showLocationMap = true;
    });
  }
  // =====================================
  // INITIALIZE LEAFLET MAP
  // =====================================
  private initializeReportMap(container: HTMLDivElement) {
    if (
      this.destroyed ||
      this.reportMap ||
      !this.showLocationMap ||
      !this.selectedReport
    ) {
      return;
    }
    if (!this.hasLocation(this.selectedReport)) {
      return;
    }
    const report = this.selectedReport;
    const latitude = Number(report.latitude);
    const longitude = Number(report.longitude);
    const coordinates: L.LatLngExpression = [latitude, longitude];
    // Create the map centered at
    // the report's saved coordinates.
    this.reportMap = L.map(container, {
      center: coordinates,
      zoom: 16,
      zoomControl: true,
      scrollWheelZoom: false
    });
    // Add OpenStreetMap tiles.
    L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }
    ).addTo(this.reportMap);
    // =====================================
    // CREATE VISIBLE LOCATION MARKER
    // =====================================
    this.reportMarker = L.marker(coordinates, {
      icon: this.createLocationIcon(),
      draggable: false,
      keyboard: true,
      zIndexOffset: 1000
    }).addTo(this.reportMap);
    // =====================================
    // REPORT INFORMATION POPUP
    // =====================================
    // Build DOM elements safely using
    // textContent instead of HTML
    // containing user-provided data.
    const popupContainer = document.createElement('div');
    const petName = document.createElement('strong');
    petName.textContent = report.pet_name || 'Reported Pet';
    const locationText = document.createElement('p');
    locationText.textContent = report.location_address;
    locationText.style.margin = '6px 0 0';
    locationText.style.lineHeight = '1.5';
    popupContainer.appendChild(petName);
    popupContainer.appendChild(locationText);
    this.reportMarker.bindPopup(popupContainer, {
      closeButton: true,
      autoPan: true
    });
    // Display popup when marker is tapped.
    this.reportMarker.on('click', () => {
      this.reportMarker?.openPopup();
    });
    // =====================================
    // MAP SIZE ADJUSTMENT
    // =====================================
    // Map is inside an Angular conditional
    // modal. Refresh the Leaflet dimensions
    // once the modal is rendered.
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
      this.reportMarker?.setLatLng(coordinates);
      this.reportMarker?.setZIndexOffset(1000);
    }, 150);
    console.log('Report location marker initialized:', {
      reportId: report.id,
      latitude,
      longitude
    });
  }
  // =====================================
  // CLOSE REPORT LOCATION MAP
  // =====================================
  closeLocationMap() {
    this.showLocationMap = false;
    this.selectedReport = null;
    this.destroyReportMap();
    if (!this.destroyed) {
      this.cdr.detectChanges();
    }
  }
  // =====================================
  // DESTROY LEAFLET MAP
  // =====================================
  private destroyReportMap() {
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
  // REPORT TRACKING
  // =====================================
  trackReport(index: number, report: PetReport): number {
    return report.id;
  }
  // =====================================
  // CHECK IF THE RESIDENT OWNS EACH FOUND PET REPORT
  // =====================================
  private loadOwnershipEligibility(): void {
    if (this.destroyed) return;

    const version = ++this.eligibilityRequestVersion;
    this.myReportsRequest?.unsubscribe();
    this.myFoundReportIds.clear();
    this.myLostReportIds.clear();
    this.myFoundPetReports = [];
    this.myLostPetReports = [];
    this.ownershipEligibilityLoading = true;
    this.ownershipEligibilityReady = false;
    this.ownershipEligibilityError = '';

    this.myReportsRequest = this.reportsService.getMyReports('all')
      .pipe(timeout(10000))
      .subscribe({
        next: response => {
          if (this.destroyed || version !== this.eligibilityRequestVersion) return;
          this.updateUI(() => {
            this.ownershipEligibilityLoading = false;
            if (!response.success || !Array.isArray(response.reports)) {
              this.ownershipEligibilityError =
                response.message || 'Unable to verify report ownership. Please refresh.';
              return;
            }
            this.myFoundReportIds.clear();
            this.myLostPetReports = [];
            for (const report of response.reports) {
              if (report.report_type === 'found') {
                this.myFoundReportIds.add(report.id);
                if (['pending', 'under_review', 'in_progress'].includes(report.status)) {
                  this.myFoundPetReports.push(report);
                }
              } else if (report.report_type === 'lost') {
                this.myLostReportIds.add(report.id);
                this.myLostPetReports.push(report);
              }
            }
            this.ownershipEligibilityReady = true;
            this.ownershipEligibilityError = '';
          });
        },
        error: error => {
          if (this.destroyed || version !== this.eligibilityRequestVersion) return;
          this.updateUI(() => {
            this.ownershipEligibilityLoading = false;
            this.ownershipEligibilityReady = false;
            this.ownershipEligibilityError = error?.status === 401
              ? 'Please log in again to submit an ownership claim.'
              : 'Unable to verify report ownership. Refresh the feed and try again.';
          });
        }
      });
  }

  // =====================================
  // LOAD RESERVED / DISPUTED FOUND PET STATUS
  // =====================================
  private loadFoundPetAvailability(): void {
    if (this.destroyed) return;

    const version = ++this.foundPetAvailabilityRequestVersion;
    this.foundPetAvailabilityRequest?.unsubscribe();

    // Fail closed while refreshing. An old successful response is not
    // safe to reuse for a later page entry or refresh.
    this.foundPetAvailability.clear();
    this.foundPetAvailabilityReady = false;
    this.foundPetAvailabilityLoading = true;
    this.foundPetAvailabilityError = '';

    this.foundPetAvailabilityRequest = this.reportsService
      .getFoundPetClaimAvailability()
      .pipe(timeout(10000))
      .subscribe({
        next: response => {
          if (this.destroyed || version !== this.foundPetAvailabilityRequestVersion) return;
          this.updateUI(() => {
            this.foundPetAvailabilityLoading = false;
            this.foundPetAvailabilityReady = false;

            if (!response?.success || !Array.isArray(response.report_availability)) {
              this.foundPetAvailabilityError =
                response?.message || 'Unable to check Found Pet availability. Please refresh.';
              return;
            }

            const statuses = new Map<number, FoundPetClaimAvailabilityStatus>();
            for (const entry of response.report_availability) {
              if (
                !Number.isInteger(entry?.report_id) ||
                entry.report_id < 1 ||
                !['reserved', 'under_dispute', 'returned'].includes(entry.availability) ||
                entry.can_claim !== false
              ) {
                this.foundPetAvailabilityError =
                  'The server returned invalid Found Pet availability data. Please refresh.';
                return;
              }
              statuses.set(entry.report_id, entry.availability);
            }

            this.foundPetAvailability.clear();
            statuses.forEach((status, id) => this.foundPetAvailability.set(id, status));
            this.foundPetAvailabilityReady = true;
            this.foundPetAvailabilityError = '';

            // If a claim form was already open and the pet became
            // reserved, show a clear warning rather than discarding
            // the resident's written explanation and files.
            if (
              this.claimReport &&
              this.savedClaimId === null &&
              this.foundPetAvailability.has(this.claimReport.id)
            ) {
              this.claimErrorMessage =
                'This Found Pet is no longer accepting new ownership claims. ' +
                'Please close this form and refresh the reports.';
            }
          });
        },
        error: error => {
          if (this.destroyed || version !== this.foundPetAvailabilityRequestVersion) return;
          this.updateUI(() => {
            this.foundPetAvailability.clear();
            this.foundPetAvailabilityLoading = false;
            this.foundPetAvailabilityReady = false;
            this.foundPetAvailabilityError = error?.status === 401
              ? 'Please log in again to check Found Pet availability.'
              : 'Unable to check Found Pet availability. Claims are temporarily disabled; refresh and try again.';
          });
        }
      });
  }

  // For Step 29 HTML: shows a reserved/dispute/returned label without
  // exposing any claimant identity or private pickup information.
  getFoundPetAvailabilityStatus(
    report: PetReport
  ): 'available' | 'checking' | 'unavailable' | FoundPetClaimAvailabilityStatus {
    if (
      report.report_type !== 'found' ||
      !['pending', 'under_review', 'in_progress'].includes(report.status)
    ) return 'unavailable';
    if (!this.foundPetAvailabilityReady) {
      return this.foundPetAvailabilityLoading ? 'checking' : 'unavailable';
    }
    return this.foundPetAvailability.get(report.id) ?? 'available';
  }

  getFoundPetAvailabilityLabel(report: PetReport): string | null {
    switch (this.getFoundPetAvailabilityStatus(report)) {
      case 'reserved': return 'Reserved — Ownership Claim Approved';
      case 'under_dispute': return 'Temporarily Unavailable — Ownership Dispute';
      case 'returned': return 'Pet Already Returned';
      default: return null;
    }
  }

  /** Load all pages of the signed-in resident's sent submissions.
   *  Fail closed if a request fails: do not offer a button while unknown.
   *  Do not rely on localStorage (other accounts may use this device).
   */
  private async loadSubmittedStatus(): Promise<void> {
    const version = ++this.submittedStatusVersion;
    this.updateUI(() => {
      this.submittedStatusLoading = true;
      this.submittedStatusReady = false;
      this.sentClaimReportIds.clear();
      this.sentRecoveryReportIds.clear();
    });

    try {
      const claims = new Set<number>();
      const recoveries = new Set<number>();
      for (let offset = 0; ; offset += 50) {
        const response = await firstValueFrom(
          this.reportsService.getOwnershipClaims('sent', { limit: 50, offset })
            .pipe(timeout(12000))
        );
        if (this.destroyed || version !== this.submittedStatusVersion) return;
        if (!response?.success || !Array.isArray(response.claims)) {
          throw new Error('Unable to verify sent claims.');
        }
        for (const item of response.claims) claims.add(Number(item.found_report_id));
        if (!response.has_more || response.claims.length === 0) break;
      }
      for (let offset = 0; ; offset += 50) {
        const response = await firstValueFrom(
          this.reportsService.getLostPetRecoveries('sent', { limit: 50, offset })
            .pipe(timeout(12000))
        );
        if (this.destroyed || version !== this.submittedStatusVersion) return;
        if (!response?.success || !Array.isArray(response.recoveries)) {
          throw new Error('Unable to verify sent recoveries.');
        }
        for (const item of response.recoveries) recoveries.add(Number(item.lost_report_id));
        if (!response.has_more || response.recoveries.length === 0) break;
      }
      if (this.destroyed || version !== this.submittedStatusVersion) return;
      this.updateUI(() => {
        this.sentClaimReportIds.clear();
        claims.forEach(id => this.sentClaimReportIds.add(id));
        this.sentRecoveryReportIds.clear();
        recoveries.forEach(id => this.sentRecoveryReportIds.add(id));
        this.submittedStatusReady = true;
        this.submittedStatusLoading = false;
      });
    } catch (error) {
      if (this.destroyed || version !== this.submittedStatusVersion) return;
      console.warn('Unable to verify existing finding/claim submissions:', error);
      this.updateUI(() => {
        this.submittedStatusLoading = false;
        this.submittedStatusReady = false;
      });
    }
  }

  hasSubmittedClaim(report: PetReport): boolean {
    return this.locallySubmittedClaimReportIds.has(report.id) ||
      this.sentClaimReportIds.has(report.id);
  }

  hasSubmittedRecovery(report: PetReport): boolean {
    return this.locallySubmittedRecoveryReportIds.has(report.id) ||
      this.sentRecoveryReportIds.has(report.id);
  }

  showSubmittedClaimStatus(report: PetReport): boolean {
    return report.report_type === 'found' && this.ownershipEligibilityReady &&
      !this.myFoundReportIds.has(report.id) && this.hasSubmittedClaim(report);
  }

  showSubmittedRecoveryStatus(report: PetReport): boolean {
    return report.report_type === 'lost' && this.ownershipEligibilityReady &&
      !this.myLostReportIds.has(report.id) && this.hasSubmittedRecovery(report);
  }

  // Claim Ownership stays hidden if the resident owns the post, already
  // submitted a claim, OR availability could not be verified.
  // The PHP submit endpoint also checks these conditions atomically.
  canClaimOwnership(report: PetReport): boolean {
    return this.ownershipEligibilityReady && this.submittedStatusReady &&
      this.getFoundPetAvailabilityStatus(report) === 'available' &&
      !this.myFoundReportIds.has(report.id) &&
      !this.hasSubmittedClaim(report);
  }

  openOwnershipClaim(report: PetReport): void {
    if (this.destroyed || this.recoveryReport || this.claimReport ||
        this.claimSubmitting || this.recoveryPhotoUploading ||
        this.savedRecoveryId !== null || !this.canClaimOwnership(report)) {
      return;
    }
    this.closeLocationMap();
    this.closePhotoViewer();
    this.updateUI(() => {
      ++this.claimFormVersion;
      this.claimReport = report;
      this.claimProofDescription = '';
      this.claimLinkedLostReportId = null;
      this.claimEvidenceFiles = [];
      this.claimSuccessMessage = '';
      this.claimErrorMessage = '';
      this.claimPhotoWarning = '';
      this.claimPhotoUploadProgress = '';
      this.savedClaimId = null;
      this.unuploadedClaimPhotos = [];
    });
  }

  closeOwnershipClaim(): void {
    if (this.claimSubmitting || this.claimPhotoUploading) return;
    this.updateUI(() => {
      ++this.claimFormVersion;
      this.claimReport = null;
      this.claimProofDescription = '';
      this.claimLinkedLostReportId = null;
      this.claimEvidenceFiles = [];
      this.claimErrorMessage = '';
      this.claimPhotoWarning = '';
      this.claimPhotoUploadProgress = '';
      this.savedClaimId = null;
      this.unuploadedClaimPhotos = [];
    });
  }

  // Input: <input type="file" accept="image/jpeg,image/png,image/webp"
  // multiple (change)="onOwnershipEvidenceSelected($event)">
  onOwnershipEvidenceSelected(event: Event): void {
    if (this.destroyed || !this.claimReport || this.claimSubmitting ||
        this.claimPhotoUploading || this.savedClaimId !== null) return;

    const input = event.target as HTMLInputElement | null;
    const selected = Array.from(input?.files ?? []);
    if (input) input.value = '';
    if (selected.length === 0) return;

    const combined = [...this.claimEvidenceFiles, ...selected];
    if (combined.length > 5) {
      this.updateUI(() => {
        this.claimErrorMessage = 'You can attach a maximum of 5 ownership evidence photos.';
      });
      return;
    }
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    const invalid = combined.find(file =>
      !allowed.includes(file.type) || file.size === 0 || file.size > 5 * 1024 * 1024
    );
    if (invalid) {
      this.updateUI(() => {
        this.claimErrorMessage = 'Each photo must be JPG, PNG, or WebP and 5 MB or smaller.';
      });
      return;
    }
    this.updateUI(() => {
      this.claimEvidenceFiles = combined;
      this.claimErrorMessage = '';
    });
  }

  removeOwnershipEvidencePhoto(index: number): void {
    if (this.claimSubmitting || this.claimPhotoUploading || this.savedClaimId !== null) return;
    this.updateUI(() => {
      this.claimEvidenceFiles = this.claimEvidenceFiles.filter((_, i) => i !== index);
    });
  }

  async submitOwnershipClaim(): Promise<void> {
    const report = this.claimReport;
    if (!report || this.destroyed || this.claimSubmitting ||
        this.claimPhotoUploading || this.savedClaimId !== null) return;
    if (!this.canClaimOwnership(report)) {
      this.updateUI(() => {
        this.claimErrorMessage = !this.foundPetAvailabilityReady
          ? 'Unable to verify whether this pet is still available. Refresh the reports and try again.'
          : this.foundPetAvailability.has(report.id)
            ? 'This pet is currently reserved, disputed, or already returned. New claims are not being accepted.'
            : 'This Found Pet report is not available for your claim.';
      });
      return;
    }

    const proof = this.claimProofDescription.trim();
    if (proof.length < 10 || proof.length > 3000) {
      this.updateUI(() => {
        this.claimErrorMessage = 'Write 10 to 3000 characters describing your ownership evidence.';
      });
      return;
    }
    const selectedLostReport = this.claimLinkedLostReportId;
    const lostReportId = selectedLostReport === null ||
      selectedLostReport === undefined ||
      String(selectedLostReport).trim() === ''
        ? null : Number(selectedLostReport);
    if (lostReportId !== null &&
        (!Number.isInteger(lostReportId) ||
         !this.myLostPetReports.some(item => item.id === lostReportId))) {
      this.updateUI(() => {
        this.claimErrorMessage = 'Select a valid Lost Pet report from your account.';
      });
      return;
    }

    const files = [...this.claimEvidenceFiles];
    const formVersion = this.claimFormVersion;
    this.updateUI(() => {
      this.claimSubmitting = true;
      this.claimErrorMessage = '';
      this.claimPhotoWarning = '';
      this.claimPhotoUploadProgress = '';
    });

    try {
      const response = await firstValueFrom(
        this.reportsService.submitOwnershipClaim({
          found_report_id: report.id,
          proof_description: proof,
          linked_lost_report_id: lostReportId
        }).pipe(timeout(15000))
      );

      if (this.destroyed || formVersion !== this.claimFormVersion) return;
      if (!response.success || !Number.isInteger(response.claim_id)) {
        throw new Error(response.message || 'The server did not confirm your claim.');
      }

      this.updateUI(() => {
        this.locallySubmittedClaimReportIds.add(report.id);
        this.savedClaimId = response.claim_id;
        this.unuploadedClaimPhotos = files;
        this.claimSubmitting = false;
      });

      if (files.length > 0) {
        await this.uploadRemainingClaimEvidence(formVersion);
      } else {
        this.finishOwnershipClaim();
      }
    } catch (error: any) {
      if (this.destroyed || formVersion !== this.claimFormVersion) return;
      this.updateUI(() => {
        this.claimSubmitting = false;
        this.claimErrorMessage = error?.status === 409
          ? error?.error?.message || 'You already submitted a claim for this pet.'
          : error?.name === 'TimeoutError' || error?.status === 0
            ? 'Unable to confirm submission. Check your claims before trying again.'
            : error?.error?.message || error?.message || 'Unable to submit your claim.';
      });
    }
  }

  // Retry only evidence photos that have not uploaded successfully.
  async retryOwnershipEvidenceUpload(): Promise<void> {
    if (this.savedClaimId === null || this.claimPhotoUploading ||
        this.unuploadedClaimPhotos.length === 0) return;
    await this.uploadRemainingClaimEvidence(this.claimFormVersion);
  }

  private async uploadRemainingClaimEvidence(formVersion: number): Promise<void> {
    if (this.savedClaimId === null || this.claimPhotoUploading) return;
    const claimId = this.savedClaimId;
    this.updateUI(() => {
      this.claimPhotoUploading = true;
      this.claimPhotoWarning = '';
    });

    try {
      while (this.unuploadedClaimPhotos.length > 0) {
        if (this.destroyed || formVersion !== this.claimFormVersion) return;
        const nextPhoto = this.unuploadedClaimPhotos[0];
        const uploaded = this.claimEvidenceFiles.length - this.unuploadedClaimPhotos.length;
        this.updateUI(() => {
          this.claimPhotoUploadProgress =
            `Uploading evidence photo ${uploaded + 1} of ${this.claimEvidenceFiles.length}...`;
        });
        const response = await firstValueFrom(
          this.reportsService.uploadOwnershipClaimPhoto(claimId, nextPhoto)
            .pipe(timeout(30000))
        );
        if (!response.success) throw new Error(response.message || 'Unable to upload photo.');
        this.unuploadedClaimPhotos.shift();
      }
      if (this.destroyed || formVersion !== this.claimFormVersion) return;
      this.finishOwnershipClaim();
    } catch (error: any) {
      if (this.destroyed || formVersion !== this.claimFormVersion) return;
      this.updateUI(() => {
        this.claimPhotoWarning =
          'Your ownership claim was saved, but not all evidence photos were confirmed uploaded. ' +
          (error?.error?.message || error?.message || 'Please retry the remaining photos.');
        this.claimPhotoUploadProgress = '';
      });
    } finally {
      if (!this.destroyed && formVersion === this.claimFormVersion) {
        this.updateUI(() => { this.claimPhotoUploading = false; });
      }
    }
  }

  // A successful claim remains pending review by the Found Pet reporter.
  // Both a textual explanation and evidence images stay private.
  finishOwnershipClaim(): void {
    if (!this.claimReport || this.savedClaimId === null) return;
    this.updateUI(() => {
      this.claimSuccessMessage =
        'Ownership claim submitted. Waiting for the Found Pet reporter to review your evidence.';
      // Reset before the version changes. The upload loop's finally handler
      // skips stale versions, so it cannot reset this flag afterward.
      this.claimPhotoUploading = false;
      this.claimSubmitting = false;
      ++this.claimFormVersion;
      this.claimReport = null;
      this.claimProofDescription = '';
      this.claimLinkedLostReportId = null;
      this.claimEvidenceFiles = [];
      this.savedClaimId = null;
      this.unuploadedClaimPhotos = [];
      this.claimPhotoUploadProgress = '';
      this.claimPhotoWarning = '';
      this.claimErrorMessage = '';
    });
  }

  // =====================================
  // LOST PET RECOVERY — SUBMIT FINDING
  // =====================================

  // Availability is finalized by the PHP endpoint, because another
  // resident may be approved after this page loads. We never disclose
  // private recovery status in the public community feed.
  canReportFoundLostPet(report: PetReport): boolean {
    return this.ownershipEligibilityReady && this.submittedStatusReady &&
      report.report_type === 'lost' &&
      ['pending', 'under_review', 'in_progress'].includes(report.status) &&
      !this.myLostReportIds.has(report.id) &&
      !this.hasSubmittedRecovery(report);
  }

  openLostPetRecovery(report: PetReport): void {
    if (this.destroyed || this.claimReport || this.recoveryReport ||
        this.recoverySubmitting || this.recoveryPhotoUploading ||
        this.savedRecoveryId !== null || !this.canReportFoundLostPet(report)) return;

    this.closeLocationMap();
    this.closePhotoViewer();
    this.updateUI(() => {
      ++this.recoveryFormVersion;
      this.recoveryReport = report;
      this.recoveryFindingDescription = '';
      this.recoveryFoundLocation = '';
      this.recoveryFoundAt = '';
      this.recoveryFoundLatitude = null;
      this.recoveryFoundLongitude = null;
      this.recoveryLinkedFoundReportId = null;
      this.recoveryEvidenceFiles = [];
      this.recoveryErrorMessage = '';
      this.recoverySuccessMessage = '';
      this.recoveryPhotoWarning = '';
      this.recoveryPhotoUploadProgress = '';
      this.recoveryLocationLoading = false;
      this.savedRecoveryId = null;
      this.unuploadedRecoveryPhotos = [];
      this.recoveryPhotoUploadReport = null;
      this.recoveryPhotoUploadUncertain = false;
    });
  }

  closeLostPetRecovery(): void {
    if (this.recoverySubmitting || this.recoveryPhotoUploading) return;
    this.updateUI(() => {
      ++this.recoveryFormVersion;
      this.recoveryReport = null;
      this.recoveryFindingDescription = '';
      this.recoveryFoundLocation = '';
      this.recoveryFoundAt = '';
      this.recoveryFoundLatitude = null;
      this.recoveryFoundLongitude = null;
      this.recoveryLinkedFoundReportId = null;
      this.recoveryEvidenceFiles = [];
      this.recoveryErrorMessage = '';
      this.recoveryPhotoWarning = '';
      this.recoveryPhotoUploadProgress = '';
      this.recoveryLocationLoading = false;
      this.savedRecoveryId = null;
      this.unuploadedRecoveryPhotos = [];
      this.recoveryPhotoUploadReport = null;
      this.recoveryPhotoUploadUncertain = false;
    });
  }

  // Opt-in current position: only captured if the finder taps the
  // location button. Manual location remains required by the backend.
  async useCurrentLocationForRecovery(): Promise<void> {
    if (!this.recoveryReport || this.destroyed || this.recoverySubmitting ||
        this.recoveryPhotoUploading || this.savedRecoveryId !== null ||
        this.recoveryLocationLoading) return;

    const formVersion = this.recoveryFormVersion;
    this.updateUI(() => {
      this.recoveryLocationLoading = true;
      this.recoveryErrorMessage = '';
    });

    try {
      const { latitude, longitude } = await this.getDeviceCoordinates(20000);
      if (this.destroyed || formVersion !== this.recoveryFormVersion ||
          !this.recoveryReport) return;
      this.updateUI(() => {
        this.recoveryLocationLoading = false;
        this.recoveryFoundLatitude = latitude;
        this.recoveryFoundLongitude = longitude;
      });
    } catch (error) {
      if (this.destroyed || formVersion !== this.recoveryFormVersion ||
          !this.recoveryReport) return;
      this.updateUI(() => {
        this.recoveryLocationLoading = false;
        this.recoveryErrorMessage =
          this.gpsErrorMessage(error) + ' You can continue without GPS coordinates.';
      });
    }
  }

  clearRecoveryGps(): void {
    if (this.recoverySubmitting || this.recoveryPhotoUploading) return;
    this.updateUI(() => {
      this.recoveryFoundLatitude = null;
      this.recoveryFoundLongitude = null;
    });
  }

  onRecoveryEvidenceSelected(event: Event): void {
    if (this.destroyed || !this.recoveryReport || this.recoverySubmitting ||
        this.recoveryPhotoUploading || this.savedRecoveryId !== null) return;

    const input = event.target as HTMLInputElement | null;
    const selected = Array.from(input?.files ?? []);
    if (input) input.value = '';
    if (!selected.length) return;

    const combined = [...this.recoveryEvidenceFiles, ...selected];
    if (combined.length > 5) {
      this.updateUI(() => {
        this.recoveryErrorMessage = 'You can attach a maximum of 5 recovery evidence photos.';
      });
      return;
    }
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (combined.some(file =>
      !allowed.includes(file.type) || file.size === 0 || file.size > 5 * 1024 * 1024
    )) {
      this.updateUI(() => {
        this.recoveryErrorMessage = 'Each photo must be JPG, PNG, or WebP and no larger than 5 MB.';
      });
      return;
    }
    this.updateUI(() => {
      this.recoveryEvidenceFiles = combined;
      this.recoveryErrorMessage = '';
    });
  }

  removeRecoveryEvidencePhoto(index: number): void {
    if (this.recoverySubmitting || this.recoveryPhotoUploading ||
        this.savedRecoveryId !== null) return;
    this.updateUI(() => {
      this.recoveryEvidenceFiles = this.recoveryEvidenceFiles.filter((_, i) => i !== index);
    });
  }

  async submitLostPetRecovery(): Promise<void> {
    const report = this.recoveryReport;
    if (this.destroyed || !report || this.recoverySubmitting ||
        this.recoveryPhotoUploading || this.savedRecoveryId !== null) return;

    if (!this.canReportFoundLostPet(report)) {
      this.updateUI(() => {
        this.recoveryErrorMessage =
          'This Lost Pet report is not eligible for a new finding. Refresh the reports and try again.';
      });
      return;
    }

    const description = this.recoveryFindingDescription.trim();
    const foundLocation = this.recoveryFoundLocation.trim();
    if (description.length < 10 || description.length > 3000) {
      this.updateUI(() => {
        this.recoveryErrorMessage = 'Describe how and where you found the pet (10–3000 characters).';
      });
      return;
    }
    if (foundLocation.length < 5 || foundLocation.length > 255) {
      this.updateUI(() => {
        this.recoveryErrorMessage = 'Enter the found location (5–255 characters).';
      });
      return;
    }

    const selectedFoundReport = this.recoveryLinkedFoundReportId;
    const linkedFoundReportId = selectedFoundReport === null ||
      String(selectedFoundReport).trim() === ''
        ? null : Number(selectedFoundReport);
    if (linkedFoundReportId !== null &&
        (!Number.isInteger(linkedFoundReportId) ||
         !this.myFoundPetReports.some(item => item.id === linkedFoundReportId))) {
      this.updateUI(() => {
        this.recoveryErrorMessage = 'Select an active Found Pet report from your account.';
      });
      return;
    }

    if ((this.recoveryFoundLatitude === null) !==
        (this.recoveryFoundLongitude === null)) {
      this.updateUI(() => {
        this.recoveryErrorMessage = 'Provide both GPS coordinates or neither.';
      });
      return;
    }

    // HTML datetime-local sends YYYY-MM-DDTHH:MM in Asia/Manila local
    // time. Never append Z: the backend expects a local timestamp.
    const foundAt = this.recoveryFoundAt.trim();
    if (foundAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(foundAt)) {
      this.updateUI(() => {
        this.recoveryErrorMessage = 'Enter a valid date and time, or leave it empty.';
      });
      return;
    }
    if (foundAt) {
      const selected = new Date(foundAt);
      if (Number.isNaN(selected.getTime()) || selected.getTime() > Date.now()) {
        this.updateUI(() => {
          this.recoveryErrorMessage = 'The found date and time cannot be in the future.';
        });
        return;
      }
    }

    const request: SubmitLostPetRecoveryRequest = {
      lost_report_id: report.id,
      finding_description: description,
      found_location: foundLocation,
      found_latitude: this.recoveryFoundLatitude,
      found_longitude: this.recoveryFoundLongitude,
      found_at: foundAt || null,
      linked_found_report_id: linkedFoundReportId
    };
    const files = [...this.recoveryEvidenceFiles];
    const formVersion = this.recoveryFormVersion;
    const requestStartedAt = performance.now();
    this.updateUI(() => {
      this.recoverySubmitting = true;
      this.recoveryErrorMessage = '';
      this.recoveryPhotoWarning = '';
      this.recoveryPhotoUploadProgress = '';
    });

    try {
      const response = await firstValueFrom(
        this.reportsService.submitLostPetRecovery(request).pipe(timeout(15000))
      );
      if (this.destroyed || formVersion !== this.recoveryFormVersion) return;
      if (!response?.success || !Number.isInteger(response.recovery_id) ||
          response.recovery_id < 1) {
        throw new Error(response?.message || 'The server did not confirm your recovery submission.');
      }

            console.info(
        '[PawRescue Finding] Report confirmed by API in',
        Math.round(performance.now() - requestStartedAt),
        'ms. Recovery ID:',
        response.recovery_id
      );

      this.updateUI(() => {
        this.locallySubmittedRecoveryReportIds.add(report.id);
        this.savedRecoveryId = response.recovery_id;
        this.unuploadedRecoveryPhotos = files;
        this.recoveryPhotoUploadReport = report;
        this.recoveryPhotoUploadUncertain = false;
        this.recoverySubmitting = false;

        // The finding has been saved. Close the form immediately instead of
        // keeping it on-screen while separate evidence photos are uploaded.
        // Keep the recovery ID / pending files for safe retry without a new
        // submission if a photo upload receives a definite failure.
        this.recoveryReport = null;
        this.recoveryErrorMessage = '';
        this.recoverySuccessMessage = files.length
          ? `Finding saved successfully! Uploading ${files.length} evidence photo(s). Please keep this page open.`
          : 'Finding submitted successfully! The Lost Pet owner can now review it.';
      });
      // The confirmation banner sits above the feed. Reveal it as soon as
      // the modal closes instead of leaving the user at the old scroll spot.
      void this.pageContent?.scrollToTop(250);

      if (files.length) {
        // Intentionally not awaited: uploading evidence is a separate stage.
        // uploadRemainingRecoveryEvidence handles its own errors and retries.
        void this.uploadRemainingRecoveryEvidence(formVersion);
      } else {
        this.finishLostPetRecovery();
      }
    } catch (error: any) {
      if (this.destroyed || formVersion !== this.recoveryFormVersion) return;
      this.updateUI(() => {
        this.recoverySubmitting = false;
        this.recoveryErrorMessage = error?.status === 409
          ? error?.error?.message || 'A finding already exists, or this Lost Pet is no longer available.'
          : error?.status === 0 || error?.name === 'TimeoutError'
            ? 'Submission status is uncertain. Check My Recoveries before trying again to avoid duplicates.'
            : error?.error?.message || error?.message || 'Unable to submit the finding.';
      });
    }
  }

  async retryLostPetRecoveryEvidenceUpload(): Promise<void> {
    if (this.savedRecoveryId === null || this.recoveryPhotoUploading ||
        !this.unuploadedRecoveryPhotos.length) return;

    // A timeout / broken connection does not prove an upload failed.
    // A retry might create a duplicate photo, so require manual checking.
    if (this.recoveryPhotoUploadUncertain) {
      this.updateUI(() => {
        this.recoveryPhotoWarning =
          'The last photo may already be saved. Please check My Recoveries ' +
          'before attempting another upload, to avoid duplicates.';
      });
      return;
    }
    await this.uploadRemainingRecoveryEvidence(this.recoveryFormVersion);
  }

  private async uploadRemainingRecoveryEvidence(formVersion: number): Promise<void> {
    if (this.savedRecoveryId === null || this.recoveryPhotoUploading) return;
    const recoveryId = this.savedRecoveryId;
    this.updateUI(() => {
      this.recoveryPhotoUploading = true;
      this.recoveryPhotoWarning = '';
    });
    try {
      while (this.unuploadedRecoveryPhotos.length) {
        if (this.destroyed || formVersion !== this.recoveryFormVersion) return;
        const nextPhoto = this.unuploadedRecoveryPhotos[0];
        const uploaded = this.recoveryEvidenceFiles.length - this.unuploadedRecoveryPhotos.length;
        this.updateUI(() => {
          this.recoveryPhotoUploadProgress =
            `Uploading evidence photo ${uploaded + 1} of ${this.recoveryEvidenceFiles.length}...`;
          this.recoverySuccessMessage =
            `Finding saved! Uploading evidence photo ${uploaded + 1} of ` +
            `${this.recoveryEvidenceFiles.length}. Please keep this page open.`;
        });

        const photoStartedAt = performance.now();
        const response = await firstValueFrom(
          this.reportsService.uploadLostPetRecoveryPhoto(recoveryId, nextPhoto)
            .pipe(timeout(30000))
        );
        if (!response?.success) throw new Error(response?.message || 'Unable to upload photo.');
        this.unuploadedRecoveryPhotos.shift();
        console.info(
          `[PawRescue Finding] Evidence photo ${uploaded + 1} uploaded in`,
          Math.round(performance.now() - photoStartedAt),
          'ms'
        );
      }
      if (this.destroyed || formVersion !== this.recoveryFormVersion) return;
      this.finishLostPetRecovery();
    } catch (error: any) {
      if (this.destroyed || formVersion !== this.recoveryFormVersion) return;
      this.updateUI(() => {
        this.recoveryPhotoUploadUncertain =
          error?.name === 'TimeoutError' ||
          error?.status === 0 ||
          (typeof error?.status === 'number' && error.status >= 500);
        this.recoveryPhotoWarning = this.recoveryPhotoUploadUncertain
          ? 'Your finding is saved, but the last photo may also have uploaded. ' +
            'Check My Recoveries before retrying to prevent duplicates.'
          : 'Your finding is saved, but an evidence photo could not be uploaded. ' +
            (error?.error?.message || error?.message || 'You may retry the remaining photos.');
        this.recoveryPhotoUploadProgress = '';
        this.recoverySuccessMessage =
          'Finding report saved. Some evidence photos need attention.';
        // Reopen the existing recovery details to offer the safe photo-retry
        // state. Do not reopen the original finding submission form.
        this.recoveryReport = this.recoveryPhotoUploadReport;
      });
    } finally {
      if (!this.destroyed && formVersion === this.recoveryFormVersion) {
        this.updateUI(() => { this.recoveryPhotoUploading = false; });
      }
    }
  }

  finishLostPetRecovery(): void {
    // The modal has already been dismissed after API confirmation.
    // Finishing uploads must not depend on recoveryReport still being open.
    if (this.savedRecoveryId === null) return;
    this.updateUI(() => {
      this.recoverySuccessMessage =
        'Finding submitted successfully. The Lost Pet owner can now review your evidence.';
      // Critical: finish increments recoveryFormVersion, which prevents the
      // old async upload finally block from clearing recoveryPhotoUploading.
      // Clear it here so loading can never remain stuck after success.
      this.recoveryPhotoUploading = false;
      this.recoverySubmitting = false;
      ++this.recoveryFormVersion;
      this.recoveryReport = null;
      this.recoveryFindingDescription = '';
      this.recoveryFoundLocation = '';
      this.recoveryFoundAt = '';
      this.recoveryFoundLatitude = null;
      this.recoveryFoundLongitude = null;
      this.recoveryLinkedFoundReportId = null;
      this.recoveryEvidenceFiles = [];
      this.savedRecoveryId = null;
      this.unuploadedRecoveryPhotos = [];
      this.recoveryPhotoUploadReport = null;
      this.recoveryPhotoUploadUncertain = false;
      this.recoveryPhotoUploadProgress = '';
      this.recoveryPhotoWarning = '';
      this.recoveryErrorMessage = '';
    });
  }
  // =====================================
  // NAVIGATION
  // =====================================
  goBack() {
    this.closePhotoViewer();
    this.closeLocationMap();
    this.router.navigateByUrl('/home');
  }
  reportPet() {
    this.closePhotoViewer();
    this.closeLocationMap();
    this.router.navigateByUrl('/report-pet');
  }

  // Open the dedicated My Claims page without a full-page reload.
  // Claims and handover management live on this separate page.
  goToMyClaims(): void {
    if (this.destroyed) return;
    this.closePhotoViewer();
    this.closeLocationMap();
    this.router.navigateByUrl('/my-claims');
  }

  // View sent and received Lost Pet recovery submissions.
  // Matches the existing My Claims navigation behavior.
  goToMyRecoveries(): void {
    if (this.destroyed) return;
    this.closePhotoViewer();
    this.closeLocationMap();
    this.router.navigateByUrl('/my-recoveries');
  }
  // =====================================
  // PAGE CLEANUP
  // =====================================
  ngOnDestroy() {
    ++this.submittedStatusVersion;
    ++this.nearbyRequestVersion;
    this.destroyed = true;
    this.request?.unsubscribe();
    this.myReportsRequest?.unsubscribe();
    this.foundPetAvailabilityRequest?.unsubscribe();
    ++this.eligibilityRequestVersion;
    ++this.foundPetAvailabilityRequestVersion;
    ++this.claimFormVersion;
    ++this.recoveryFormVersion;
    this.foundPetAvailability.clear();
    this.myFoundReportIds.clear();
    this.myLostReportIds.clear();
    this.myFoundPetReports = [];
    this.myLostPetReports = [];
    this.claimEvidenceFiles = [];
    this.unuploadedClaimPhotos = [];
    this.recoveryEvidenceFiles = [];
    this.unuploadedRecoveryPhotos = [];
    this.recoveryReport = null;
    this.photoViewerReport = null;
    this.resetPhotoTouch();
    this.photoIndexes.clear();
    this.brokenPhotoUrls.clear();
    this.destroyReportMap();
  }
}