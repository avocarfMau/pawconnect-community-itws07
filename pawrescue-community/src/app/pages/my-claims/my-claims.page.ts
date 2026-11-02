import { Component, OnInit, OnDestroy, ChangeDetectorRef, NgZone, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { Geolocation } from '@capacitor/geolocation';
import { Capacitor } from '@capacitor/core';
import { IonContent, IonIcon, IonSpinner } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  pawOutline,
  calendarOutline,
  locationOutline,
  closeOutline,
  refreshOutline,
  alertCircleOutline,
  imageOutline,
  checkmarkCircleOutline,
  shieldCheckmarkOutline,
  imagesOutline,
  timeOutline,
  navigateOutline,
  checkmarkOutline,
  closeCircleOutline,
  chevronForwardOutline,
  chevronBackOutline,
  documentTextOutline
} from 'ionicons/icons';
import { Subscription, finalize, timeout, forkJoin, of, catchError, map } from 'rxjs';
import {
  PetReportsService,
  OwnershipClaim,
  OwnershipClaimEvidencePhoto,
  OwnershipClaimDecisionRequest,
  RequestOwnershipRescheduleRequest
} from '../../services/pet-reports';

/**
 * Dedicated private ownership-claims screen.
 *
 * Resident B: Sent Claims -> pickup confirmation -> reschedule -> actual handover.
 * Resident A: Received Claims -> evidence review -> approve/reject -> handover.
 *
 * This file does not replace my-reports.page.ts. The dedicated HTML, SCSS,
 * and route will be introduced separately in the next one-file-at-a-time steps.
 */
@Component({
  selector: 'app-my-claims',
  templateUrl: './my-claims.page.html',
  styleUrls: ['./my-claims.page.scss'],
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent, IonIcon, IonSpinner]
})
export class MyClaimsPage implements OnInit, OnDestroy {
  private reportsService = inject(PetReportsService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);
  private sanitizer = inject(DomSanitizer);
  private destroyed = false;
  private firstPageEntry = true;

  // Minimal navigation: two views instead of multiple sections on My Reports.
  activeClaimsTab: 'sent' | 'received' = 'sent';

  // =====================================
  // RECEIVED OWNERSHIP CLAIMS (RESIDENT A)
  // =====================================
  // The server returns only claims for Found Pet reports owned by
  // the current authenticated resident. Private proof stays out
  // of the public community report feed.
  receivedClaims: OwnershipClaim[] = [];
  claimsLoading = false;
  claimsLoadingMore = false;
  claimsLoaded = false;
  claimsErrorMessage = '';
  claimsMessage = '';
  claimsHasMore = false;
  claimsTotal = 0;

  private readonly claimsPageSize = 20;
  private claimsRequest?: Subscription;
  private claimRequestVersion = 0;

  // Finder review panel and authenticated (private) image URLs.
  selectedOwnershipClaim: OwnershipClaim | null = null;
  claimEvidencePhotos: Array<{ id: number; url: SafeUrl; objectUrl?: string }> = [];
  claimEvidenceLoading = false;
  claimEvidenceError = '';
  private evidenceRequest?: Subscription;
  private evidenceRequestVersion = 0;

  // Decision form. Email, public Found Pet address and private
  // pickup location are NOT conflated. GPS is opt-in only.
  claimDecisionMode: 'approve' | 'reject' | null = null;
  claimDecisionError = '';
  claimDecisionMessage = '';
  respondingClaimId: number | null = null;
  private claimDecisionRequest?: Subscription;

  pickupLocation = '';
  pickupDate = '';
  pickupTime = '';
  pickupLatitude: number | null = null;
  pickupLongitude: number | null = null;
  pickupLocationLoading = false;
  pickupLocationError = '';
  rejectionReason = '';

  // =====================================
  // FINDER: PICKUP, RESCHEDULE, HANDOVER (RESIDENT A)
  // =====================================
  // These operations apply to a claim on one of the logged-in
  // resident's Found Pet reports. The backend verifies ownership.
  finderActionClaimId: number | null = null;
  finderActionError = '';
  finderActionMessage = '';
  finderRescheduleMode = false;
  finderRescheduleLocation = '';
  finderRescheduleDate = '';
  finderRescheduleTime = '';
  finderRescheduleReason = '';
  private finderActionRequest?: Subscription;
  private finderActionVersion = 0;

  // =====================================
  // SENT OWNERSHIP CLAIMS (RESIDENT B)
  // =====================================
  // Independent list from the finder's received inbox. Every
  // record is restricted server-side to the authenticated claimant.
  sentClaims: OwnershipClaim[] = [];
  sentClaimsLoading = false;
  sentClaimsLoadingMore = false;
  sentClaimsLoaded = false;
  sentClaimsHasMore = false;
  sentClaimsTotal = 0;
  sentClaimsError = '';
  sentClaimsMessage = '';
  private sentClaimsNextOffset = 0;
  private sentClaimsRequest?: Subscription;
  private sentClaimsVersion = 0;

  // Claimant details modal and the three distinct actions:
  // (1) agree to the schedule; (2) request/answer reschedule;
  // (3) confirm that a physical handover REALLY occurred.
  selectedSentClaim: OwnershipClaim | null = null;
  sentClaimActionError = '';
  sentClaimActionMessage = '';
  sentActionClaimId: number | null = null;
  private sentActionRequest?: Subscription;
  private sentActionVersion = 0;
  sentRescheduleMode = false;
  sentRescheduleLocation = '';
  sentRescheduleDate = '';
  sentRescheduleTime = '';
  sentRescheduleReason = '';

  get minimumPickupDate(): string {
    // The API validates the exact future time in Asia/Manila.
    return new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
  }

  // =====================================
  // PRIVATE OWNERSHIP CLAIM MANAGEMENT
  // =====================================
  // Every private request is scoped by the PHP backend to claims
  // received for the signed-in finder. The frontend never passes
  // a finder ID or a claim owner's ID as authority.
  private updateClaimUI(fn: () => void): void {
    if (this.destroyed) return;
    this.zone.run(() => {
      if (this.destroyed) return;
      fn();
      this.cdr.detectChanges();
    });
  }

  loadReceivedClaims(loadMore = false): void {
    if (this.destroyed || (loadMore && (!this.claimsHasMore || this.claimsLoadingMore))) {
      return;
    }

    const version = ++this.claimRequestVersion;
    this.claimsRequest?.unsubscribe();
    const offset = loadMore ? this.receivedClaims.length : 0;

    this.updateClaimUI(() => {
      this.claimsErrorMessage = '';
      if (loadMore) {
        this.claimsLoadingMore = true;
      } else {
        this.claimsLoading = true;
      }
    });

    this.claimsRequest = this.reportsService.getOwnershipClaims('received', {
      limit: this.claimsPageSize,
      offset
    }).pipe(
      timeout(12000),
      finalize(() => {
        if (this.destroyed || version !== this.claimRequestVersion) return;
        this.updateClaimUI(() => {
          this.claimsLoading = false;
          this.claimsLoadingMore = false;
        });
      })
    ).subscribe({
      next: response => {
        if (this.destroyed || version !== this.claimRequestVersion) return;
        this.updateClaimUI(() => {
          if (!response.success || !Array.isArray(response.claims)) {
            this.claimsErrorMessage = response.message || 'Unable to load ownership claims.';
            return;
          }

          if (loadMore) {
            const previous = new Map(this.receivedClaims.map(claim => [claim.id, claim]));
            for (const claim of response.claims) previous.set(claim.id, claim);
            this.receivedClaims = [...previous.values()];
          } else {
            this.receivedClaims = response.claims;
          }
          this.claimsTotal = response.total;
          this.claimsHasMore = response.has_more;
          this.claimsLoaded = true;

          // Refresh a currently open review without losing its photo URLs.
          if (this.selectedOwnershipClaim) {
            const refreshed = this.receivedClaims.find(
              claim => claim.id === this.selectedOwnershipClaim?.id
            );
            if (refreshed) this.selectedOwnershipClaim = refreshed;
          }
        });
      },
      error: error => {
        if (this.destroyed || version !== this.claimRequestVersion) return;
        this.updateClaimUI(() => {
          this.claimsErrorMessage = error?.status === 401
            ? 'Your session has expired. Please log in again.'
            : error?.name === 'TimeoutError'
              ? 'Ownership claims are taking too long to load. Please retry.'
              : error?.error?.message || 'Unable to load ownership claims. Please retry.';
          this.claimsLoaded = true;
        });
      }
    });
  }

  getReceivedClaimsForReport(reportId: number): OwnershipClaim[] {
    return this.receivedClaims.filter(claim => claim.found_report_id === reportId);
  }

  getPendingClaimCount(reportId?: number): number {
    return this.receivedClaims.filter(claim =>
      claim.status === 'pending' &&
      (reportId === undefined || claim.found_report_id === reportId)
    ).length;
  }

  hasActiveOwnershipClaim(reportId: number): boolean {
    return this.receivedClaims.some(claim =>
      claim.found_report_id === reportId &&
      ['pending', 'approved', 'pickup_scheduled', 'reschedule_requested', 'disputed']
        .includes(claim.status)
    );
  }

  getOwnershipClaimStatusLabel(status: string): string {
    return status.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  }

  trackOwnershipClaim(index: number, claim: OwnershipClaim): number {
    return claim.id;
  }

  openClaimReview(claim: OwnershipClaim): void {
    if (this.destroyed || this.respondingClaimId !== null ||
        this.finderActionClaimId !== null || this.sentActionClaimId !== null) return;
    this.closeSentClaimDetails();
    this.closeClaimReview();

    this.updateClaimUI(() => {
      this.selectedOwnershipClaim = claim;
      this.claimDecisionMode = null;
      this.claimDecisionMessage = '';
      this.claimDecisionError = '';
      this.pickupLocation = '';
      this.pickupDate = '';
      this.pickupTime = '';
      this.pickupLatitude = null;
      this.pickupLongitude = null;
      this.rejectionReason = '';
      this.finderRescheduleMode = false;
      this.finderActionError = '';
      this.finderActionMessage = '';
      this.resetFinderRescheduleForm(claim);
    });

    this.loadClaimEvidence(claim);
  }

  private clearClaimEvidence(): void {
    this.evidenceRequest?.unsubscribe();
    this.evidenceRequest = undefined;
    ++this.evidenceRequestVersion;
    // Revoke only object URLs owned by this view. Base64 fallback URLs
    // have no object URL to revoke and are released when this array clears.
    for (const photo of this.claimEvidencePhotos) {
      if (photo.objectUrl) {
        URL.revokeObjectURL(photo.objectUrl);
      }
    }
    this.claimEvidencePhotos = [];
    this.claimEvidenceLoading = false;
  }

  closeClaimReview(): void {
    // Don't leave while an approval or rejection is being submitted:
    // the backend may already be processing the request.
    if (this.respondingClaimId !== null || this.finderActionClaimId !== null) return;
    this.clearClaimEvidence();
    this.selectedOwnershipClaim = null;
    this.finderRescheduleMode = false;
    this.finderActionError = '';
    this.finderActionMessage = '';
    this.claimDecisionMode = null;
    this.claimDecisionError = '';
    this.claimDecisionMessage = '';
    this.pickupLocationError = '';
    if (!this.destroyed) this.cdr.detectChanges();
  }

  // =====================================
  // PRIVATE EVIDENCE IMAGE DISPLAY
  // =====================================
  // Ionic/Angular can sanitize an untrusted blob: URL in [src],
  // while some Android WebViews cannot display certain blob URLs.
  // Never trust an arbitrary remote URL: first verify the MIME type,
  // file signature and actual image decoding. Trust ONLY the short-
  // lived object/data URL created from the authenticated API response.
  private isValidEvidenceFileHeader(mime: string, bytes: Uint8Array): boolean {
    if (mime === 'image/jpeg') {
      return bytes.length >= 3 &&
        bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (mime === 'image/png') {
      const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      return bytes.length >= signature.length &&
        signature.every((byte, index) => bytes[index] === byte);
    }
    if (mime === 'image/webp') {
      return bytes.length >= 12 &&
        [0x52, 0x49, 0x46, 0x46].every((byte, index) => bytes[index] === byte) &&
        [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[index + 8] === byte);
    }
    return false;
  }

  private canDecodeEvidenceImage(source: string): Promise<boolean> {
    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => {
        const valid = image.naturalWidth > 0 && image.naturalHeight > 0;
        image.onload = null;
        image.onerror = null;
        resolve(valid);
      };
      image.onerror = () => {
        image.onload = null;
        image.onerror = null;
        resolve(false);
      };
      image.src = source;
    });
  }

  private readEvidenceAsDataUrl(blob: Blob): Promise<string | null> {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(
        typeof reader.result === 'string' ? reader.result : null
      );
      reader.onerror = () => resolve(null);
      reader.onabort = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }

  private async prepareEvidencePhoto(
    photoId: number,
    blob: Blob
  ): Promise<{ id: number; url: SafeUrl; objectUrl?: string } | null> {
    const mime = blob.type.split(';')[0].trim().toLowerCase();
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(mime) ||
      blob.size === 0 || blob.size > 5 * 1024 * 1024
    ) {
      console.warn('[MY REPORTS] Evidence response has invalid type or size:', photoId, mime);
      return null;
    }

    // Detect corrupt responses (for example, PHP notices prefixed
    // before the real image bytes) rather than showing broken images.
    const header = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (!this.isValidEvidenceFileHeader(mime, header)) {
      console.warn('[MY REPORTS] Evidence response does not start with valid image bytes:', photoId);
      return null;
    }

    // Prefer compact object URLs, which don't duplicate large photos
    // as Base64 strings. Explicit Angular trust permits [src] binding.
    const objectUrl = URL.createObjectURL(blob);
    if (await this.canDecodeEvidenceImage(objectUrl)) {
      return {
        id: photoId,
        url: this.sanitizer.bypassSecurityTrustUrl(objectUrl),
        objectUrl
      };
    }
    URL.revokeObjectURL(objectUrl);

    // Some Android WebViews cannot decode blob: URLs despite a
    // successful authenticated request. Try a memory-only data URL.
    const dataUrl = await this.readEvidenceAsDataUrl(blob);
    if (
      dataUrl &&
      dataUrl.startsWith(`data:${mime};base64,`) &&
      await this.canDecodeEvidenceImage(dataUrl)
    ) {
      return {
        id: photoId,
        url: this.sanitizer.bypassSecurityTrustUrl(dataUrl)
      };
    }

    console.warn('[MY REPORTS] Evidence photo cannot be decoded by the device:', photoId);
    return null;
  }

  private loadClaimEvidence(claim: OwnershipClaim): void {
    this.clearClaimEvidence();
    this.claimEvidenceError = '';
    const evidence = Array.isArray(claim.evidence_photos) ? claim.evidence_photos : [];
    if (evidence.length === 0) return;

    const version = this.evidenceRequestVersion;
    this.updateClaimUI(() => { this.claimEvidenceLoading = true; });
    const requests = evidence.slice(0, 5).map((photo: OwnershipClaimEvidencePhoto) =>
      this.reportsService.getOwnershipClaimEvidencePhoto(photo.id).pipe(
        timeout(12000),
        map(blob => ({ id: photo.id, blob })),
        catchError(error => {
          console.warn('[MY REPORTS] Private claim evidence request failed:', photo.id, error?.status);
          return of(null);
        })
      )
    );

    this.evidenceRequest = forkJoin(requests).subscribe({
      next: async photos => {
        try {
          const prepared = await Promise.all(photos.map(async entry =>
            entry ? this.prepareEvidencePhoto(entry.id, entry.blob) : null
          ));

          const valid = prepared.filter(
            (entry): entry is { id: number; url: SafeUrl; objectUrl?: string } => entry !== null
          );

          // A closed/reopened modal must never show old evidence or
          // retain temporary object URLs from an obsolete request.
          if (this.destroyed || version !== this.evidenceRequestVersion ||
              this.selectedOwnershipClaim?.id !== claim.id) {
            valid.forEach(photo => {
              if (photo.objectUrl) URL.revokeObjectURL(photo.objectUrl);
            });
            return;
          }

          this.updateClaimUI(() => {
            this.claimEvidencePhotos = valid;
            if (valid.length !== evidence.length) {
              this.claimEvidenceError = valid.length === 0
                ? 'The private evidence photos could not be displayed. Please check the server response and try Retry Photos.'
                : 'Some private photos could not be displayed. Please review the available evidence.';
            }
            this.claimEvidenceLoading = false;
          });
        } catch (error) {
          console.warn('[MY REPORTS] Private evidence processing failed:', error);
          if (this.destroyed || version !== this.evidenceRequestVersion) return;
          this.updateClaimUI(() => {
            this.claimEvidenceLoading = false;
            this.claimEvidenceError = 'Unable to display private evidence photos. Please try Retry Photos.';
          });
        }
      },
      error: () => {
        if (this.destroyed || version !== this.evidenceRequestVersion) return;
        this.updateClaimUI(() => {
          this.claimEvidenceLoading = false;
          this.claimEvidenceError = 'Unable to load private evidence photos. Please try Retry Photos.';
        });
      }
    });
  }

  retryClaimEvidence(): void {
    if (this.selectedOwnershipClaim) this.loadClaimEvidence(this.selectedOwnershipClaim);
  }

  startClaimApproval(): void {
    if (this.selectedOwnershipClaim?.status !== 'pending' || this.respondingClaimId !== null ||
        this.finderActionClaimId !== null) return;
    this.updateClaimUI(() => {
      this.claimDecisionMode = 'approve';
      this.claimDecisionError = '';
      this.claimDecisionMessage = '';
    });
  }

  startClaimRejection(): void {
    if (this.selectedOwnershipClaim?.status !== 'pending' || this.respondingClaimId !== null ||
        this.finderActionClaimId !== null) return;
    this.updateClaimUI(() => {
      this.claimDecisionMode = 'reject';
      this.claimDecisionError = '';
      this.claimDecisionMessage = '';
    });
  }

  cancelClaimDecision(): void {
    if (this.respondingClaimId !== null) return;
    this.updateClaimUI(() => {
      this.claimDecisionMode = null;
      this.claimDecisionError = '';
    });
  }

  clearPickupCoordinates(): void {
    // If the user manually changes a GPS-derived address, discard the
    // old coordinates so an unrelated private pin isn't shared.
    this.pickupLatitude = null;
    this.pickupLongitude = null;
  }

  async useCurrentPickupLocation(): Promise<void> {
    if (this.destroyed || this.pickupLocationLoading || this.respondingClaimId !== null ||
        this.claimDecisionMode !== 'approve') return;

    if (!Capacitor.isNativePlatform() && !window.isSecureContext) {
      this.updateClaimUI(() => {
        this.pickupLocationError = 'GPS requires HTTPS or localhost. Enter the pickup location manually.';
      });
      return;
    }

    this.updateClaimUI(() => {
      this.pickupLocationLoading = true;
      this.pickupLocationError = '';
    });
    const currentClaimId = this.selectedOwnershipClaim?.id;
    try {
      if (Capacitor.isNativePlatform()) {
        let permissions = await Geolocation.checkPermissions();
        if (permissions.location !== 'granted' && permissions.coarseLocation !== 'granted') {
          permissions = await Geolocation.requestPermissions();
        }
        if (permissions.location !== 'granted' && permissions.coarseLocation !== 'granted') {
          throw new Error('Location permission is required to use GPS.');
        }
      }
      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      });
      if (this.destroyed || this.selectedOwnershipClaim?.id !== currentClaimId ||
          this.claimDecisionMode !== 'approve') return;
      this.updateClaimUI(() => {
        this.pickupLatitude = position.coords.latitude;
        this.pickupLongitude = position.coords.longitude;
        // Coordinates alone are not a usable meeting place: the
        // resident must still supply the full address or landmark.
        this.pickupLocationError = '';
      });
    } catch (error: any) {
      if (!this.destroyed && this.selectedOwnershipClaim?.id === currentClaimId) {
        this.updateClaimUI(() => {
          this.pickupLocationError = error?.message || 'Unable to read current GPS location.';
        });
      }
    } finally {
      if (!this.destroyed) this.updateClaimUI(() => { this.pickupLocationLoading = false; });
    }
  }

  submitClaimDecision(): void {
    const claim = this.selectedOwnershipClaim;
    const mode = this.claimDecisionMode;
    if (!claim || claim.status !== 'pending' || !mode ||
        this.respondingClaimId !== null || this.finderActionClaimId !== null ||
        this.destroyed) return;

    const data: OwnershipClaimDecisionRequest = {
      claim_id: claim.id,
      action: mode
    };

    if (mode === 'approve') {
      const location = this.pickupLocation.trim();
      const date = this.pickupDate.trim();
      const time = this.pickupTime.trim();
      if (!location || location.length > 255) {
        this.claimDecisionError = 'Enter a pickup location (up to 255 characters).';
        this.cdr.detectChanges();
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        this.claimDecisionError = 'Choose a valid pickup date and time.';
        this.cdr.detectChanges();
        return;
      }
      if (date < this.minimumPickupDate) {
        this.claimDecisionError = 'Pickup date must not be in the past.';
        this.cdr.detectChanges();
        return;
      }
      data.pickup_location = location;
      data.pickup_date = date;
      data.pickup_time = time;
      if (this.pickupLatitude !== null && this.pickupLongitude !== null) {
        data.pickup_latitude = this.pickupLatitude;
        data.pickup_longitude = this.pickupLongitude;
      }
    } else {
      data.rejection_reason = this.rejectionReason.trim() || null;
      if ((data.rejection_reason || '').length > 1000) {
        this.claimDecisionError = 'Rejection reason must not exceed 1000 characters.';
        this.cdr.detectChanges();
        return;
      }
    }

    const actionLabel = mode === 'approve'
      ? 'Approve this ownership claim and share the private pickup arrangement with the claimant?'
      : 'Reject this ownership claim?';
    if (!window.confirm(actionLabel)) return;

    this.updateClaimUI(() => {
      this.respondingClaimId = claim.id;
      this.claimDecisionError = '';
      this.claimDecisionMessage = '';
      this.claimsMessage = '';
    });

    this.claimDecisionRequest = this.reportsService.respondOwnershipClaim(data).pipe(
      timeout(15000),
      finalize(() => {
        if (!this.destroyed) this.updateClaimUI(() => { this.respondingClaimId = null; });
      })
    ).subscribe({
      next: response => {
        if (this.destroyed || this.selectedOwnershipClaim?.id !== claim.id) return;
        if (!response.success) {
          this.updateClaimUI(() => {
            this.claimDecisionError = response.message || 'Unable to process claim.';
          });
          return;
        }
        this.updateClaimUI(() => {
          const updated: OwnershipClaim = {
            ...claim,
            status: response.status,
            pickup: response.pickup ?? claim.pickup,
            rejection_reason: response.rejection_reason ?? null
          };
          this.selectedOwnershipClaim = updated;
          this.receivedClaims = this.receivedClaims.map(
            existing => existing.id === claim.id ? updated : existing
          );
          this.claimDecisionMode = null;
          this.claimDecisionMessage = response.message ||
            (mode === 'approve' ? 'Claim approved and pickup arranged.' : 'Claim rejected.');
          this.claimsMessage = this.claimDecisionMessage;
        });
        this.loadReceivedClaims();
      },
      error: error => {
        if (this.destroyed) return;
        this.updateClaimUI(() => {
          this.claimDecisionError = error?.name === 'TimeoutError' || error?.status === 0
            ? 'Could not confirm the decision. Refresh ownership claims before trying again.'
            : error?.error?.message || 'Unable to process this ownership claim.';
        });
      }
    });
  }

  // =====================================
  // RESIDENT A: PICKUP AND HANDOVER MANAGEMENT
  // =====================================
  private isFinderPickupReschedulePending(claim: OwnershipClaim): boolean {
    return claim.status === 'reschedule_requested' ||
      claim.latest_reschedule?.status === 'pending';
  }

  // Finder may propose changes only while a pickup is scheduled,
  // and only before either handover confirmation has been recorded.
  canRequestFinderReschedule(claim: OwnershipClaim): boolean {
    return claim.status === 'pickup_scheduled' &&
      !this.isFinderPickupReschedulePending(claim) &&
      !!claim.pickup?.location && !!claim.pickup?.date && !!claim.pickup?.time &&
      !claim.finder_handover_confirmed_at &&
      !claim.claimant_handover_confirmed_at &&
      this.finderActionClaimId === null && this.respondingClaimId === null;
  }

  // Only the other resident can answer a reschedule proposal.
  // On the received-claims screen, the claimant must be the requester.
  canRespondToFinderReschedule(claim: OwnershipClaim): boolean {
    return claim.status === 'reschedule_requested' &&
      claim.latest_reschedule?.status === 'pending' &&
      claim.latest_reschedule.requested_by_user_id === claim.claimant_user_id &&
      !claim.finder_handover_confirmed_at &&
      !claim.claimant_handover_confirmed_at &&
      this.finderActionClaimId === null && this.respondingClaimId === null;
  }

  // A date/time alone never means handover. The claimant must first
  // explicitly agree to the current private pickup arrangement.
  canConfirmFinderHandover(claim: OwnershipClaim): boolean {
    return claim.status === 'pickup_scheduled' &&
      !this.isFinderPickupReschedulePending(claim) &&
      !!claim.pickup?.location && !!claim.pickup?.date && !!claim.pickup?.time &&
      !!claim.pickup.claimant_confirmed_at &&
      !claim.finder_handover_confirmed_at &&
      this.finderActionClaimId === null && this.respondingClaimId === null;
  }

  getFinderClaimNextStep(claim: OwnershipClaim): string {
    if (claim.status === 'pending') {
      return 'Review the claimant’s private proof before approving or rejecting.';
    }
    if (claim.status === 'rejected') return 'This ownership claim was rejected.';
    if (claim.status === 'cancelled') return 'This ownership claim was cancelled.';
    if (claim.status === 'disputed') return 'This claim is disputed. Do not arrange a handover.';
    if (claim.status === 'completed') return 'Both residents confirmed the pet handover.';
    if (this.isFinderPickupReschedulePending(claim)) {
      return this.canRespondToFinderReschedule(claim)
        ? 'The claimant requested a new pickup arrangement. Review the proposal.'
        : 'Your proposed pickup change is awaiting the claimant’s response.';
    }
    if (claim.status === 'pickup_scheduled' || claim.status === 'approved') {
      if (!claim.pickup?.claimant_confirmed_at) {
        return 'Waiting for the claimant to confirm the pickup schedule.';
      }
      if (claim.finder_handover_confirmed_at) {
        return 'You confirmed handing over the pet. Waiting for the claimant to confirm receipt.';
      }
      return 'After physically returning the pet, confirm the actual handover.';
    }
    return 'Refresh to see the latest claim information.';
  }

  private patchReceivedClaim(claimId: number, changes: Partial<OwnershipClaim>): void {
    const update = (item: OwnershipClaim): OwnershipClaim =>
      item.id === claimId ? { ...item, ...changes } : item;
    this.receivedClaims = this.receivedClaims.map(update);
    if (this.selectedOwnershipClaim?.id === claimId) {
      this.selectedOwnershipClaim = update(this.selectedOwnershipClaim);
    }
  }

  private finderActionErrorText(error: any): string {
    if (error?.status === 401) return 'Your session has expired. Please log in again.';
    if (error?.status === 0 || error?.name === 'TimeoutError') {
      return 'The server result could not be verified. Refresh ownership claims before trying again.';
    }
    return error?.error?.message || 'Could not process this ownership claim. Please refresh and retry.';
  }

  private resetFinderRescheduleForm(claim: OwnershipClaim): void {
    this.finderRescheduleLocation = claim.pickup?.location || '';
    this.finderRescheduleDate = claim.pickup?.date || '';
    this.finderRescheduleTime = (claim.pickup?.time || '').slice(0, 5);
    this.finderRescheduleReason = '';
  }

  startFinderReschedule(claim: OwnershipClaim): void {
    if (this.destroyed || this.selectedOwnershipClaim?.id !== claim.id ||
        !this.canRequestFinderReschedule(claim)) return;
    this.updateClaimUI(() => {
      this.resetFinderRescheduleForm(claim);
      this.finderActionError = '';
      this.finderActionMessage = '';
      this.finderRescheduleMode = true;
    });
  }

  cancelFinderReschedule(): void {
    if (this.finderActionClaimId !== null) return;
    this.updateClaimUI(() => {
      this.finderRescheduleMode = false;
      this.finderActionError = '';
    });
  }

  submitFinderReschedule(): void {
    const claim = this.selectedOwnershipClaim;
    if (this.destroyed || !claim || !this.finderRescheduleMode ||
        !this.canRequestFinderReschedule(claim)) return;

    const location = this.finderRescheduleLocation.trim();
    const date = this.finderRescheduleDate.trim();
    const time = this.finderRescheduleTime.trim();
    const reason = this.finderRescheduleReason.trim();
    if (location.length < 5 || location.length > 255 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ||
        reason.length > 1000) {
      this.updateClaimUI(() => {
        this.finderActionError = 'Enter a pickup location (5–255 characters), valid date and time, and an optional reason (up to 1000 characters).';
      });
      return;
    }
    if (date < this.minimumPickupDate) {
      this.updateClaimUI(() => {
        this.finderActionError = 'The proposed pickup date must not be in the past.';
      });
      return;
    }

    const changedLocation = location !== (claim.pickup?.location || '').trim();
    const changedDate = date !== claim.pickup?.date;
    const changedTime = time !== (claim.pickup?.time || '').slice(0, 5);
    if (!changedLocation && !changedDate && !changedTime) {
      this.updateClaimUI(() => {
        this.finderActionError = 'Change at least one pickup detail before submitting.';
      });
      return;
    }

    // The API retains existing GPS coordinates when the meeting place
    // does not change, and clears them when a different location is
    // supplied without coordinates. We never reuse an incorrect pin.
    const payload: RequestOwnershipRescheduleRequest = {
      claim_id: claim.id,
      reason: reason || null
    };
    if (changedLocation) payload.pickup_location = location;
    if (changedDate) payload.pickup_date = date;
    if (changedTime) payload.pickup_time = time;

    if (!window.confirm(
      'Send this proposed pickup change to the claimant? The original schedule stays in effect until they respond.'
    )) return;

    this.updateClaimUI(() => {
      this.finderActionClaimId = claim.id;
      this.finderActionError = '';
      this.finderActionMessage = '';
    });
    const version = ++this.finderActionVersion;
    this.finderActionRequest = this.reportsService.requestOwnershipPickupReschedule(payload)
      .pipe(timeout(15000), finalize(() => {
        if (this.destroyed || version !== this.finderActionVersion) return;
        this.updateClaimUI(() => { this.finderActionClaimId = null; });
      })).subscribe({
        next: response => {
          if (this.destroyed || version !== this.finderActionVersion) return;
          this.updateClaimUI(() => {
            if (!response.success) {
              this.finderActionError = response.message || 'Unable to request rescheduling.';
              return;
            }
            this.patchReceivedClaim(claim.id, { status: 'reschedule_requested' });
            this.finderRescheduleMode = false;
            this.finderActionMessage = response.message || 'Reschedule sent to the claimant.';
            this.claimsMessage = this.finderActionMessage;
          });
          if (response.success) this.loadReceivedClaims();
        },
        error: error => {
          if (this.destroyed || version !== this.finderActionVersion) return;
          this.updateClaimUI(() => {
            this.finderActionError = this.finderActionErrorText(error);
          });
        }
      });
  }

  respondFinderReschedule(claim: OwnershipClaim, action: 'accept' | 'reject'): void {
    const proposal = claim.latest_reschedule;
    if (this.destroyed || this.selectedOwnershipClaim?.id !== claim.id ||
        !proposal || !this.canRespondToFinderReschedule(claim)) return;
    const prompt = action === 'accept'
      ? 'Accept the claimant’s proposed pickup change? The claimant must confirm the updated schedule afterward.'
      : 'Reject the requested change and keep the original pickup arrangement?';
    if (!window.confirm(prompt)) return;

    this.updateClaimUI(() => {
      this.finderActionClaimId = claim.id;
      this.finderActionError = '';
      this.finderActionMessage = '';
    });
    const version = ++this.finderActionVersion;
    this.finderActionRequest = this.reportsService.respondOwnershipPickupReschedule({
      claim_id: claim.id,
      reschedule_id: proposal.id,
      action
    }).pipe(timeout(15000), finalize(() => {
      if (this.destroyed || version !== this.finderActionVersion) return;
      this.updateClaimUI(() => { this.finderActionClaimId = null; });
    })).subscribe({
      next: response => {
        if (this.destroyed || version !== this.finderActionVersion) return;
        this.updateClaimUI(() => {
          if (!response.success) {
            this.finderActionError = response.message || 'Unable to respond to the reschedule.';
            return;
          }
          this.patchReceivedClaim(claim.id, {
            status: response.status,
            pickup: {
              ...response.pickup,
              claimant_confirmed_at: response.pickup_confirmation_required
                ? null : (claim.pickup?.claimant_confirmed_at || null)
            },
            latest_reschedule: { ...proposal, status: response.reschedule_status }
          });
          this.finderActionMessage = response.message || 'Reschedule response saved.';
          this.claimsMessage = this.finderActionMessage;
        });
        if (response.success) this.loadReceivedClaims();
      },
      error: error => {
        if (this.destroyed || version !== this.finderActionVersion) return;
        this.updateClaimUI(() => {
          this.finderActionError = this.finderActionErrorText(error);
        });
      }
    });
  }

  confirmFinderHandover(claim: OwnershipClaim): void {
    if (this.destroyed || this.selectedOwnershipClaim?.id !== claim.id ||
        !this.canConfirmFinderHandover(claim)) return;
    if (!window.confirm(
      'Have you PHYSICALLY HANDED OVER this pet to the claimant? ' +
      'Confirm only after the pet has actually been returned. This cannot be undone.'
    )) return;

    this.updateClaimUI(() => {
      this.finderActionClaimId = claim.id;
      this.finderActionError = '';
      this.finderActionMessage = '';
    });
    const version = ++this.finderActionVersion;
    this.finderActionRequest = this.reportsService.confirmOwnershipHandover(claim.id)
      .pipe(timeout(15000), finalize(() => {
        if (this.destroyed || version !== this.finderActionVersion) return;
        this.updateClaimUI(() => { this.finderActionClaimId = null; });
      })).subscribe({
        next: response => {
          if (this.destroyed || version !== this.finderActionVersion) return;
          this.updateClaimUI(() => {
            if (!response.success) {
              this.finderActionError = response.message || 'Unable to confirm the handover.';
              return;
            }
            this.patchReceivedClaim(claim.id, {
              status: response.status,
              found_report_status: response.found_report_status,
              finder_handover_confirmed_at: response.finder_handover_confirmed_at,
              claimant_handover_confirmed_at: response.claimant_handover_confirmed_at,
              completed_at: response.completed_at
            });
            this.finderActionMessage = response.message ||
              'Your handover confirmation was saved. Waiting for the claimant if needed.';
            this.claimsMessage = this.finderActionMessage;
          });
          if (response.success) {
            this.loadReceivedClaims();
          }
        },
        error: error => {
          if (this.destroyed || version !== this.finderActionVersion) return;
          this.updateClaimUI(() => {
            this.finderActionError = this.finderActionErrorText(error);
          });
        }
      });
  }

  // =====================================
  // RESIDENT B: SENT OWNERSHIP CLAIM TRACKING
  // =====================================
  loadSentClaims(loadMore = false): void {
    if (this.destroyed ||
        (loadMore && (!this.sentClaimsHasMore || this.sentClaimsLoadingMore))) {
      return;
    }
    const version = ++this.sentClaimsVersion;
    this.sentClaimsRequest?.unsubscribe();
    const offset = loadMore ? this.sentClaimsNextOffset : 0;
    this.updateClaimUI(() => {
      this.sentClaimsError = '';
      this.sentClaimsLoading = !loadMore;
      this.sentClaimsLoadingMore = loadMore;
    });

    this.sentClaimsRequest = this.reportsService.getOwnershipClaims('sent', {
      limit: this.claimsPageSize,
      offset
    }).pipe(
      timeout(12000),
      finalize(() => {
        if (this.destroyed || version !== this.sentClaimsVersion) return;
        this.updateClaimUI(() => {
          this.sentClaimsLoading = false;
          this.sentClaimsLoadingMore = false;
        });
      })
    ).subscribe({
      next: response => {
        if (this.destroyed || version !== this.sentClaimsVersion) return;
        this.updateClaimUI(() => {
          if (!response.success || !Array.isArray(response.claims)) {
            this.sentClaimsError = response.message || 'Unable to load your sent claims.';
            this.sentClaimsLoaded = true;
            return;
          }

          if (loadMore) {
            const byId = new Map(this.sentClaims.map(claim => [claim.id, claim]));
            response.claims.forEach(claim => byId.set(claim.id, claim));
            this.sentClaims = [...byId.values()];
          } else {
            this.sentClaims = response.claims;
          }

          this.sentClaimsNextOffset = offset + response.count;
          this.sentClaimsTotal = response.total;
          this.sentClaimsHasMore = response.has_more;
          this.sentClaimsLoaded = true;

          if (this.selectedSentClaim) {
            const latest = this.sentClaims.find(c => c.id === this.selectedSentClaim?.id);
            if (latest) {
              this.selectedSentClaim = latest;
            } else if (!loadMore) {
              this.selectedSentClaim = null;
              this.sentRescheduleMode = false;
            }
          }
        });
      },
      error: error => {
        if (this.destroyed || version !== this.sentClaimsVersion) return;
        this.updateClaimUI(() => {
          this.sentClaimsLoaded = true;
          this.sentClaimsError = error?.status === 401
            ? 'Session expired. Please sign in again.'
            : error?.name === 'TimeoutError'
              ? 'Your ownership claims are taking too long to load. Please retry.'
              : error?.error?.message || 'Unable to load your ownership claims.';
        });
      }
    });
  }

  trackSentClaim(_index: number, claim: OwnershipClaim): number {
    return claim.id;
  }

  openSentClaimDetails(claim: OwnershipClaim): void {
    if (this.destroyed || this.sentActionClaimId !== null ||
        this.finderActionClaimId !== null || this.respondingClaimId !== null) return;
    this.closeClaimReview();
    this.updateClaimUI(() => {
      this.selectedSentClaim = claim;
      this.sentClaimActionError = '';
      this.sentClaimActionMessage = '';
      this.sentRescheduleMode = false;
      this.resetSentRescheduleForm(claim);
    });
  }

  closeSentClaimDetails(): void {
    if (this.sentActionClaimId !== null) return;
    this.selectedSentClaim = null;
    this.sentClaimActionError = '';
    this.sentClaimActionMessage = '';
    this.sentRescheduleMode = false;
    if (!this.destroyed) this.cdr.detectChanges();
  }

  private hasPendingPickupReschedule(claim: OwnershipClaim): boolean {
    return claim.status === 'reschedule_requested' ||
      claim.latest_reschedule?.status === 'pending';
  }

  canConfirmSentPickup(claim: OwnershipClaim): boolean {
    return claim.status === 'pickup_scheduled' &&
      !this.hasPendingPickupReschedule(claim) &&
      !!claim.pickup?.location && !!claim.pickup?.date && !!claim.pickup?.time &&
      !claim.pickup.claimant_confirmed_at &&
      this.sentActionClaimId === null;
  }

  canRequestSentReschedule(claim: OwnershipClaim): boolean {
    return claim.status === 'pickup_scheduled' &&
      !this.hasPendingPickupReschedule(claim) &&
      !claim.finder_handover_confirmed_at &&
      !claim.claimant_handover_confirmed_at &&
      this.sentActionClaimId === null;
  }

  canRespondToSentReschedule(claim: OwnershipClaim): boolean {
    return this.hasPendingPickupReschedule(claim) &&
      claim.latest_reschedule?.status === 'pending' &&
      claim.latest_reschedule.requested_by_user_id !== claim.claimant_user_id &&
      this.sentActionClaimId === null;
  }

  canConfirmSentHandover(claim: OwnershipClaim): boolean {
    return claim.status === 'pickup_scheduled' &&
      !this.hasPendingPickupReschedule(claim) &&
      !!claim.pickup?.claimant_confirmed_at &&
      !claim.claimant_handover_confirmed_at &&
      this.sentActionClaimId === null;
  }

  getSentClaimNextStep(claim: OwnershipClaim): string {
    if (claim.status === 'pending') return 'Waiting for the finder to review your proof.';
    if (claim.status === 'rejected') return claim.rejection_reason ||
      'The finder rejected your ownership claim.';
    if (claim.status === 'cancelled') return claim.cancellation_reason ||
      'This ownership claim has been cancelled.';
    if (claim.status === 'disputed') return 'The ownership claim is under dispute.';
    if (claim.status === 'completed') return 'Pet handover confirmed by both residents.';
    if (this.hasPendingPickupReschedule(claim)) {
      return this.canRespondToSentReschedule(claim)
        ? 'Review the finder’s suggested pickup changes.'
        : 'Your reschedule proposal is awaiting the finder’s response.';
    }
    if (claim.status === 'approved' || claim.status === 'pickup_scheduled') {
      if (!claim.pickup?.claimant_confirmed_at) return 'Review and confirm the pickup schedule.';
      if (claim.claimant_handover_confirmed_at) return 'Waiting for the finder to confirm the handover.';
      return 'Meet the finder, receive the pet, then confirm the actual handover.';
    }
    return 'Refresh for the latest claim details.';
  }

  private patchSentClaim(claimId: number, update: Partial<OwnershipClaim>): void {
    const patch = (claim: OwnershipClaim): OwnershipClaim =>
      claim.id === claimId ? { ...claim, ...update } : claim;
    this.sentClaims = this.sentClaims.map(patch);
    if (this.selectedSentClaim?.id === claimId) {
      this.selectedSentClaim = patch(this.selectedSentClaim);
    }
  }

  private sentActionErrorText(error: any): string {
    return error?.status === 401
      ? 'Your session has expired. Please log in again.'
      : error?.status === 0 || error?.name === 'TimeoutError'
        ? 'Unable to confirm the server result. Refresh your claims before trying again.'
        : error?.error?.message || 'Unable to process the ownership claim. Please retry.';
  }

  confirmSentPickup(claim: OwnershipClaim): void {
    if (this.destroyed || !this.canConfirmSentPickup(claim) ||
        this.selectedSentClaim?.id !== claim.id) return;
    const approved = window.confirm(
      `Confirm the private pickup arrangement?\n\n` +
      `${claim.pickup.location}\n${claim.pickup.date} at ${claim.pickup.time?.slice(0, 5)} ` +
      `(Asia/Manila)\n\n` +
      'This confirms your agreement to the schedule, NOT that the pet was returned.'
    );
    if (!approved) return;

    this.updateClaimUI(() => {
      this.sentActionClaimId = claim.id;
      this.sentClaimActionError = '';
      this.sentClaimActionMessage = '';
    });
    const version = ++this.sentActionVersion;
    this.sentActionRequest = this.reportsService.confirmOwnershipPickup(claim.id)
      .pipe(timeout(15000), finalize(() => {
        if (this.destroyed || version !== this.sentActionVersion) return;
        this.updateClaimUI(() => { this.sentActionClaimId = null; });
      })).subscribe({
        next: response => {
          if (this.destroyed || version !== this.sentActionVersion) return;
          this.updateClaimUI(() => {
            if (!response.success) {
              this.sentClaimActionError = response.message || 'Could not confirm pickup.';
              return;
            }
            this.patchSentClaim(claim.id, {
              status: response.status,
              pickup: response.pickup
            });
            this.sentClaimActionMessage = response.message || 'Pickup arrangement confirmed.';
            this.sentClaimsMessage = this.sentClaimActionMessage;
          });
        },
        error: error => {
          if (this.destroyed || version !== this.sentActionVersion) return;
          this.updateClaimUI(() => { this.sentClaimActionError = this.sentActionErrorText(error); });
        }
      });
  }

  private resetSentRescheduleForm(claim: OwnershipClaim): void {
    this.sentRescheduleLocation = claim.pickup?.location || '';
    this.sentRescheduleDate = claim.pickup?.date || '';
    this.sentRescheduleTime = (claim.pickup?.time || '').slice(0, 5);
    this.sentRescheduleReason = '';
  }

  startSentReschedule(claim: OwnershipClaim): void {
    if (!this.canRequestSentReschedule(claim) || this.selectedSentClaim?.id !== claim.id) return;
    this.updateClaimUI(() => {
      this.resetSentRescheduleForm(claim);
      this.sentClaimActionError = '';
      this.sentRescheduleMode = true;
    });
  }

  cancelSentReschedule(): void {
    if (this.sentActionClaimId !== null) return;
    this.updateClaimUI(() => { this.sentRescheduleMode = false; this.sentClaimActionError = ''; });
  }

  submitSentReschedule(): void {
    const claim = this.selectedSentClaim;
    if (!claim || this.destroyed || !this.sentRescheduleMode ||
        !this.canRequestSentReschedule(claim)) return;

    const location = this.sentRescheduleLocation.trim();
    const date = this.sentRescheduleDate.trim();
    const time = this.sentRescheduleTime.trim();
    const reason = this.sentRescheduleReason.trim();
    if (location.length < 5 || location.length > 255 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || reason.length > 1000) {
      this.updateClaimUI(() => {
        this.sentClaimActionError = 'Enter a valid pickup location (5–255 characters), date, time, and optional reason (up to 1000 characters).';
      });
      return;
    }

    const changedLocation = location !== (claim.pickup?.location || '').trim();
    const changedDate = date !== claim.pickup?.date;
    const changedTime = time !== (claim.pickup?.time || '').slice(0, 5);
    if (!changedLocation && !changedDate && !changedTime) {
      this.updateClaimUI(() => { this.sentClaimActionError = 'Change at least one pickup detail.'; });
      return;
    }

    // Send only changed fields. This allows the PHP backend to
    // preserve existing GPS coordinates when the place is unchanged.
    const payload: RequestOwnershipRescheduleRequest = {
      claim_id: claim.id,
      reason: reason || null
    };
    if (changedLocation) payload.pickup_location = location;
    if (changedDate) payload.pickup_date = date;
    if (changedTime) payload.pickup_time = time;

    if (!window.confirm('Send your proposed pickup changes to the finder for approval?')) return;
    this.updateClaimUI(() => {
      this.sentActionClaimId = claim.id;
      this.sentClaimActionError = '';
      this.sentClaimActionMessage = '';
    });
    const version = ++this.sentActionVersion;
    this.sentActionRequest = this.reportsService.requestOwnershipPickupReschedule(payload)
      .pipe(timeout(15000), finalize(() => {
        if (this.destroyed || version !== this.sentActionVersion) return;
        this.updateClaimUI(() => { this.sentActionClaimId = null; });
      })).subscribe({
        next: response => {
          if (this.destroyed || version !== this.sentActionVersion) return;
          this.updateClaimUI(() => {
            if (!response.success) {
              this.sentClaimActionError = response.message || 'Unable to request rescheduling.';
              return;
            }
            this.patchSentClaim(claim.id, { status: 'reschedule_requested' });
            this.sentRescheduleMode = false;
            this.sentClaimActionMessage = response.message || 'Pickup change requested.';
            this.sentClaimsMessage = this.sentClaimActionMessage;
          });
          this.loadSentClaims();
        },
        error: error => {
          if (this.destroyed || version !== this.sentActionVersion) return;
          this.updateClaimUI(() => { this.sentClaimActionError = this.sentActionErrorText(error); });
        }
      });
  }

  respondSentReschedule(claim: OwnershipClaim, action: 'accept' | 'reject'): void {
    const pending = claim.latest_reschedule;
    if (this.destroyed || !pending || !this.canRespondToSentReschedule(claim) ||
        this.selectedSentClaim?.id !== claim.id) return;
    const question = action === 'accept'
      ? 'Accept the new pickup arrangement proposed by the finder? You must confirm the new schedule afterward.'
      : 'Reject this proposal and keep the previously agreed pickup schedule?';
    if (!window.confirm(question)) return;

    this.updateClaimUI(() => {
      this.sentActionClaimId = claim.id;
      this.sentClaimActionError = '';
      this.sentClaimActionMessage = '';
    });
    const version = ++this.sentActionVersion;
    this.sentActionRequest = this.reportsService.respondOwnershipPickupReschedule({
      claim_id: claim.id,
      reschedule_id: pending.id,
      action
    }).pipe(timeout(15000), finalize(() => {
      if (this.destroyed || version !== this.sentActionVersion) return;
      this.updateClaimUI(() => { this.sentActionClaimId = null; });
    })).subscribe({
      next: response => {
        if (this.destroyed || version !== this.sentActionVersion) return;
        this.updateClaimUI(() => {
          if (!response.success) {
            this.sentClaimActionError = response.message || 'Unable to respond to reschedule.';
            return;
          }
          this.patchSentClaim(claim.id, {
            status: response.status,
            pickup: response.pickup,
            latest_reschedule: {
              ...pending,
              status: response.reschedule_status
            }
          });
          this.sentClaimActionMessage = response.message || 'Reschedule response saved.';
          this.sentClaimsMessage = this.sentClaimActionMessage;
        });
        this.loadSentClaims();
      },
      error: error => {
        if (this.destroyed || version !== this.sentActionVersion) return;
        this.updateClaimUI(() => { this.sentClaimActionError = this.sentActionErrorText(error); });
      }
    });
  }

  confirmSentHandover(claim: OwnershipClaim): void {
    if (this.destroyed || !this.canConfirmSentHandover(claim) ||
        this.selectedSentClaim?.id !== claim.id) return;
    // Never make this action automatic on scheduled date or approval.
    if (!window.confirm(
      'Have you PHYSICALLY RECEIVED the pet from the finder? ' +
      'Only confirm after the actual handover. This cannot be undone.'
    )) return;

    this.updateClaimUI(() => {
      this.sentActionClaimId = claim.id;
      this.sentClaimActionError = '';
      this.sentClaimActionMessage = '';
    });
    const version = ++this.sentActionVersion;
    this.sentActionRequest = this.reportsService.confirmOwnershipHandover(claim.id)
      .pipe(timeout(15000), finalize(() => {
        if (this.destroyed || version !== this.sentActionVersion) return;
        this.updateClaimUI(() => { this.sentActionClaimId = null; });
      })).subscribe({
        next: response => {
          if (this.destroyed || version !== this.sentActionVersion) return;
          this.updateClaimUI(() => {
            if (!response.success) {
              this.sentClaimActionError = response.message || 'Unable to confirm handover.';
              return;
            }
            this.patchSentClaim(claim.id, {
              status: response.status,
              found_report_status: response.found_report_status,
              finder_handover_confirmed_at: response.finder_handover_confirmed_at,
              claimant_handover_confirmed_at: response.claimant_handover_confirmed_at,
              completed_at: response.completed_at
            });
            this.sentClaimActionMessage = response.message || 'Handover confirmation saved.';
            this.sentClaimsMessage = this.sentClaimActionMessage;
          });
          this.loadSentClaims();
        },
        error: error => {
          if (this.destroyed || version !== this.sentActionVersion) return;
          this.updateClaimUI(() => { this.sentClaimActionError = this.sentActionErrorText(error); });
        }
      });
  }

  // =====================================
  // DEDICATED PAGE NAVIGATION
  // =====================================
  changeClaimsTab(tab: 'sent' | 'received'): void {
    if (this.destroyed || this.activeClaimsTab === tab) return;
    // Close private details before switching tabs so evidence and pickup
    // information are not visible in the other context.
    if (this.respondingClaimId !== null || this.finderActionClaimId !== null ||
        this.sentActionClaimId !== null) return;
    this.closeClaimReview();
    this.closeSentClaimDetails();
    this.activeClaimsTab = tab;
    if (tab === 'sent' && !this.sentClaimsLoaded && !this.sentClaimsLoading) {
      this.loadSentClaims();
    }
    if (tab === 'received' && !this.claimsLoaded && !this.claimsLoading) {
      this.loadReceivedClaims();
    }
    this.cdr.detectChanges();
  }

  refreshClaims(): void {
    if (this.destroyed) return;
    if (this.activeClaimsTab === 'sent') this.loadSentClaims();
    else this.loadReceivedClaims();
  }

  goBack(): void {
    if (this.respondingClaimId !== null || this.finderActionClaimId !== null ||
        this.sentActionClaimId !== null) return;
    this.router.navigateByUrl('/lost-found');
  }

  // =====================================
  // LIFECYCLE & PRIVATE DATA CLEANUP
  // =====================================
  constructor() {
    addIcons({
      arrowBackOutline,
      pawOutline,
      calendarOutline,
      locationOutline,
      closeOutline,
      refreshOutline,
      alertCircleOutline,
      imageOutline,
      checkmarkCircleOutline,
      shieldCheckmarkOutline,
      imagesOutline,
      timeOutline,
      navigateOutline,
      checkmarkOutline,
      closeCircleOutline,
      chevronForwardOutline,
      chevronBackOutline,
      documentTextOutline
    });
  }

  ngOnInit(): void {
    // Load both once so status counts are ready when switching tabs.
    this.loadSentClaims();
    this.loadReceivedClaims();
  }

  ionViewWillEnter(): void {
    if (this.firstPageEntry) {
      this.firstPageEntry = false;
      return;
    }
    // Refresh when returning from another page, without duplicating
    // the ngOnInit requests on the first navigation.
    this.loadSentClaims();
    this.loadReceivedClaims();
  }

  ionViewDidLeave(): void {
    // Hide private claim details when navigating away.
    this.cleanupClaimSubscriptionsAndEvidence();
  }

  private cleanupClaimSubscriptionsAndEvidence(): void {
    ++this.claimRequestVersion;
    ++this.sentClaimsVersion;
    ++this.evidenceRequestVersion;
    ++this.finderActionVersion;
    ++this.sentActionVersion;

    this.claimsRequest?.unsubscribe();
    this.claimDecisionRequest?.unsubscribe();
    this.finderActionRequest?.unsubscribe();
    this.sentClaimsRequest?.unsubscribe();
    this.sentActionRequest?.unsubscribe();
    this.clearClaimEvidence();

    this.selectedOwnershipClaim = null;
    this.selectedSentClaim = null;
    this.claimDecisionMode = null;
    this.finderRescheduleMode = false;
    this.sentRescheduleMode = false;
    this.respondingClaimId = null;
    this.finderActionClaimId = null;
    this.sentActionClaimId = null;
    this.claimsLoading = false;
    this.claimsLoadingMore = false;
    this.sentClaimsLoading = false;
    this.sentClaimsLoadingMore = false;
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.cleanupClaimSubscriptionsAndEvidence();
  }
}
