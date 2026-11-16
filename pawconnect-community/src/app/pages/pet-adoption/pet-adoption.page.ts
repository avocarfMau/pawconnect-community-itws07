import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  ChangeDetectorRef,
  NgZone
} from '@angular/core';

import { CommonModule } from '@angular/common';
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
  addOutline,
  refreshOutline,
  imagesOutline,
  chevronBackOutline,
  chevronForwardOutline,
  closeOutline,
  expandOutline,
  locationOutline,
  calendarOutline,
  heartOutline,
  listOutline, checkmarkCircleOutline, informationCircleOutline, cameraOutline, closeCircleOutline } from 'ionicons/icons';

import {
  Subscription,
  finalize,
  of,
  switchMap,
  timer,
  timeout
} from 'rxjs';

import {
  PetAdoptionService,
  AdoptionPost
} from '../../services/pet-adoption';

// =====================================
// PAWRESCUE COMMUNITY
// PET ADOPTION PAGE
// =====================================

type AnimalFilter = 'all' | 'dog' | 'cat';

// Keep the most recent community feed when Ionic destroys and recreates
// this page. The snapshot is associated with its login session so posts
// (including is_owner) are never reused for a different logged-in user.
interface AdoptionFeedSnapshot {
  sessionToken: string | null;
  posts: AdoptionPost[];
}

let lastFeedSnapshot: AdoptionFeedSnapshot | null = null;

@Component({
  selector: 'app-pet-adoption',
  templateUrl: './pet-adoption.page.html',
  styleUrls: ['./pet-adoption.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    IonContent,
    IonIcon,
    IonButton,
    IonSpinner
  ]
})
export class PetAdoptionPage implements OnInit, OnDestroy {

  // =====================================
  // SERVICES
  // =====================================

  private readonly adoption = inject(PetAdoptionService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);

  private request?: Subscription;
  private refreshing = false;
  private destroyed = false;
  private firstEntranceHandled = false;

  // An unfiltered feed lets All Pets / Dogs / Cats switch instantly.
  private allPosts: AdoptionPost[] | null = null;

  // Avoid repeated URL construction during Angular change detection.
  private readonly photoUrlCache = new Map<number, string[]>();

  // =====================================
  // PAGE STATE (used by the existing HTML)
  // =====================================

  posts: AdoptionPost[] = [];
  selectedFilter: AnimalFilter = 'all';
  // Prevent the false "No Adoption Listings Yet" state before initial fetch.
  loading = true;
  errorMessage = '';
  viewerPost: AdoptionPost | null = null;

  // =====================================
  // PHOTO GALLERY STATE
  // =====================================

  private readonly photoIndexes = new Map<number, number>();
  private startX: number | null = null;

  constructor() {
    addIcons({arrowBackOutline,checkmarkCircleOutline,informationCircleOutline,imagesOutline,cameraOutline,closeCircleOutline,pawOutline,addOutline,refreshOutline,chevronBackOutline,chevronForwardOutline,closeOutline,expandOutline,locationOutline,calendarOutline,heartOutline,listOutline});
  }

  // =====================================
  // FORCE UI UPDATES AFTER ASYNC API OPERATIONS
  // Same reliable change-detection approach used by Report Pet.
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
  // INITIAL LOAD + IONIC PAGE LIFECYCLE
  // =====================================

  ngOnInit(): void {
    // Angular always calls this when the component is first created.
    // Do not rely exclusively on ionViewWillEnter for first navigation.
    this.restoreSnapshot();
    this.loadPosts();
  }

  ionViewWillEnter(): void {
    // ngOnInit already started the first request. Avoid a duplicate GET
    // during the first Ionic transition.
    if (!this.firstEntranceHandled) {
      this.firstEntranceHandled = true;
      if (!this.refreshing && this.allPosts === null) {
        this.loadPosts();
      }
      return;
    }

    // Ionic keeps pages alive in its router outlet. Recheck when the
    // resident returns from Home, Adoption Details, or My Adoptions.
    this.restoreSnapshot();
    this.loadPosts();
  }

  ionViewDidLeave(): void {
    this.closeViewer();

    // Cancel an unfinished request for the hidden screen. The next
    // entrance will revalidate without discarding successful listings.
    this.request?.unsubscribe();
    this.request = undefined;
    this.refreshing = false;
    this.loading = false;
  }

  private getSessionToken(): string | null {
    return sessionStorage.getItem('pawrescue_token');
  }

  // =====================================
  // RESTORE THE PREVIOUS COMMUNITY FEED
  // =====================================

  private restoreSnapshot(): void {
    const token = this.getSessionToken();

    if (
      token &&
      lastFeedSnapshot &&
      lastFeedSnapshot.sessionToken === token &&
      lastFeedSnapshot.posts.length > 0
    ) {
      if (this.allPosts !== lastFeedSnapshot.posts) {
        this.allPosts = lastFeedSnapshot.posts;
        this.photoUrlCache.clear();
      }

      this.applyCurrentFilter();
      this.loading = false;
      return;
    }

    // Do not reuse an empty snapshot: it could be from a temporary
    // response before the adoption listings were available.
    lastFeedSnapshot = null;
    this.allPosts = null;
    this.posts = [];
    this.photoIndexes.clear();
    this.photoUrlCache.clear();
    this.loading = true;
  }

  // =====================================
  // LOAD / REFRESH ADOPTION LISTINGS
  // =====================================

  loadPosts(): void {
    if (this.destroyed || this.refreshing) {
      return;
    }

    // Reuse successful results while revalidating in the background.
    // A first visit without cached data must show the spinner, not
    // "No Adoption Listings Yet" before the response finishes.
    this.loading = this.allPosts === null;
    this.errorMessage = '';
    this.refreshing = true;

    const requestSessionToken = this.getSessionToken();
    const startedAt = performance.now();

    console.log('[PAWRESCUE ADOPTION] Loading listings...');

    this.request = this.adoption
      .getPosts('all', 'community', 'all')
      .pipe(
        timeout(15000),
        switchMap(response => {
          // On a cold load, verify a surprising empty result once.
          // Do not treat one transient empty response as proof that
          // the database contains no adoption listings.
          const verifyEmpty =
            response.success &&
            Array.isArray(response.posts) &&
            response.posts.length === 0 &&
            this.allPosts === null;

          if (!verifyEmpty) {
            return of(response);
          }

          console.warn(
            '[PAWRESCUE ADOPTION] Empty initial response; checking once more.'
          );

          return timer(250).pipe(
            switchMap(() =>
              this.adoption.getPosts('all', 'community', 'all')
                .pipe(timeout(15000))
            )
          );
        }),
        finalize(() => {
          this.updateUI(() => {
            this.refreshing = false;
            this.loading = false;
          });

          console.log(
            '[PAWRESCUE ADOPTION] Fetch finished in',
            Math.round(performance.now() - startedAt),
            'ms'
          );
        })
      )
      .subscribe({
        next: response => {
          this.updateUI(() => {
            if (this.getSessionToken() !== requestSessionToken) {
              this.allPosts = null;
              this.posts = [];
              this.photoIndexes.clear();
              this.photoUrlCache.clear();
              lastFeedSnapshot = null;
              this.errorMessage =
                'Your session changed. Please reopen Pet Adoption.';
              return;
            }

            if (!response.success || !Array.isArray(response.posts)) {
              this.handleLoadFailure(
                response.message || 'Unable to load adoption listings.'
              );
              return;
            }

            this.allPosts = response.posts;
            lastFeedSnapshot = requestSessionToken && this.allPosts.length > 0
              ? { sessionToken: requestSessionToken, posts: this.allPosts }
              : null;

            this.photoUrlCache.clear();

            const ids = new Set(this.allPosts.map(post => post.id));
            for (const id of this.photoIndexes.keys()) {
              if (!ids.has(id)) {
                this.photoIndexes.delete(id);
              }
            }

            this.applyCurrentFilter();
            this.errorMessage = '';

            console.log(
              '[PAWRESCUE ADOPTION] Loaded',
              this.allPosts.length,
              'listing(s).'
            );
          });
        },
        error: error => {
          this.updateUI(() => {
            this.handleLoadFailure(
              error?.status === 401
                ? 'Session expired. Please log in again.'
                : 'Unable to load adoption listings. Check your connection.'
            );
          });

          console.error('[PAWRESCUE ADOPTION] Loading failed:', error);
        }
      });
  }

  private handleLoadFailure(message: string): void {
    if (this.allPosts === null) {
      // No fallback data exists: display the retry state.
      this.errorMessage = message;
    } else {
      // Keep an existing, usable feed visible on temporary network errors.
      console.warn('[PAWRESCUE ADOPTION] Refresh failed:', message);
      this.errorMessage = '';
    }
  }

  // =====================================
  // INSTANT FILTERING (NO EXTRA API CALL)
  // =====================================

  private applyCurrentFilter(): void {
    const allPosts = this.allPosts || [];

    this.posts = this.selectedFilter === 'all'
      ? allPosts
      : allPosts.filter(post => post.animal_type === this.selectedFilter);
  }

  changeFilter(filter: AnimalFilter): void {
    if (filter === this.selectedFilter) {
      return;
    }

    this.updateUI(() => {
      this.selectedFilter = filter;
      this.applyCurrentFilter();
    });

    // If the initial GET has failed, allow a filter tap to retry it.
    // Otherwise filtering stays instant and entirely client-side.
    if (this.allPosts === null && !this.refreshing) {
      this.loadPosts();
    }
  }

  // =====================================
  // CACHED PET PHOTO URLS
  // =====================================

  urls(post: AdoptionPost): string[] {
    const cached = this.photoUrlCache.get(post.id);

    if (cached) {
      return cached;
    }

    const urls = this.adoption.getPhotoUrls(post);
    this.photoUrlCache.set(post.id, urls);
    return urls;
  }

  index(post: AdoptionPost): number {
    return Math.min(
      this.photoIndexes.get(post.id) || 0,
      Math.max(0, this.urls(post).length - 1)
    );
  }

  currentUrl(post: AdoptionPost): string | null {
    return this.urls(post)[this.index(post)] || null;
  }

  choosePhoto(post: AdoptionPost, index: number): void {
    if (index >= 0 && index < this.urls(post).length) {
      this.photoIndexes.set(post.id, index);
    }
  }

  movePhoto(post: AdoptionPost, offset: number): void {
    const count = this.urls(post).length;

    if (count > 1) {
      this.photoIndexes.set(
        post.id,
        (this.index(post) + offset + count) % count
      );
    }
  }

  // =====================================
  // PHOTO SWIPE SUPPORT
  // =====================================

  touchStart(event: TouchEvent): void {
    this.startX = event.changedTouches[0]?.clientX ?? null;
  }

  touchEnd(event: TouchEvent, post: AdoptionPost): void {
    if (this.startX === null) {
      return;
    }

    const delta =
      (event.changedTouches[0]?.clientX ?? this.startX) - this.startX;

    this.startX = null;

    if (Math.abs(delta) >= 45) {
      this.movePhoto(post, delta < 0 ? 1 : -1);
    }
  }

  // =====================================
  // PHOTO VIEWER
  // =====================================

  openViewer(post: AdoptionPost): void {
    this.viewerPost = post;
  }

  closeViewer(): void {
    this.viewerPost = null;
    this.startX = null;
  }

  // =====================================
  // VIEW ADOPTION DETAILS
  // =====================================

  openPost(post: AdoptionPost): void {
    this.closeViewer();
    this.router.navigate(['/adoption-details', post.id]);
  }

  trackPost(_index: number, post: AdoptionPost): number {
    return post.id;
  }

  // =====================================
  // NAVIGATION
  // =====================================

  goBack(): void {
    this.router.navigateByUrl('/home');
  }

  postPet(): void {
    this.router.navigateByUrl('/post-adoption');
  }

  myAdoptions(): void {
    this.router.navigateByUrl('/my-adoptions');
  }

  // =====================================
  // CLEANUP
  // =====================================

  ngOnDestroy(): void {
    this.destroyed = true;
    this.request?.unsubscribe();
    this.photoUrlCache.clear();
  }
}
