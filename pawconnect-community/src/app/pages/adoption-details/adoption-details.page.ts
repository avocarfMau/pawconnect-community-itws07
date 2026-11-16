
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

import {
  ActivatedRoute,
  Router
} from '@angular/router';

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
  locationOutline,
  chevronBackOutline,
  chevronForwardOutline,
  heartOutline,
  closeOutline,
  informationCircleOutline
} from 'ionicons/icons';

import {
  firstValueFrom,
  Subscription,
  timeout
} from 'rxjs';

import {
  PetAdoptionService,
  AdoptionPost,
  AdoptionRequestStatus
} from '../../services/pet-adoption';

// =====================================
// PAWRESCUE COMMUNITY
// ADOPTION DETAILS PAGE
// =====================================

@Component({
  selector: 'app-adoption-details',
  templateUrl: './adoption-details.page.html',
  styleUrls: ['./adoption-details.page.scss'],
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
export class AdoptionDetailsPage implements OnInit, OnDestroy {

  // =====================================
  // SERVICES
  // =====================================

  private readonly adoption =
    inject(PetAdoptionService);

  private readonly route =
    inject(ActivatedRoute);

  private readonly router =
    inject(Router);

  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);

  private destroyed = false;
  private firstIonicEntrance = true;
  private routeSubscription?: Subscription;

  // Used to disregard stale responses when the route changes.
  private loadSerial = 0;
  private activeLoadId: number | null = null;


  // =====================================
  // PET DETAILS
  // =====================================

  post: AdoptionPost | null = null;

  // Do not show the HTML retry state before initial loading starts.
  loading = true;

  errorMessage = '';

  successMessage = '';

  // =====================================
  // ADOPTION REQUEST
  // =====================================

  message = '';

  submitting = false;

  requested = false;

  // The server is authoritative: a resident may only request a pet once.
  existingRequestStatus: AdoptionRequestStatus | null = null;

  requestUncertain = false;

  // =====================================
  // PHOTO GALLERY
  // =====================================

  photoIndex = 0;

  viewerOpen = false;

  private touchX: number | null = null;

  // =====================================
  // CONSTRUCTOR
  // =====================================

  constructor() {

    addIcons({
      arrowBackOutline,
      pawOutline,
      locationOutline,
      chevronBackOutline,
      chevronForwardOutline,
      heartOutline,
      closeOutline,
      informationCircleOutline
    });

  }

  // =====================================
  // UI CHANGE DETECTION
  // =====================================

  private updateUI(callback: () => void): void {
    if (this.destroyed) {
      return;
    }

    this.zone.run(() => {
      callback();
      this.cdr.detectChanges();
    });
  }

  // =====================================
  // INITIAL LOAD AND IONIC LIFECYCLE
  // =====================================

  ngOnInit(): void {
    // paramMap emits immediately on first navigation and again if
    // Angular reuses this component for a different adoption ID.
    this.routeSubscription = this.route.paramMap.subscribe(() => {
      this.requested = false;
      this.existingRequestStatus = null;
      this.requestUncertain = false;
      this.message = '';
      this.successMessage = '';
      void this.load();
    });
  }

  ionViewWillEnter(): void {
    // The first request is already started by ngOnInit().
    // Don't send a duplicate request during the first transition.
    if (this.firstIonicEntrance) {
      this.firstIonicEntrance = false;
      return;
    }

    // Refresh existing details when returning to the page.
    void this.load();
  }

  ionViewDidLeave(): void {
    this.viewerOpen = false;
  }

  // =====================================
  // SHOW STATUS OF AN EXISTING APPLICATION
  // =====================================

  private existingRequestMessage(status: AdoptionRequestStatus): string {
    switch (status) {
      case 'pending':
        return 'You have already submitted an adoption request for this pet. ' +
          'Status: Pending review by the pet owner. View My Adoptions to track it.';
      case 'approved':
        return 'You have already submitted an adoption request for this pet. ' +
          'Status: Approved. The owner has selected your application. ' +
          'The adoption will be completed after the pet is handed over.';
      case 'rejected':
        return 'You have already submitted an adoption request for this pet. ' +
          'Status: Not approved. Check My Adoptions for your request details.';
      case 'cancelled':
        return 'You previously submitted an adoption request for this pet. ' +
          'Status: Cancelled. View My Adoptions for details.';
      case 'completed':
        return 'You have already submitted an adoption request for this pet. ' +
          'Status: Completed. This adoption has been confirmed.';
      default:
        return 'You have already submitted an adoption request for this pet. ' +
          'View My Adoptions to check its status.';
    }
  }

  // =====================================
  // LOAD PET DETAILS AND CHECK SENT REQUESTS
  // =====================================

  async load(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!Number.isSafeInteger(id) || id < 1) {
      ++this.loadSerial;
      this.activeLoadId = null;
      this.updateUI(() => {
        this.loading = false;
        this.post = null;
        this.errorMessage = 'Invalid adoption post ID.';
      });
      return;
    }

    // Ionic may call both ngOnInit and ionViewWillEnter. Only one
    // in-flight load for the same pet is allowed.
    if (this.activeLoadId === id) {
      return;
    }

    const currentLoad = ++this.loadSerial;
    this.activeLoadId = id;
    const mine = this.route.snapshot.queryParamMap.get('mine') === '1';
    const samePet = Number(this.post?.id) === id;

    this.updateUI(() => {
      this.loading = true;
      this.errorMessage = '';

      if (!samePet) {
        this.post = null;
        this.photoIndex = 0;
        this.viewerOpen = false;
        this.requested = false;
        this.existingRequestStatus = null;
        this.requestUncertain = false;
        this.successMessage = '';
      }
    });

    // Start both GET requests together so the request-status lookup does
    // not add a second sequential network delay. It MUST complete before
    // displaying the application form; otherwise repeat applicants may
    // briefly see a form for a pet they already requested.
    const sentLookup = mine
      ? Promise.resolve({ response: null, error: null })
      : firstValueFrom(
          this.adoption.getRequests('sent').pipe(timeout(15000))
        ).then(
          response => ({ response, error: null }),
          error => ({ response: null, error })
        );

    try {
      const response = await firstValueFrom(
        this.adoption.getPosts(
          'all',
          mine ? 'mine' : 'community',
          'all',
          id
        ).pipe(timeout(15000))
      );

      if (this.destroyed || currentLoad !== this.loadSerial) {
        return;
      }

      if (!response.success || !Array.isArray(response.posts)) {
        this.updateUI(() => {
          this.post = null;
          this.errorMessage =
            response.message || 'Unable to load adoption details.';
        });
        return;
      }

      const matchingPost = response.posts.find(
        item => Number(item.id) === id
      ) || null;

      if (!matchingPost) {
        this.updateUI(() => {
          this.post = null;
          this.errorMessage =
            'This adoption post could not be found or is no longer visible.';
        });
        return;
      }

      // The pet information can be rendered as soon as it arrives,
      // while the form remains locked until the sent-request lookup ends.
      this.updateUI(() => {
        this.post = matchingPost;
        this.photoIndex = 0;
        this.viewerOpen = false;
        this.errorMessage = '';
      });

      if (matchingPost.is_owner) {
        this.updateUI(() => {
          this.requested = false;
          this.existingRequestStatus = null;
          this.requestUncertain = false;
          this.successMessage = '';
        });
        return;
      }

      const { response: sentResponse, error: sentError } = await sentLookup;
      if (this.destroyed || currentLoad !== this.loadSerial) {
        return;
      }

      if (
        sentError ||
        !sentResponse ||
        !sentResponse.success ||
        !Array.isArray(sentResponse.requests)
      ) {
        // Fail closed: do not show a new-submission form when the app
        // cannot confirm whether this resident has already applied.
        console.warn(
          '[PawRescue Adoption Details] Unable to verify sent requests:',
          sentError || sentResponse
        );
        this.updateUI(() => {
          if (!this.requested) {
            this.requestUncertain = true;
            this.errorMessage =
              'Unable to check your existing adoption requests. ' +
              'Please view My Adoptions before submitting a new request.';
          }
        });
        return;
      }

      const existing = sentResponse.requests.find(
        item => Number(item.adoption_id) === id
      );

      this.updateUI(() => {
        if (existing) {
          this.requested = true;
          this.requestUncertain = false;
          this.existingRequestStatus = existing.status;
          this.successMessage = this.existingRequestMessage(existing.status);
          this.errorMessage = '';
        } else {
          this.requested = false;
          this.existingRequestStatus = null;
          this.requestUncertain = false;
          this.successMessage = '';
        }
      });
    } catch (error: any) {
      if (this.destroyed || currentLoad !== this.loadSerial) {
        return;
      }

      console.error('[PawRescue Adoption Details] Load failed:', error);
      this.updateUI(() => {
        this.post = null;
        if (error?.status === 401) {
          this.errorMessage = 'Session expired. Please log in again.';
        } else if (error?.status === 403) {
          this.errorMessage = 'You do not have access to this adoption post.';
        } else if (error?.status === 404) {
          this.errorMessage = 'This adoption post could not be found.';
        } else if (error?.name === 'TimeoutError') {
          this.errorMessage =
            'Loading pet details took too long. Check your connection and try again.';
        } else {
          this.errorMessage =
            error?.error?.message ||
            'Unable to load adoption details. Check your connection.';
        }
      });
    } finally {
      if (!this.destroyed && currentLoad === this.loadSerial) {
        this.activeLoadId = null;
        this.updateUI(() => {
          this.loading = false;
        });
      }
    }
  }

  // =====================================
  // GET PET PHOTOS
  // =====================================

  get photos(): string[] {

    if (!this.post) {
      return [];
    }

    return this.adoption.getPhotoUrls(
      this.post
    );

  }

  // =====================================
  // CURRENT PHOTO URL
  // =====================================

  get photoUrl(): string | null {

    return (
      this.photos[this.photoIndex] ||
      null
    );

  }

  // =====================================
  // NEXT / PREVIOUS PHOTO
  // =====================================

  movePhoto(delta: number): void {

    const count = this.photos.length;

    if (count <= 1) {
      return;
    }

    this.photoIndex =
      (
        this.photoIndex +
        delta +
        count
      ) % count;

  }

  // =====================================
  // SWIPE PHOTO START
  // =====================================

  onTouchStart(event: TouchEvent): void {

    this.touchX =
      event.changedTouches[0]?.clientX ??
      null;

  }

  // =====================================
  // SWIPE PHOTO END
  // =====================================

  onTouchEnd(event: TouchEvent): void {

    if (this.touchX === null) {
      return;
    }

    const endX =
      event.changedTouches[0]?.clientX ??
      this.touchX;

    const difference =
      endX - this.touchX;

    this.touchX = null;

    if (Math.abs(difference) >= 45) {

      this.movePhoto(
        difference < 0 ? 1 : -1
      );

    }

  }

  // =====================================
  // SUBMIT ADOPTION REQUEST
  // =====================================

  async sendRequest(): Promise<void> {

    // One POST only. Never create a second request while the first
    // is pending or its result is uncertain.
    const pet = this.post;

    if (
      !pet ||
      pet.is_owner ||
      pet.status !== 'available' ||
      this.submitting ||
      this.loading ||
      this.requested ||
      this.requestUncertain ||
      this.destroyed
    ) {
      return;
    }

    const requestMessage = this.message.trim();

    if (requestMessage.length < 10 || requestMessage.length > 2000) {
      this.updateUI(() => {
        this.errorMessage =
          'Please write an adoption message between 10 and 2000 characters.';
      });
      return;
    }

    // Confirm before sending to prevent accidental applications.
    const confirmed = window.confirm(
      `Are you sure you want to submit an adoption request for ${pet.pet_name}?`
    );

    if (!confirmed || this.destroyed) {
      return;
    }

    const adoptionId = Number(pet.id);

    // Immediately display the button spinner, including on Android.
    this.updateUI(() => {
      this.errorMessage = '';
      this.successMessage = '';
      this.submitting = true;
    });

    const startedAt = performance.now();

    try {
      // No extra GET or automatic retry: a POST may reach the server
      // even when the client eventually loses the response.
      const response = await firstValueFrom(
        this.adoption
          .submitRequest(adoptionId, requestMessage)
          .pipe(timeout(20000))
      );

      if (
        this.destroyed ||
        Number(this.route.snapshot.paramMap.get('id')) !== adoptionId
      ) {
        return;
      }

      this.updateUI(() => {
        if (response.success) {
          this.requested = true;
          this.existingRequestStatus = 'pending';
          this.requestUncertain = false;
          this.successMessage =
            'Adoption request submitted successfully! You can track your application in My Adoptions.';
        } else {
          this.errorMessage =
            response.message || 'Unable to submit adoption request.';
        }
      });

    } catch (error: any) {

      if (
        this.destroyed ||
        Number(this.route.snapshot.paramMap.get('id')) !== adoptionId
      ) {
        return;
      }

      this.updateUI(() => {
        const status = error?.status;
        const serverMessage = String(error?.error?.message || '').trim();
        const lowerMessage = serverMessage.toLowerCase();

        if (status === 409) {
          // A known "unavailable" response is NOT an uncertain request.
          // Hide the form and show the existing unavailable-pet UI.
          const unavailableStatus =
            lowerMessage.includes('already been adopted')
              ? 'adopted'
              : lowerMessage.includes('reserved')
                ? 'reserved'
                : lowerMessage.includes('listing is closed')
                  ? 'closed'
                  : null;

          if (unavailableStatus && this.post) {
            this.post = { ...this.post, status: unavailableStatus };
            this.requestUncertain = false;
            this.errorMessage = serverMessage;
          } else if (lowerMessage.includes('already requested')) {
            // Server confirms a previous request exists. Do not treat
            // a known duplicate as an uncertain submission.
            this.requested = true;
            this.requestUncertain = false;
            this.successMessage =
              'You have already submitted an adoption request for this pet. ' +
              'Check My Adoptions for its current status.';
            this.errorMessage = '';
          } else {
            this.requestUncertain = true;
            this.errorMessage =
              serverMessage || 'Please check My Adoptions before trying again.';
          }
        } else if (status === 400 || status === 403 || status === 404) {
          this.errorMessage =
            serverMessage || 'Unable to submit adoption request.';
        } else if (status === 401) {
          this.errorMessage = 'Session expired. Please log in again.';
        } else {
          // Timeout, network interruption or server failure: the INSERT
          // may have succeeded. Never automatically send a duplicate POST.
          this.requestUncertain = true;
          this.errorMessage =
            'Unable to confirm your adoption request. Check My Adoptions before trying again.';
        }
      });

    } finally {
      // This tells us whether the delay is actually the HTTP/API response.
      console.info(
        '[PawRescue Adoption] Submit request duration:',
        Math.round(performance.now() - startedAt),
        'ms'
      );

      this.updateUI(() => {
        this.submitting = false;
      });
    }
  }

  // =====================================
  // NAVIGATION - BACK
  // =====================================

  goBack(): void {

    const fromMyAdoptions =
      this.route.snapshot.queryParamMap
        .get('mine') === '1';

    this.router.navigateByUrl(
      fromMyAdoptions
        ? '/my-adoptions'
        : '/pet-adoption'
    );

  }

  // =====================================
  // NAVIGATION - MY ADOPTIONS
  // =====================================

  goToMyAdoptions(): void {

    this.router.navigateByUrl(
      '/my-adoptions'
    );

  }

  // =====================================
  // CLEANUP
  // =====================================

  ngOnDestroy(): void {

    this.destroyed = true;
    ++this.loadSerial;
    this.activeLoadId = null;
    this.routeSubscription?.unsubscribe();

  }

}
