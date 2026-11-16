import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { IonContent, IonIcon, IonSpinner } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  pawOutline,
  refreshOutline,
  closeOutline,
  checkmarkCircleOutline,
  shieldCheckmarkOutline,
  calendarOutline,
  timeOutline,
  locationOutline,
  navigateOutline,
  imageOutline,
  imagesOutline,
  chevronForwardOutline,
  alertCircleOutline,
  documentTextOutline,
  checkmarkOutline,
  closeCircleOutline
} from 'ionicons/icons';
import {
  Subscription,
  catchError,
  finalize,
  forkJoin,
  map,
  of,
  timeout
} from 'rxjs';
import {
  PetReportsService,
  LostPetRecovery,
  LostPetRecoveryEvidencePhoto,
  LostPetRecoveryStatus,
  LostPetRecoveryDecisionRequest,
  RequestLostPetRecoveryRescheduleRequest
} from '../../services/pet-reports';

type RecoveryTab = 'sent' | 'received';
type RecoveryFormMode = 'approve' | 'reject' | 'reschedule' | null;

type RecoveryListState = {
  items: LostPetRecovery[];
  loading: boolean;
  loadingMore: boolean;
  loaded: boolean;
  error: string;
  total: number;
  hasMore: boolean;
  nextOffset: number;
};

type RecoveryPrivatePhoto = {
  id: number;
  url: SafeUrl;
  objectUrl?: string;
};

/**
 * Private Lost Pet recovery management.
 *
 * SENT = finder who reported finding another person's missing pet.
 * RECEIVED = owner of the original Lost Pet report.
 *
 * IMPORTANT:
 *  - This page does not modify the public community report feed.
 *  - The PHP endpoints authorize every request; UI checks are conveniences only.
 *  - Evidence photos are fetched using authenticated requests, never public URLs.
 *  - The backend alone decides when both handover confirmations resolve the report.
 *
 * Other files (HTML, SCSS, route and navigation button) are added in later steps.
 */
@Component({
  selector: 'app-my-recoveries',
  templateUrl: './my-recoveries.page.html',
  styleUrls: ['./my-recoveries.page.scss'],
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent, IonIcon, IonSpinner]
})
export class MyRecoveriesPage implements OnInit, OnDestroy {
  private readonly reportsService = inject(PetReportsService);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly zone = inject(NgZone);

  private destroyed = false;
  private firstPageEntry = true;
  private readonly pageSize = 20;
  private readonly requests: Record<RecoveryTab, Subscription | undefined> = {
    sent: undefined,
    received: undefined
  };
  private readonly listVersions: Record<RecoveryTab, number> = {
    sent: 0,
    received: 0
  };
  private detailRequest?: Subscription;
  private detailVersion = 0;
  private photoRequest?: Subscription;
  private photoVersion = 0;
  private actionRequest?: Subscription;
  private actionVersion = 0;

  activeTab: RecoveryTab = 'sent';
  readonly lists: Record<RecoveryTab, RecoveryListState> = {
    sent: this.emptyList(),
    received: this.emptyList()
  };

  selectedRecovery: LostPetRecovery | null = null;
  selectedScope: RecoveryTab | null = null;
  detailLoading = false;
  detailError = '';
  actionError = '';
  actionMessage = '';
  actionBusy = false;

  // Private evidence is shown inside View Details only, never in public cards.
  evidencePhotos: RecoveryPrivatePhoto[] = [];
  evidenceLoading = false;
  evidenceError = '';

  formMode: RecoveryFormMode = null;
  actionModal: 'pickup' | 'handover' | 'reschedule_response' | null = null;
  pickupLocation = '';
  pickupDate = '';
  pickupTime = '';
  pickupLatitude: number | null = null;
  pickupLongitude: number | null = null;
  pickupLocationLoading = false;
  rejectionReason = '';
  rescheduleReason = '';
  responseNote = '';
  handoverAcknowledged = false;

  constructor() {
    addIcons({
      arrowBackOutline,
      pawOutline,
      refreshOutline,
      closeOutline,
      checkmarkCircleOutline,
      shieldCheckmarkOutline,
      calendarOutline,
      timeOutline,
      locationOutline,
      navigateOutline,
      imageOutline,
      imagesOutline,
      chevronForwardOutline,
      alertCircleOutline,
      documentTextOutline,
      checkmarkOutline,
      closeCircleOutline
    });
  }

  private emptyList(): RecoveryListState {
    return {
      items: [],
      loading: false,
      loadingMore: false,
      loaded: false,
      error: '',
      total: 0,
      hasMore: false,
      nextOffset: 0
    };
  }

  private render(change: () => void): void {
    if (this.destroyed) return;
    this.zone.run(() => {
      if (this.destroyed) return;
      change();
      this.cdr.detectChanges();
    });
  }

  get currentList(): RecoveryListState {
    return this.lists[this.activeTab];
  }

  get minPickupDate(): string {
    // Assemble an ISO date from Philippines-local parts (WebView locales vary).
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const value = (type: string): string => parts.find(part => part.type === type)?.value || '';
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  trackRecovery(_index: number, recovery: LostPetRecovery): number {
    return recovery.id;
  }

  trackEvidence(_index: number, photo: RecoveryPrivatePhoto): number {
    return photo.id;
  }

  getStatusLabel(status: LostPetRecoveryStatus): string {
    const labels: Record<LostPetRecoveryStatus, string> = {
      pending: 'Pending Review',
      approved: 'Approved',
      pickup_scheduled: 'Pickup Scheduled',
      reschedule_requested: 'Reschedule Requested',
      rejected: 'Rejected',
      cancelled: 'Cancelled',
      completed: 'Completed',
      disputed: 'Under Dispute'
    };
    return labels[status] || status;
  }

  getPendingCount(scope: RecoveryTab): number {
    return this.lists[scope].items.filter(item => item.status === 'pending').length;
  }

  getNextStep(recovery: LostPetRecovery, scope: RecoveryTab): string {
    if (recovery.status === 'pending') {
      return scope === 'received'
        ? 'Review the finding details and evidence.'
        : 'Waiting for the pet owner to review your submission.';
    }
    if (recovery.status === 'reschedule_requested') {
      const request = recovery.latest_reschedule;
      if (!request || request.status !== 'pending') {
        return 'Pickup reschedule is being processed.';
      }
      return request.requested_by_user_id === this.participantId(recovery, scope)
        ? 'Waiting for the other resident to respond to your schedule request.'
        : 'Review the proposed new pickup arrangement.';
    }
    if (recovery.status === 'pickup_scheduled' || recovery.status === 'approved') {
      if (!recovery.pickup.finder_confirmed_at) {
        return scope === 'sent'
          ? 'Please confirm the pickup arrangement.'
          : 'Waiting for the finder to confirm the pickup arrangement.';
      }
      if (recovery.owner_handover_confirmed_at && recovery.finder_handover_confirmed_at) {
        return 'Both participants have confirmed the handover.';
      }
      if (scope === 'sent' && !recovery.finder_handover_confirmed_at) {
        return 'After returning the pet, confirm the actual handover.';
      }
      if (scope === 'received' && !recovery.owner_handover_confirmed_at) {
        return 'After receiving the pet, confirm the actual handover.';
      }
      return 'Waiting for the other resident to confirm the actual handover.';
    }
    if (recovery.status === 'completed') return 'Pet handover completed and Lost Pet report resolved.';
    if (recovery.status === 'rejected') return 'The pet owner rejected this finding submission.';
    if (recovery.status === 'cancelled') return 'This recovery submission is no longer active.';
    if (recovery.status === 'disputed') return 'This recovery requires further review.';
    return 'View the recovery details.';
  }

  private participantId(recovery: LostPetRecovery, scope: RecoveryTab): number {
    return scope === 'received' ? recovery.owner_user_id : recovery.finder_user_id;
  }

  // =====================================
  // SENT / RECEIVED RECOVERY LISTS
  // =====================================
  loadRecoveries(scope: RecoveryTab = this.activeTab, loadMore = false): void {
    if (this.destroyed) return;
    const current = this.lists[scope];
    if (this.actionBusy || current.loading || current.loadingMore) return;
    if (loadMore && !current.hasMore) return;

    const version = ++this.listVersions[scope];
    this.requests[scope]?.unsubscribe();
    const offset = loadMore ? current.nextOffset : 0;
    this.render(() => {
      current.error = '';
      current.loading = !loadMore;
      current.loadingMore = loadMore;
    });

    this.requests[scope] = this.reportsService.getLostPetRecoveries(scope, {
      limit: this.pageSize,
      offset
    }).pipe(timeout(15000)).subscribe({
      next: response => {
        if (this.destroyed || version !== this.listVersions[scope]) return;
        this.render(() => {
          current.loading = false;
          current.loadingMore = false;
          if (!response.success) {
            current.error = response.message || 'Unable to load recoveries.';
            return;
          }
          const items = Array.isArray(response.recoveries) ? response.recoveries : [];
          current.items = loadMore
            ? [...current.items, ...items.filter(item => !current.items.some(existing => existing.id === item.id))]
            : items;
          current.total = response.total;
          current.hasMore = response.has_more;
          current.nextOffset = response.offset + response.count;
          current.loaded = true;
        });
      },
      error: error => {
        if (this.destroyed || version !== this.listVersions[scope]) return;
        this.render(() => {
          current.loading = false;
          current.loadingMore = false;
          current.error = this.apiError(error, 'Unable to load recoveries. Please retry.');
        });
      }
    });
  }

  loadMore(): void {
    this.loadRecoveries(this.activeTab, true);
  }

  refreshRecoveries(): void {
    if (this.actionBusy || this.destroyed) return;
    this.loadRecoveries(this.activeTab);
    if (this.selectedRecovery && this.selectedScope) this.refreshSelectedRecovery();
  }

  changeTab(tab: RecoveryTab): void {
    if (this.destroyed || this.activeTab === tab || this.actionBusy) return;
    this.closeDetails();
    this.activeTab = tab;
    if (!this.lists[tab].loaded) this.loadRecoveries(tab);
  }

  // =====================================
  // PRIVATE VIEW DETAILS
  // =====================================
  openDetails(recovery: LostPetRecovery, scope: RecoveryTab = this.activeTab): void {
    if (this.destroyed || this.actionBusy) return;
    this.closeDetails();
    this.selectedScope = scope;
    this.selectedRecovery = recovery;
    this.loadEvidencePhotos(recovery);
    this.refreshSelectedRecovery();
  }

  closeDetails(): void {
    if (this.actionBusy) return; // Never hide a submitting mutation mid-request.
    ++this.detailVersion;
    this.detailRequest?.unsubscribe();
    this.clearEvidencePhotos();
    this.selectedRecovery = null;
    this.selectedScope = null;
    this.detailLoading = false;
    this.detailError = '';
    this.actionError = '';
    this.actionMessage = '';
    this.formMode = null;
    this.actionModal = null;
    this.handoverAcknowledged = false;
  }

  private refreshSelectedRecovery(): void {
    const recovery = this.selectedRecovery;
    const scope = this.selectedScope;
    if (!recovery || !scope || this.destroyed) return;
    const id = recovery.id;
    const version = ++this.detailVersion;
    this.detailRequest?.unsubscribe();
    this.render(() => { this.detailLoading = true; this.detailError = ''; });
    this.detailRequest = this.reportsService.getLostPetRecoveries(scope, {
      recoveryId: id, limit: 1
    }).pipe(timeout(15000)).subscribe({
      next: response => {
        if (this.destroyed || version !== this.detailVersion ||
            this.selectedRecovery?.id !== id || this.selectedScope !== scope) return;
        this.render(() => {
          this.detailLoading = false;
          const fresh = response.recoveries?.[0];
          if (!response.success || !fresh) {
            this.detailError = response.message || 'Unable to refresh recovery details.';
            return;
          }
          this.selectedRecovery = fresh;
          this.lists[scope].items = this.lists[scope].items.map(item => item.id === id ? fresh : item);
          // Evidence IDs might change during pending status; reload only on difference.
          const currentIds = this.evidencePhotos.map(photo => photo.id).sort().join(',');
          const incomingIds = fresh.evidence_photos.map(photo => photo.id).sort().join(',');
          if (currentIds !== incomingIds && !this.evidenceLoading) this.loadEvidencePhotos(fresh);
        });
      },
      error: error => {
        if (this.destroyed || version !== this.detailVersion || this.selectedRecovery?.id !== id) return;
        this.render(() => {
          this.detailLoading = false;
          this.detailError = this.apiError(error, 'Unable to refresh recovery details.');
        });
      }
    });
  }

  private clearEvidencePhotos(): void {
    ++this.photoVersion;
    this.photoRequest?.unsubscribe();
    for (const photo of this.evidencePhotos) {
      if (photo.objectUrl) URL.revokeObjectURL(photo.objectUrl);
    }
    this.evidencePhotos = [];
    this.evidenceLoading = false;
    this.evidenceError = '';
  }

  private async toDataUrl(blob: Blob): Promise<string | null> {
    try {
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  private async prepareEvidencePhoto(id: number, blob: Blob): Promise<RecoveryPrivatePhoto | null> {
    const mime = (blob.type || '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime) ||
        blob.size === 0 || blob.size > 5 * 1024 * 1024) return null;

    const magic = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const jpeg = magic.length >= 3 && magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff;
    const png = magic.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => magic[i] === b);
    const webp = magic.length >= 12 &&
      String.fromCharCode(...magic.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...magic.slice(8, 12)) === 'WEBP';
    if (!((mime === 'image/jpeg' && jpeg) || (mime === 'image/png' && png) ||
          (mime === 'image/webp' && webp))) return null;

    // Android WebViews may fail to display blob: URLs; use verified data: on native.
    if (Capacitor.isNativePlatform()) {
      const src = await this.toDataUrl(blob);
      return src ? { id, url: this.sanitizer.bypassSecurityTrustUrl(src) } : null;
    }
    const objectUrl = URL.createObjectURL(blob);
    return { id, url: this.sanitizer.bypassSecurityTrustUrl(objectUrl), objectUrl };
  }

  loadEvidencePhotos(recovery: LostPetRecovery = this.selectedRecovery!): void {
    if (!recovery || this.destroyed) return;
    this.clearEvidencePhotos();
    const photos = Array.isArray(recovery.evidence_photos) ? recovery.evidence_photos.slice(0, 5) : [];
    if (!photos.length) return;
    const recoveryId = recovery.id;
    const version = ++this.photoVersion;
    this.render(() => { this.evidenceLoading = true; });
    const requests = photos.map((photo: LostPetRecoveryEvidencePhoto) =>
      this.reportsService.getLostPetRecoveryEvidencePhoto(photo.id).pipe(
        timeout(15000),
        map(blob => ({ id: photo.id, blob })),
        catchError(() => of(null))
      )
    );
    this.photoRequest = forkJoin(requests).subscribe({
      next: async results => {
        const converted = await Promise.all(results.map(async result =>
          result ? this.prepareEvidencePhoto(result.id, result.blob) : null
        ));
        const good = converted.filter((entry): entry is RecoveryPrivatePhoto => entry !== null);
        if (this.destroyed || version !== this.photoVersion || this.selectedRecovery?.id !== recoveryId) {
          good.forEach(photo => { if (photo.objectUrl) URL.revokeObjectURL(photo.objectUrl); });
          return;
        }
        this.render(() => {
          this.evidenceLoading = false;
          this.evidencePhotos = good;
          if (good.length !== photos.length) {
            this.evidenceError = good.length
              ? 'Some photos could not be displayed. You can retry loading the evidence.'
              : 'Private evidence could not be displayed. Please retry.';
          }
        });
      },
      error: () => {
        if (this.destroyed || version !== this.photoVersion) return;
        this.render(() => {
          this.evidenceLoading = false;
          this.evidenceError = 'Unable to retrieve private evidence photos.';
        });
      }
    });
  }

  // =====================================
  // ACTION ELIGIBILITY — SERVER ALWAYS RECHECKS
  // =====================================
  get isOwner(): boolean { return this.selectedScope === 'received'; }
  get isFinder(): boolean { return this.selectedScope === 'sent'; }

  get canReview(): boolean {
    return this.isOwner && this.selectedRecovery?.status === 'pending' && !this.actionBusy;
  }

  get canConfirmPickup(): boolean {
    const r = this.selectedRecovery;
    return !!(r && this.isFinder && r.status === 'pickup_scheduled' &&
      !r.pickup.finder_confirmed_at && r.latest_reschedule?.status !== 'pending' && !this.actionBusy);
  }

  get canRequestReschedule(): boolean {
    const r = this.selectedRecovery;
    return !!(r && r.status === 'pickup_scheduled' &&
      r.latest_reschedule?.status !== 'pending' &&
      !r.owner_handover_confirmed_at && !r.finder_handover_confirmed_at && !this.actionBusy);
  }

  get canRespondReschedule(): boolean {
    const r = this.selectedRecovery;
    const scope = this.selectedScope;
    return !!(r && scope && r.status === 'reschedule_requested' &&
      r.latest_reschedule?.status === 'pending' &&
      r.latest_reschedule.requested_by_user_id !== this.participantId(r, scope) &&
      !this.actionBusy);
  }

  get canConfirmHandover(): boolean {
    const r = this.selectedRecovery;
    return !!(r && r.status === 'pickup_scheduled' &&
      !!r.pickup.finder_confirmed_at && r.latest_reschedule?.status !== 'pending' &&
      (this.isOwner ? !r.owner_handover_confirmed_at : this.isFinder && !r.finder_handover_confirmed_at) &&
      !this.actionBusy);
  }

  // =====================================
  // APPROVAL / REJECTION / PICKUP FORMS
  // =====================================
  startApproval(): void {
    if (!this.canReview) return;
    this.resetForm();
    this.formMode = 'approve';
  }

  startRejection(): void {
    if (!this.canReview) return;
    this.resetForm();
    this.formMode = 'reject';
  }

  startReschedule(): void {
    const r = this.selectedRecovery;
    if (!r || !this.canRequestReschedule) return;
    this.resetForm();
    this.formMode = 'reschedule';
    this.pickupLocation = r.pickup.location || '';
    this.pickupDate = r.pickup.date || '';
    this.pickupTime = (r.pickup.time || '').slice(0, 5);
  }

  openActionModal(mode: 'pickup' | 'handover' | 'reschedule_response'): void {
    if (this.actionBusy || this.detailLoading || !this.selectedRecovery) return;
    if (mode === 'pickup' && !this.canConfirmPickup) return;
    if (mode === 'handover' && !this.canConfirmHandover) return;
    if (mode === 'reschedule_response' && !this.canRespondReschedule) return;
    this.actionError = '';
    this.actionModal = mode;
    this.handoverAcknowledged = false;
    this.responseNote = '';
  }

  closeActionModal(): void {
    if (this.actionBusy || this.pickupLocationLoading) return;
    this.actionModal = null;
    this.resetForm();
  }

  cancelForm(): void {
    if (this.actionBusy || this.pickupLocationLoading) return;
    this.resetForm();
  }

  private resetForm(): void {
    this.formMode = null;
    this.actionModal = null;
    this.pickupLocation = '';
    this.pickupDate = '';
    this.pickupTime = '';
    this.pickupLatitude = null;
    this.pickupLongitude = null;
    this.rejectionReason = '';
    this.rescheduleReason = '';
    this.responseNote = '';
    this.actionError = '';
  }

  onPickupLocationChanged(value: string): void {
    // A manually edited address must never keep a pin from a different place.
    this.pickupLocation = value;
    this.pickupLatitude = null;
    this.pickupLongitude = null;
  }

  async capturePickupLocation(): Promise<void> {
    if (this.actionBusy || this.pickupLocationLoading ||
        (this.formMode !== 'approve' && this.formMode !== 'reschedule')) return;
    this.pickupLocationLoading = true;
    this.actionError = '';
    try {
      const permissions = await Geolocation.checkPermissions();
      if (permissions.location !== 'granted' && permissions.coarseLocation !== 'granted') {
        const requested = await Geolocation.requestPermissions();
        if (requested.location !== 'granted' && requested.coarseLocation !== 'granted') {
          throw new Error('Location access was not allowed. You can enter the pickup location manually.');
        }
      }
      const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 12000 });
      this.render(() => {
        this.pickupLatitude = position.coords.latitude;
        this.pickupLongitude = position.coords.longitude;
      });
    } catch (error: unknown) {
      this.render(() => {
        this.actionError = error instanceof Error ? error.message :
          'Unable to get your GPS location. Enter the pickup location manually.';
      });
    } finally {
      this.render(() => { this.pickupLocationLoading = false; });
    }
  }

  private validPickupFields(): boolean {
    const location = this.pickupLocation.trim();
    const date = this.pickupDate.trim();
    const time = this.pickupTime.trim();
    if (location.length < 5 || location.length > 255 || /[\r\n]/.test(location)) {
      this.actionError = 'Enter a pickup location with 5 to 255 characters.';
      return false;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      this.actionError = 'Select a valid pickup date and time.';
      return false;
    }
    // Compare the target wall-clock time in Asia/Manila. The PHP server is authoritative.
    const scheduledAt = Date.parse(`${date}T${time}:00+08:00`);
    if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) {
      this.actionError = 'Choose a future pickup date and time (Philippine time).';
      return false;
    }
    return true;
  }

  submitDecision(): void {
    const r = this.selectedRecovery;
    // Narrow the action to the only two values accepted by respond_recovery.php.
    // Rescheduling has its own API method and must not be sent here.
    if (!r || !this.canReview ||
        (this.formMode !== 'approve' && this.formMode !== 'reject')) return;
    if (this.formMode === 'approve' && !this.validPickupFields()) return;
    const data: LostPetRecoveryDecisionRequest = {
      recovery_id: r.id,
      action: this.formMode
    };
    if (this.formMode === 'approve') {
      data.pickup_location = this.pickupLocation.trim();
      data.pickup_date = this.pickupDate;
      data.pickup_time = this.pickupTime;
      if (this.pickupLatitude !== null && this.pickupLongitude !== null) {
        data.pickup_latitude = this.pickupLatitude;
        data.pickup_longitude = this.pickupLongitude;
      }
    } else {
      data.rejection_reason = this.rejectionReason.trim() || null;
    }
    this.executeAction(this.reportsService.respondLostPetRecovery(data),
      'Recovery decision saved.');
  }

  confirmPickup(): void {
    const r = this.selectedRecovery;
    if (!r || !this.canConfirmPickup) return;
    this.executeAction(this.reportsService.confirmLostPetRecoveryPickup(r.id),
      'Pickup arrangement confirmed.');
  }

  requestReschedule(): void {
    const r = this.selectedRecovery;
    if (!r || this.formMode !== 'reschedule' || !this.canRequestReschedule ||
        !this.validPickupFields()) return;
    const data: RequestLostPetRecoveryRescheduleRequest = {
      recovery_id: r.id,
      pickup_location: this.pickupLocation.trim(),
      pickup_date: this.pickupDate,
      pickup_time: this.pickupTime,
      reason: this.rescheduleReason.trim() || null
    };
    // When coordinates were not explicitly refreshed, do not reuse stale GPS.
    if (this.pickupLatitude !== null && this.pickupLongitude !== null) {
      data.pickup_latitude = this.pickupLatitude;
      data.pickup_longitude = this.pickupLongitude;
    }
    this.executeAction(this.reportsService.requestLostPetRecoveryReschedule(data),
      'Reschedule request sent.');
  }

  respondReschedule(action: 'accept' | 'reject'): void {
    const r = this.selectedRecovery;
    if (!r || !this.canRespondReschedule || !r.latest_reschedule) return;
    this.executeAction(this.reportsService.respondLostPetRecoveryReschedule({
      recovery_id: r.id,
      reschedule_id: r.latest_reschedule.id,
      action,
      response_note: this.responseNote.trim() || null
    }), action === 'accept' ? 'Pickup reschedule accepted.' : 'Pickup reschedule rejected.');
  }

  confirmHandover(): void {
    const r = this.selectedRecovery;
    if (!r || !this.canConfirmHandover || !this.handoverAcknowledged) {
      this.actionError = 'Confirm that the pet was physically handed over before proceeding.';
      return;
    }
    // This is a factual attestation; never auto-confirm on page open or pickup agreement.
    this.executeAction(this.reportsService.confirmLostPetRecoveryHandover(r.id),
      'Actual pet handover confirmation saved.');
  }

  private executeAction<T extends { success: boolean; message: string }>(
    request: import('rxjs').Observable<T>,
    fallbackMessage: string
  ): void {
    if (this.destroyed || this.actionBusy || !this.selectedRecovery || !this.selectedScope) return;
    const currentId = this.selectedRecovery.id;
    const scope = this.selectedScope;
    const version = ++this.actionVersion;
    this.actionRequest?.unsubscribe();
    this.render(() => {
      this.actionBusy = true;
      this.actionError = '';
      this.actionMessage = '';
    });
    this.actionRequest = request.pipe(
      timeout(18000),
      finalize(() => {
        if (this.destroyed || version !== this.actionVersion) return;
        this.render(() => { this.actionBusy = false; });
      })
    ).subscribe({
      next: response => {
        if (this.destroyed || version !== this.actionVersion ||
            this.selectedRecovery?.id !== currentId || this.selectedScope !== scope) return;
        if (!response.success) {
          this.render(() => { this.actionError = response.message || 'Unable to complete the request.'; });
          return;
        }
        this.render(() => {
          this.actionMessage = response.message || fallbackMessage;
          this.formMode = null;
          this.actionModal = null;
          this.handoverAcknowledged = false;
          this.responseNote = '';
        });
        // Server's current status/confirmation timestamps are authoritative.
        this.refreshSelectedRecovery();
        // Refresh both lists; a decision can cancel other pending requests.
        // Defer refresh until finalize has released actionBusy.
        this.reloadListsAfterAction();
      },
      error: error => {
        if (this.destroyed || version !== this.actionVersion) return;
        this.render(() => {
          this.actionError = this.apiError(error, 'Unable to complete the action. Please retry.');
        });
      }
    });
  }

  private reloadListsAfterAction(): void {
    // Do not create timers or background polling. Explicit refresh will also
    // work if the API is still catching up or a request was cancelled.
    for (const scope of ['sent', 'received'] as const) {
      const list = this.lists[scope];
      ++this.listVersions[scope];
      this.requests[scope]?.unsubscribe();
      list.loading = false;
      list.loadingMore = false;
    }
    this.loadRecoveriesAfterMutation('sent');
    this.loadRecoveriesAfterMutation('received');
  }

  private loadRecoveriesAfterMutation(scope: RecoveryTab): void {
    // This method intentionally bypasses the actionBusy guard: the mutation
    // has already succeeded and the UI must promptly reflect server state.
    const version = ++this.listVersions[scope];
    const list = this.lists[scope];
    this.requests[scope]?.unsubscribe();
    this.requests[scope] = this.reportsService.getLostPetRecoveries(scope, {
      limit: this.pageSize, offset: 0
    }).pipe(timeout(15000)).subscribe({
      next: response => {
        if (this.destroyed || version !== this.listVersions[scope]) return;
        this.render(() => {
          if (!response.success) { list.error = response.message; return; }
          list.items = response.recoveries || [];
          list.total = response.total;
          list.nextOffset = response.offset + response.count;
          list.hasMore = response.has_more;
          list.loaded = true;
          list.error = '';
        });
      },
      error: error => {
        if (this.destroyed || version !== this.listVersions[scope]) return;
        this.render(() => { list.error = this.apiError(error, 'Unable to refresh recovery list.'); });
      }
    });
  }

  private apiError(error: any, fallback: string): string {
    if (error?.name === 'TimeoutError') return 'The server is taking too long. Please try again.';
    return typeof error?.error?.message === 'string' ? error.error.message : fallback;
  }

  goBack(): void {
    if (this.actionBusy) return;
    this.closeDetails();
    void this.router.navigateByUrl('/lost-found');
  }

  // =====================================
  // LIFECYCLE AND PRIVATE PHOTO CLEANUP
  // =====================================
  ngOnInit(): void {
    this.loadRecoveries('sent');
    this.loadRecoveries('received');
  }

  ionViewWillEnter(): void {
    if (this.firstPageEntry) { this.firstPageEntry = false; return; }
    if (!this.actionBusy) {
      this.loadRecoveries('sent');
      this.loadRecoveries('received');
    }
  }

  ionViewDidLeave(): void {
    this.cleanupRequests();
  }

  private cleanupRequests(): void {
    ++this.detailVersion;
    ++this.photoVersion;
    ++this.actionVersion;
    for (const scope of ['sent', 'received'] as const) {
      ++this.listVersions[scope];
      this.requests[scope]?.unsubscribe();
      this.lists[scope].loading = false;
      this.lists[scope].loadingMore = false;
    }
    this.detailRequest?.unsubscribe();
    this.actionRequest?.unsubscribe();
    this.clearEvidencePhotos();
    this.selectedRecovery = null;
    this.selectedScope = null;
    this.detailLoading = false;
    this.actionBusy = false;
    this.formMode = null;
    this.actionModal = null;
    this.handoverAcknowledged = false;
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.cleanupRequests();
  }
}
