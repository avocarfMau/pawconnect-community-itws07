import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
  NgZone,
  inject
} from '@angular/core';

import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import {
  IonContent,
  IonIcon,
  IonButton,
  IonSpinner
} from '@ionic/angular';

import { addIcons } from 'ionicons';

import {
  arrowBackOutline,
  pawOutline,
  refreshOutline,
  addOutline,
  checkmarkCircleOutline,
  closeOutline,
  chevronBackOutline,
  chevronForwardOutline,
  locationOutline,
  heartOutline
} from 'ionicons/icons';

import {
  firstValueFrom,
  timeout
} from 'rxjs';

import {
  AdoptionPost,
  AdoptionRequest,
  AdoptionPickupDetails,
  PetAdoptionService
} from '../../services/pet-adoption';

// =====================================
// PAWRESCUE COMMUNITY - MY ADOPTIONS
// =====================================

type Tab = 'posts' | 'received' | 'sent';

interface MyAdoptionsSnapshot {
  // Never reuse personal adoption information across login sessions.
  sessionToken: string;
  posts: AdoptionPost[];
  received: AdoptionRequest[];
  sent: AdoptionRequest[];
  loaded: Record<Tab, boolean>;
}

// Retains the last confirmed results if Ionic recreates this page.
// It is in-memory only (not localStorage or persistent storage).
let lastSnapshot: MyAdoptionsSnapshot | null = null;

@Component({
  selector: 'app-my-adoptions',
  templateUrl: './my-adoptions.page.html',
  styleUrls: ['./my-adoptions.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonContent,
    IonIcon,
    IonButton,
    IonSpinner
  ]
})
export class MyAdoptionsPage implements OnInit, OnDestroy {

  private readonly adoption = inject(PetAdoptionService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);

  private destroyed = false;
  private firstIonicEntrance = true;
  private sessionToken = this.getSessionToken();

  // Each tab loads independently. The user never needs to wait for the
  // slowest of three endpoints before the selected tab is displayed.
  private loaded: Record<Tab, boolean> = {
    posts: false,
    received: false,
    sent: false
  };

  private settled: Record<Tab, boolean> = {
    posts: false,
    received: false,
    sent: false
  };

  private inFlight: Record<Tab, boolean> = {
    posts: false,
    received: false,
    sent: false
  };

  // Discard outdated responses when a mutation triggers a newer refresh.
  private requestVersions: Record<Tab, number> = {
    posts: 0,
    received: 0,
    sent: 0
  };

  private tabErrors: Record<Tab, string> = {
    posts: '',
    received: '',
    sent: ''
  };

  private readonly photoUrlCache = new WeakMap<AdoptionPost, string[]>();
  private readonly photoIndexes = new Map<number, number>();
  private touchX: number | null = null;

  // =====================================
  // PAGE STATE (compatible with the existing HTML)
  // =====================================

  selectedTab: Tab = 'posts';

  posts: AdoptionPost[] = [];
  received: AdoptionRequest[] = [];
  sent: AdoptionRequest[] = [];

  // Prevent the false "No Adoption Posts Yet" state before the first load.
  loading = true;
  busy = false;

  errorMessage = '';
  successMessage = '';
  viewerPost: AdoptionPost | null = null;

  // The owner must provide pickup arrangements before an approval is sent.
  // The existing Approve button opens this form; the next HTML update
  // will display it using the fields and methods below.
  approvalRequest: AdoptionRequest | null = null;
  pickupForm: AdoptionPickupDetails = {
    meeting_location: '',
    pickup_date: '',
    pickup_time: ''
  };
  pickupError = '';

  // The owner can revise an approved pet pickup while the listing is Reserved.
  // Keep this separate from the initial approval form and its validations.
  rescheduleRequest: AdoptionRequest | null = null;
  rescheduleForm: AdoptionPickupDetails = {
    meeting_location: '',
    pickup_date: '',
    pickup_time: ''
  };
  rescheduleReason = '';
  rescheduleError = '';

  // Philippines uses UTC+08:00 year-round. Build date/time strings in
  // Philippine local time regardless of the device's configured zone.
  private manilaNow(): string {
    return new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16);
  }

  get minimumPickupDate(): string {
    return this.manilaNow().slice(0, 10);
  }


  constructor() {
    addIcons({
      arrowBackOutline,
      pawOutline,
      refreshOutline,
      addOutline,
      checkmarkCircleOutline,
      closeOutline,
      chevronBackOutline,
      chevronForwardOutline,
      locationOutline,
      heartOutline
    });
  }

  // =====================================
  // KEEP ASYNC UI UPDATES INSIDE ANGULAR
  // =====================================

  private updateUI(callback: () => void): void {
    if (this.destroyed) return;

    this.zone.run(() => {
      callback();
      this.cdr.detectChanges();
    });
  }

  private getSessionToken(): string | null {
    return sessionStorage.getItem('pawrescue_token');
  }

  private updateLoading(): void {
    // An already-loaded tab stays visible during a background refresh.
    this.loading = !this.loaded[this.selectedTab] &&
                   !this.settled[this.selectedTab];
  }

  private restoreSnapshot(): void {
    const token = this.sessionToken;

    if (!token || !lastSnapshot || lastSnapshot.sessionToken !== token) {
      return;
    }

    this.posts = lastSnapshot.posts;
    this.received = lastSnapshot.received;
    this.sent = lastSnapshot.sent;
    this.loaded = { ...lastSnapshot.loaded };
    this.settled = { ...lastSnapshot.loaded };
    this.updateLoading();
  }

  private saveSnapshot(): void {
    if (!this.sessionToken || (!this.loaded.posts &&
        !this.loaded.received && !this.loaded.sent)) {
      return;
    }

    lastSnapshot = {
      sessionToken: this.sessionToken,
      posts: this.posts,
      received: this.received,
      sent: this.sent,
      loaded: { ...this.loaded }
    };
  }

  private ensureCurrentSession(): void {
    const currentToken = this.getSessionToken();
    if (this.sessionToken === currentToken) return;

    this.sessionToken = currentToken;
    this.posts = [];
    this.received = [];
    this.sent = [];
    this.loaded = { posts: false, received: false, sent: false };
    this.settled = { posts: false, received: false, sent: false };
    this.inFlight = { posts: false, received: false, sent: false };
    this.tabErrors = { posts: '', received: '', sent: '' };
    this.requestVersions.posts++;
    this.requestVersions.received++;
    this.requestVersions.sent++;
    this.photoIndexes.clear();
    this.viewerPost = null;
    this.errorMessage = '';
    this.successMessage = '';
    this.resetPickupForm();
    this.resetRescheduleForm();
    this.restoreSnapshot();
    this.updateLoading();
  }

  // =====================================
  // INITIAL LOAD AND IONIC RE-ENTRY
  // =====================================

  ngOnInit(): void {
    this.restoreSnapshot();
    void this.loadAll();
  }

  ionViewWillEnter(): void {
    // ngOnInit starts the first fetch; don't issue duplicate requests.
    if (this.firstIonicEntrance) {
      this.firstIonicEntrance = false;
      return;
    }

    // On a return visit, show the current data immediately and fetch changes.
    void this.loadAll();
  }

  ionViewDidLeave(): void {
    this.viewerPost = null;
    if (!this.busy) {
      this.resetPickupForm();
      this.resetRescheduleForm();
    }
  }

  // =====================================
  // LOAD ONE SECTION WITHOUT BLOCKING OTHERS
  // =====================================

  private async loadTab(tab: Tab, force = false): Promise<void> {
    if (this.destroyed || (this.inFlight[tab] && !force)) return;

    const version = ++this.requestVersions[tab];
    this.inFlight[tab] = true;
    const startedAt = performance.now();

    try {
      if (tab === 'posts') {
        const response = await firstValueFrom(
          this.adoption.getPosts('all', 'mine').pipe(timeout(15000))
        );

        if (this.destroyed || version !== this.requestVersions[tab] ||
            this.sessionToken !== this.getSessionToken()) return;

        if (!response.success || !Array.isArray(response.posts)) {
          throw new Error(response.message || 'Unable to load adoption posts.');
        }

        this.updateUI(() => {
          const previousError = this.tabErrors.posts;
          this.posts = response.posts;
          this.loaded.posts = true;
          this.settled.posts = true;
          this.tabErrors.posts = '';
          if (this.selectedTab === 'posts' && this.errorMessage === previousError) {
            this.errorMessage = '';
          }
          this.updateLoading();
          this.saveSnapshot();
        });
      } else {
        const response = await firstValueFrom(
          this.adoption.getRequests(tab).pipe(timeout(15000))
        );

        if (this.destroyed || version !== this.requestVersions[tab] ||
            this.sessionToken !== this.getSessionToken()) return;

        if (!response.success || !Array.isArray(response.requests)) {
          throw new Error(response.message || 'Unable to load adoption requests.');
        }

        this.updateUI(() => {
          if (tab === 'received') {
            this.received = response.requests;
          } else {
            this.sent = response.requests;
          }
          const previousError = this.tabErrors[tab];
          this.loaded[tab] = true;
          this.settled[tab] = true;
          this.tabErrors[tab] = '';
          if (this.selectedTab === tab && this.errorMessage === previousError) {
            this.errorMessage = '';
          }
          this.updateLoading();
          this.saveSnapshot();
        });
      }

      console.log(
        `[PawRescue My Adoptions] ${tab} loaded in`,
        Math.round(performance.now() - startedAt), 'ms'
      );
    } catch (error: any) {
      if (this.destroyed || version !== this.requestVersions[tab] ||
          this.sessionToken !== this.getSessionToken()) return;

      console.error(`[PawRescue My Adoptions] ${tab} load failed:`, error);

      const message = error?.status === 401
        ? 'Session expired. Please log in again.'
        : error?.name === 'TimeoutError'
          ? `Loading ${tab} took too long. Check your connection and refresh.`
          : error?.error?.message ||
            `Unable to load ${tab}. Check your connection and refresh.`;

      this.updateUI(() => {
        this.tabErrors[tab] = message;
        this.settled[tab] = true;
        // Keep any previously loaded records instead of blanking the screen.
        if (this.selectedTab === tab && !this.successMessage) {
          this.errorMessage = message;
        }
        this.updateLoading();
      });
    } finally {
      if (!this.destroyed && version === this.requestVersions[tab]) {
        this.updateUI(() => {
          this.inFlight[tab] = false;
          this.settled[tab] = true;
          this.updateLoading();
        });
      }
    }
  }

  // Called by the existing Refresh button. Each request completes
  // independently, so My Posts can render while Received/Sent still load.
  async loadAll(preserveMessages = false): Promise<void> {
    if (this.destroyed || this.busy) return;

    this.ensureCurrentSession();

    if (!preserveMessages) {
      this.updateUI(() => {
        this.errorMessage = '';
        this.successMessage = '';
      });
    }

    await Promise.all([
      this.loadTab('posts'),
      this.loadTab('received'),
      this.loadTab('sent')
    ]);
  }

  private refreshAfterMutation(): void {
    // The server has already confirmed the action. Update related data
    // in the background without hiding the cards or waiting for 3 endpoints.
    void Promise.all([
      this.loadTab('posts', true),
      this.loadTab('received', true)
    ]);
  }

  // =====================================
  // SWITCH TABS INSTANTLY WHEN CACHED
  // =====================================

  setTab(tab: Tab): void {
    if (this.selectedTab === tab) return;

    this.updateUI(() => {
      if (!this.busy) {
        this.resetPickupForm();
        this.resetRescheduleForm();
      }
      this.selectedTab = tab;
      this.successMessage = '';
      this.errorMessage = this.tabErrors[tab];
      this.updateLoading();
    });

    if (!this.loaded[tab] && !this.inFlight[tab]) {
      void this.loadTab(tab);
    }
  }

  // =====================================
  // PHOTO GALLERY (existing HTML compatible)
  // =====================================

  photoUrls(post: AdoptionPost): string[] {
    const cached = this.photoUrlCache.get(post);
    if (cached) return cached;

    const urls = this.adoption.getPhotoUrls(post);
    this.photoUrlCache.set(post, urls);
    return urls;
  }

  index(post: AdoptionPost): number {
    return Math.min(
      this.photoIndexes.get(Number(post.id)) || 0,
      Math.max(0, this.photoUrls(post).length - 1)
    );
  }

  currentUrl(post: AdoptionPost): string | null {
    return this.photoUrls(post)[this.index(post)] || null;
  }

  movePhoto(post: AdoptionPost, delta: number): void {
    const count = this.photoUrls(post).length;
    if (count <= 1) return;

    this.photoIndexes.set(
      Number(post.id),
      (this.index(post) + delta + count) % count
    );
  }

  touchStart(event: TouchEvent): void {
    this.touchX = event.changedTouches[0]?.clientX ?? null;
  }

  touchEnd(event: TouchEvent, post: AdoptionPost): void {
    if (this.touchX === null) return;

    const dx = (event.changedTouches[0]?.clientX ?? this.touchX) - this.touchX;
    this.touchX = null;

    if (Math.abs(dx) > 45) {
      this.movePhoto(post, dx < 0 ? 1 : -1);
    }
  }

  statusLabel(status: string): string {
    return status.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  }

  // =====================================
  // PICKUP ARRANGEMENTS BEFORE APPROVAL
  // =====================================

  private resetPickupForm(): void {
    this.approvalRequest = null;
    this.pickupError = '';
    this.pickupForm = {
      meeting_location: '',
      pickup_date: '',
      pickup_time: ''
    };
  }

  private resetRescheduleForm(): void {
    this.rescheduleRequest = null;
    this.rescheduleError = '';
    this.rescheduleReason = '';
    this.rescheduleForm = {
      meeting_location: '',
      pickup_date: '',
      pickup_time: ''
    };
  }

  // Open the in-page form. This does NOT approve the applicant yet.
  openApprovalForm(request: AdoptionRequest): void {
    if (this.destroyed || this.busy || this.loading ||
        request.status !== 'pending') return;

    this.updateUI(() => {
      this.resetRescheduleForm();
      this.approvalRequest = request;
      this.pickupForm = {
        meeting_location: '',
        pickup_date: this.minimumPickupDate,
        pickup_time: ''
      };
      this.pickupError = '';
      this.errorMessage = '';
      this.successMessage = '';
    });
  }

  cancelApprovalForm(): void {
    if (this.busy) return;
    this.updateUI(() => this.resetPickupForm());
  }

  // Shared validation for the original approval and future reschedules.
  // Errors are shown in the corresponding form; no request is sent if invalid.
  private validatePickupDetails(
    form: AdoptionPickupDetails = this.pickupForm,
    mode: 'approval' | 'reschedule' = 'approval'
  ): AdoptionPickupDetails | null {
    const reportError = (message: string): null => {
      if (mode === 'reschedule') {
        this.rescheduleError = message;
      } else {
        this.pickupError = message;
      }
      return null;
    };

    const location = form.meeting_location.trim();
    const date = form.pickup_date.trim();
    const time = form.pickup_time.trim();

    if (location.length < 5 ||
        new TextEncoder().encode(location).length > 255 ||
        /[\x00-\x1F\x7F]/.test(location)) {
      return reportError('Enter a meeting location between 5 and 255 bytes on one line.');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reportError('Select a valid pickup date.');
    }

    // Reject impossible calendar dates such as February 30.
    const calendarDate = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(calendarDate.getTime()) ||
        calendarDate.toISOString().slice(0, 10) !== date) {
      return reportError('Select a valid pickup date.');
    }

    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return reportError('Select a valid pickup time.');
    }

    if (`${date}T${time}` <= this.manilaNow()) {
      return reportError('Pickup date and time must be in the future (Philippine time).');
    }

    if (mode === 'reschedule') {
      this.rescheduleError = '';
    } else {
      this.pickupError = '';
    }

    return {
      meeting_location: location,
      pickup_date: date,
      pickup_time: time
    };
  }

  // Called by the new approval form's Confirm Approval button.
  async confirmApproval(): Promise<void> {
    const request = this.approvalRequest;
    if (!request || this.destroyed || this.busy || this.loading ||
        request.status !== 'pending') return;

    const details = this.validatePickupDetails();
    if (!details) {
      this.cdr.detectChanges();
      return;
    }

    const confirmation =
      `Approve ${request.requester_name} to adopt ${request.pet_name}?\n\n` +
      `Meeting place: ${details.meeting_location}\n` +
      `Date: ${details.pickup_date}\n` +
      `Time: ${details.pickup_time} (Philippine time)\n\n` +
      'Other pending requests will be rejected. The pet will remain ' +
      'Reserved until its physical handover is confirmed.';

    if (!window.confirm(confirmation)) return;

    await this.submitDecision(request, 'approve', details);
  }

  // Keep the method used by the existing Received tab. An Approve click
  // opens the pickup form instead of sending an incomplete API request.
  async actOnRequest(
    request: AdoptionRequest,
    action: 'approve' | 'reject'
  ): Promise<void> {
    if (this.destroyed || this.busy || this.loading ||
        request.status !== 'pending') return;

    if (action === 'approve') {
      this.openApprovalForm(request);
      return;
    }

    if (!window.confirm(
      `Reject ${request.requester_name}'s request for ${request.pet_name}?`
    )) return;

    await this.submitDecision(request, 'reject');
  }

  private async submitDecision(
    request: AdoptionRequest,
    action: 'approve' | 'reject',
    pickup?: AdoptionPickupDetails
  ): Promise<void> {
    if (this.destroyed || this.busy || request.status !== 'pending') return;
    // Never send an approval request without validated pickup details.
    if (action === 'approve' && !pickup) return;

    this.updateUI(() => {
      this.busy = true;
      this.errorMessage = '';
      this.successMessage = '';
      this.pickupError = '';
    });

    let refreshNeeded = false;

    try {
      const response = await firstValueFrom(
        this.adoption.respondToRequest(request.id, action, pickup)
          .pipe(timeout(20000))
      );

      if (!response.success) {
        throw new Error(response.message || 'Unable to update adoption request.');
      }
      if (this.destroyed) return;

      refreshNeeded = true;
      this.updateUI(() => {
        // The server has committed the change: reflect it without a
        // blocking full-page reload.
        this.received = this.received.map((item): AdoptionRequest => {
          if (Number(item.id) === Number(request.id)) {
            return {
              ...item,
              status: action === 'approve' ? 'approved' : 'rejected',
              adoption_status: action === 'approve' ? 'reserved' : item.adoption_status,
              meeting_location: action === 'approve' ? (response.meeting_location ?? pickup?.meeting_location ?? null) : item.meeting_location,
              pickup_date: action === 'approve' ? (response.pickup_date ?? pickup?.pickup_date ?? null) : item.pickup_date,
              pickup_time: action === 'approve' ? (response.pickup_time ?? pickup?.pickup_time ?? null) : item.pickup_time
            };
          }

          if (action === 'approve' &&
              Number(item.adoption_id) === Number(request.adoption_id)) {
            return {
              ...item,
              adoption_status: 'reserved',
              status: item.status === 'pending' ? 'rejected' : item.status
            };
          }
          return item;
        });

        if (action === 'approve') {
          this.posts = this.posts.map((post): AdoptionPost =>
            Number(post.id) === Number(request.adoption_id)
              ? { ...post, status: 'reserved' }
              : post
          );
        }

        this.resetPickupForm();
        this.successMessage = response.message ||
          (action === 'approve' ? 'Adoption approved. Pickup scheduled.' : 'Adoption request rejected.');
        this.saveSnapshot();
      });
    } catch (error: any) {
      if (this.destroyed) return;

      // 422 is a definite validation failure: nothing was approved.
      // 409 and network errors are rechecked rather than retrying the POST.
      refreshNeeded = error?.status !== 422 && error?.status !== 400;
      this.updateUI(() => {
        const message = error?.error?.message ||
          (error?.name === 'TimeoutError'
            ? 'Unable to confirm the update. Check the latest request status before trying again.'
            : 'Unable to update the adoption request. Please check the latest status.');
        if (action === 'approve' && this.approvalRequest) {
          this.pickupError = message;
        } else {
          this.errorMessage = message;
        }
      });
    } finally {
      if (!this.destroyed) {
        this.updateUI(() => { this.busy = false; });
        if (refreshNeeded) this.refreshAfterMutation();
      }
    }
  }

  // =====================================
  // RESCHEDULE APPROVED PICKUP
  // =====================================

  // Called by the Reschedule Pickup button in Received requests.
  // Opening this form does not change anything on the server.
  openRescheduleForm(request: AdoptionRequest): void {
    if (this.destroyed || this.busy || this.loading ||
        request.status !== 'approved' || request.adoption_status !== 'reserved') {
      return;
    }

    this.updateUI(() => {
      this.resetPickupForm();
      this.rescheduleRequest = request;
      this.rescheduleForm = {
        meeting_location: request.meeting_location ?? '',
        pickup_date: request.pickup_date ?? this.minimumPickupDate,
        pickup_time: (request.pickup_time ?? '').slice(0, 5)
      };
      this.rescheduleReason = '';
      this.rescheduleError = '';
      this.errorMessage = '';
      this.successMessage = '';
    });
  }

  cancelRescheduleForm(): void {
    if (this.busy) return;
    this.updateUI(() => this.resetRescheduleForm());
  }

  // Confirm updates only an approved request and leaves the pet Reserved.
  async confirmReschedule(): Promise<void> {
    const request = this.rescheduleRequest;
    if (!request || this.destroyed || this.busy || this.loading ||
        request.status !== 'approved' || request.adoption_status !== 'reserved') {
      return;
    }

    const details = this.validatePickupDetails(this.rescheduleForm, 'reschedule');
    if (!details) {
      this.cdr.detectChanges();
      return;
    }

    const reason = this.rescheduleReason.trim();
    if (new TextEncoder().encode(reason).length > 255 ||
        /[\x00-\x1F\x7F]/.test(reason)) {
      this.rescheduleError = 'Reason must be a single line of up to 255 bytes.';
      this.cdr.detectChanges();
      return;
    }

    // The backend also checks for unchanged schedules and rejects them.
    // Check here first so the owner gets immediate feedback.
    if (details.meeting_location === (request.meeting_location ?? '').trim() &&
        details.pickup_date === (request.pickup_date ?? '') &&
        details.pickup_time === (request.pickup_time ?? '').slice(0, 5)) {
      this.rescheduleError = 'No schedule changes detected. Update the location, date, or time.';
      this.cdr.detectChanges();
      return;
    }

    const confirmation =
      `Reschedule pickup for ${request.pet_name}?\n\n` +
      `Meeting place: ${details.meeting_location}\n` +
      `Date: ${details.pickup_date}\n` +
      `Time: ${details.pickup_time} (Philippine time)\n` +
      (reason ? `Reason: ${reason}\n` : '') +
      '\nThe adoption will remain Approved and the pet will remain Reserved.';

    if (!window.confirm(confirmation)) return;

    this.updateUI(() => {
      this.busy = true;
      this.rescheduleError = '';
      this.errorMessage = '';
      this.successMessage = '';
    });

    let needsRefresh = false;

    try {
      const response = await firstValueFrom(
        this.adoption.reschedulePickup(request.id, details, reason)
          .pipe(timeout(20000))
      );

      if (!response.success) {
        throw new Error(response.message || 'Unable to reschedule pickup.');
      }
      if (this.destroyed) return;

      needsRefresh = true;
      this.updateUI(() => {
        this.received = this.received.map((item): AdoptionRequest =>
          Number(item.id) === Number(request.id)
            ? {
                ...item,
                // No status change: the application stays Approved.
                status: 'approved',
                adoption_status: 'reserved',
                meeting_location: response.meeting_location ?? details.meeting_location,
                pickup_date: response.pickup_date ?? details.pickup_date,
                pickup_time: response.pickup_time ?? details.pickup_time
              }
            : item
        );
        this.resetRescheduleForm();
        this.successMessage = response.message || 'Pickup schedule updated successfully.';
        this.saveSnapshot();
      });
    } catch (error: any) {
      if (this.destroyed) return;

      // The server may have applied an update despite an interrupted response.
      // Re-fetch on uncertainty, but never silently retry the POST.
      needsRefresh = ![400, 422].includes(error?.status);
      this.updateUI(() => {
        this.rescheduleError = error?.error?.message ||
          (error?.name === 'TimeoutError' || error?.status === 0
            ? 'Unable to confirm the new schedule. Refresh requests before trying again.'
            : 'Unable to reschedule pickup. Check the latest request status.');
      });
    } finally {
      if (!this.destroyed) {
        this.updateUI(() => { this.busy = false; });
        if (needsRefresh) {
          // Refresh only Received; no pet status changed.
          void this.loadTab('received', true);
        }
      }
    }
  }

  // =====================================
  // COMPLETE ADOPTION AFTER PHYSICAL HANDOVER
  // =====================================

  async finishAdoption(post: AdoptionPost): Promise<void> {
    if (this.destroyed || this.busy || this.loading || post.status !== 'reserved') {
      return;
    }

    const confirmed = window.confirm(
      `Has ${post.pet_name} actually been handed over to the approved adopter? Only mark adopted after a completed handover.`
    );
    if (!confirmed) return;

    this.updateUI(() => {
      this.busy = true;
      this.errorMessage = '';
      this.successMessage = '';
    });

    let refreshNeeded = false;

    try {
      const response = await firstValueFrom(
        this.adoption.completeAdoption(post.id).pipe(timeout(20000))
      );

      if (!response.success) {
        throw new Error(response.message || 'Unable to complete adoption.');
      }
      if (this.destroyed) return;

      refreshNeeded = true;
      this.updateUI(() => {
        this.posts = this.posts.map((item): AdoptionPost =>
          Number(item.id) === Number(post.id)
            ? { ...item, status: 'adopted' }
            : item
        );
        this.successMessage = response.message || 'Adoption completed successfully.';
        this.saveSnapshot();
      });
    } catch (error: any) {
      if (this.destroyed) return;
      refreshNeeded = true;
      this.updateUI(() => {
        this.errorMessage = error?.error?.message ||
          (error?.name === 'TimeoutError'
            ? 'Unable to confirm completion. Check the latest adoption status before trying again.'
            : 'Unable to confirm completion. Refresh the post before trying again.');
      });
    } finally {
      if (!this.destroyed) {
        this.updateUI(() => { this.busy = false; });
        if (refreshNeeded) this.refreshAfterMutation();
      }
    }
  }

  // =====================================
  // NAVIGATION AND TRACKING
  // =====================================

  viewPost(post: AdoptionPost): void {
    this.router.navigate(['/adoption-details', post.id], {
      queryParams: { mine: 1 }
    });
  }

  trackPost(_index: number, post: AdoptionPost): number {
    return Number(post.id);
  }

  trackRequest(_index: number, request: AdoptionRequest): number {
    return Number(request.id);
  }

  goBack(): void {
    this.router.navigateByUrl('/pet-adoption');
  }

  postPet(): void {
    this.router.navigateByUrl('/post-adoption');
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.requestVersions.posts++;
    this.requestVersions.received++;
    this.requestVersions.sent++;
    this.viewerPost = null;
    this.resetPickupForm();
    this.resetRescheduleForm();
  }
}
