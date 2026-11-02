import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon, IonSpinner } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  notificationsOutline,
  refreshOutline,
  pawOutline,
  shieldCheckmarkOutline,
  heartOutline,
  chevronForwardOutline,
  chevronDownOutline,
  checkmarkCircleOutline,
  alertCircleOutline,
  timeOutline,
  mailOutline
} from 'ionicons/icons';
import {
  Observable,
  Subscription,
  catchError,
  merge,
  map,
  of,
  timeout
} from 'rxjs';
import {
  PetReportsService,
  OwnershipClaim,
  OwnershipClaimsResponse,
  LostPetRecovery,
  LostPetRecoveriesResponse
} from '../../services/pet-reports';
import {
  PetAdoptionService,
  AdoptionRequest,
  AdoptionRequestsResponse
} from '../../services/pet-adoption';

// =====================================
// PAWRESCUE - IN-APP ACTIVITY NOTIFICATIONS
// =====================================
// This initial page shows CURRENT, authenticated activity from
// existing claims, recoveries and adoption requests.
// It is not a push-notification service, does not claim persistent
// read/unread state, and does not expose evidence or pickup addresses.
// Later, a backend notification event table can add actual new-event
// badges and read/unread persistence without changing these APIs.

type ActivityCategory = 'ownership' | 'recovery' | 'adoption';
export type ActivityFilter = 'all' | ActivityCategory;
type ActivityScope = 'sent' | 'received';
export type ActivityTone = 'neutral' | 'warning' | 'success' | 'danger';

export interface NotificationActivity {
  id: string;
  category: ActivityCategory;
  scope: ActivityScope;
  title: string;
  message: string;
  statusLabel: string;
  tone: ActivityTone;
  icon: string;
  route: string;
  date: Date;
}

interface FetchResult<T> {
  data: T | null;
  failed: boolean;
}

@Component({
  selector: 'app-notifications',
  templateUrl: './notifications.page.html',
  styleUrls: ['./notifications.page.scss'],
  standalone: true,
  imports: [CommonModule, IonContent, IonIcon, IonSpinner]
})
export class NotificationsPage implements OnInit, OnDestroy {
  private readonly petReportsService = inject(PetReportsService);
  private readonly adoptionService = inject(PetAdoptionService);
  private readonly router = inject(Router);
  private readonly changeDetector = inject(ChangeDetectorRef);

  private fetchSubscription?: Subscription;
  private requestVersion = 0;
  private destroyed = false;
  private firstPageEntry = true;
  private lastLoadStartedAt = 0;
  // Keep already loaded activity visible when returning to Notifications.
  // Clear it immediately if the logged-in session changes.
  private activitySession: string | null = null;

  readonly filters: { key: ActivityFilter; label: string }[] = [
    { key: 'all', label: 'All Activity' },
    { key: 'ownership', label: 'Ownership Claims' },
    { key: 'recovery', label: 'Lost Pet Recoveries' },
    { key: 'adoption', label: 'Pet Adoption' }
  ];

  activeFilter: ActivityFilter = 'all';
  activities: NotificationActivity[] = [];
  loading = false;
  error = '';
  notice = '';
  updatedAt: Date | null = null;
  visibleCount = 20;

  constructor() {
    addIcons({
      arrowBackOutline,
      notificationsOutline,
      refreshOutline,
      pawOutline,
      shieldCheckmarkOutline,
      heartOutline,
      chevronForwardOutline,
      chevronDownOutline,
      checkmarkCircleOutline,
      alertCircleOutline,
      timeOutline,
      // Keep the existing HTML icon name without needing an HTML change.
      // Ionicons doesn't export inboxOutline in this version.
      inboxOutline: mailOutline
    });
  }

  ngOnInit(): void {
    this.loadNotifications();
  }

  // Ionic may retain a page instance between visits.
  ionViewWillEnter(): void {
    if (this.firstPageEntry) {
      // ngOnInit already made the initial request; don't cancel it.
      this.firstPageEntry = false;
      return;
    }

    // Ionic can keep routed pages alive between visits. Reload each time
    // while continuing to show cached activities for this same session.
    this.loadNotifications();
  }

  ionViewDidEnter(): void {
    // Fallback for cases where the initial request failed before the page
    // finished entering. Avoid cancelling a request still in progress.
    if (!this.loading && this.activities.length === 0 && !this.updatedAt &&
        Date.now() - this.lastLoadStartedAt >= 800) {
      this.loadNotifications();
    }
    this.refreshRenderedView();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.requestVersion++;
    this.fetchSubscription?.unsubscribe();
  }

  // Ensure API callbacks update the screen immediately, including
  // Ionic/Capacitor setups where a callback runs outside Angular's normal
  // change-detection cycle. This does not issue another HTTP request.
  private refreshRenderedView(): void {
    if (this.destroyed) return;
    this.changeDetector.markForCheck();
    this.changeDetector.detectChanges();
  }

  get filteredActivities(): NotificationActivity[] {
    if (this.activeFilter === 'all') {
      return this.activities;
    }
    return this.activities.filter(item => item.category === this.activeFilter);
  }

  get visibleActivities(): NotificationActivity[] {
    return this.filteredActivities.slice(0, this.visibleCount);
  }

  get hasMore(): boolean {
    return this.filteredActivities.length > this.visibleCount;
  }

  countFor(filter: ActivityFilter): number {
    return filter === 'all'
      ? this.activities.length
      : this.activities.filter(item => item.category === filter).length;
  }

  setFilter(filter: ActivityFilter): void {
    this.activeFilter = filter;
    this.visibleCount = 20;
  }

  onFilterChange(event: Event): void {
    const value = (event.target as HTMLSelectElement | null)?.value;
    if (value === 'all' || value === 'ownership' ||
        value === 'recovery' || value === 'adoption') {
      this.setFilter(value);
    }
  }

  showMore(): void {
    this.visibleCount += 20;
  }

  goBack(): void {
    this.router.navigateByUrl('/home');
  }

  openActivity(item: NotificationActivity): void {
    // The destination pages enforce authenticated record access.
    // This is section-level navigation, not a link to private images.
    this.router.navigateByUrl(item.route);
  }

  trackActivity(_index: number, item: NotificationActivity): string {
    return item.id;
  }

  // Show each API result as soon as it arrives. Previously forkJoin
  // held back ALL items until the slowest of six requests completed.
  loadNotifications(): void {
    this.fetchSubscription?.unsubscribe();
    const version = ++this.requestVersion;
    this.lastLoadStartedAt = Date.now();

    // Never reuse activities from a different logged-in account.
    const session = sessionStorage.getItem('pawrescue_token') || '';
    if (session !== this.activitySession) {
      this.activitySession = session;
      this.activities = [];
      this.updatedAt = null;
    }

    this.loading = true;
    this.error = '';
    this.notice = '';
    // Do not clear same-user activities on every visit. Show them instantly
    // while new results load in the background.

    const claimBatch = (scope: ActivityScope) =>
      this.activityBatch(
        this.petReportsService.getOwnershipClaims(scope, { limit: 50, offset: 0 }),
        response => {
          const items: NotificationActivity[] = [];
          this.addOwnershipItems(items, response, scope);
          return items;
        }
      );

    const recoveryBatch = (scope: ActivityScope) =>
      this.activityBatch(
        this.petReportsService.getLostPetRecoveries(scope, { limit: 50, offset: 0 }),
        response => {
          const items: NotificationActivity[] = [];
          this.addRecoveryItems(items, response, scope);
          return items;
        }
      );

    const adoptionBatch = (scope: ActivityScope) =>
      this.activityBatch(
        this.adoptionService.getRequests(scope),
        response => {
          const items: NotificationActivity[] = [];
          this.addAdoptionItems(items, response, scope);
          return items;
        }
      );

    // Seed from previously loaded items so refreshing one category does
    // not temporarily hide all the other cards.
    const batches = new Map<string, NotificationActivity[]>([
      ['claims-sent', this.activities.filter(item => item.category === 'ownership' && item.scope === 'sent')],
      ['claims-received', this.activities.filter(item => item.category === 'ownership' && item.scope === 'received')],
      ['recoveries-sent', this.activities.filter(item => item.category === 'recovery' && item.scope === 'sent')],
      ['recoveries-received', this.activities.filter(item => item.category === 'recovery' && item.scope === 'received')],
      ['adoptions-sent', this.activities.filter(item => item.category === 'adoption' && item.scope === 'sent')],
      ['adoptions-received', this.activities.filter(item => item.category === 'adoption' && item.scope === 'received')]
    ]);
    let finished = 0;
    let failures = 0;
    const total = 6;

    this.fetchSubscription = merge(
      claimBatch('sent').pipe(map(result => ({ source: 'claims-sent', ...result }))),
      claimBatch('received').pipe(map(result => ({ source: 'claims-received', ...result }))),
      recoveryBatch('sent').pipe(map(result => ({ source: 'recoveries-sent', ...result }))),
      recoveryBatch('received').pipe(map(result => ({ source: 'recoveries-received', ...result }))),
      adoptionBatch('sent').pipe(map(result => ({ source: 'adoptions-sent', ...result }))),
      adoptionBatch('received').pipe(map(result => ({ source: 'adoptions-received', ...result })))
    ).subscribe({
      next: result => {
        if (this.destroyed || version !== this.requestVersion) return;

        finished++;
        if (result.failed) {
          failures++;
          // Keep cached items on a failed refresh, but warn the user.
        } else {
          batches.set(result.source, result.items);
        }
        this.activities = Array.from(batches.values())
          .flat()
          .sort((a, b) => b.date.getTime() - a.date.getTime());

        if (finished === total) {
          this.loading = false;
          if (failures === total) {
            this.error = 'Unable to update your activity. Check your connection and try again.';
          } else {
            this.updatedAt = new Date();
            if (failures > 0) {
              this.notice = 'Some activity could not be refreshed. Existing items may be out of date.';
            }
          }
        }
        this.refreshRenderedView();
      },
      error: () => {
        if (this.destroyed || version !== this.requestVersion) return;
        this.loading = false;
        this.error = 'Unable to load notifications. Please try again.';
        this.refreshRenderedView();
      }
    });
  }

  private activityBatch<T>(
    request: Observable<T>,
    buildItems: (data: T) => NotificationActivity[]
  ): Observable<{ items: NotificationActivity[]; failed: boolean }> {
    return this.safeFetch(request).pipe(
      map(result => ({
        items: result.data === null ? [] : buildItems(result.data),
        failed: result.failed
      })),
      catchError(() => of({ items: [] as NotificationActivity[], failed: true }))
    );
  }

  private safeFetch<T>(request: Observable<T>): Observable<FetchResult<T>> {
    return request.pipe(
      timeout(15000),
      map(data => ({ data, failed: false })),
      catchError(() => of({ data: null, failed: true }))
    );
  }

  private addOwnershipItems(
    output: NotificationActivity[],
    response: OwnershipClaimsResponse | null,
    scope: ActivityScope
  ): void {
    if (!response?.success || !Array.isArray(response.claims)) return;

    for (const claim of response.claims) {
      const state = this.ownershipText(claim, scope);
      output.push({
        id: `ownership-${scope}-${claim.id}`,
        category: 'ownership',
        scope,
        title: state.title,
        message: state.message,
        statusLabel: this.formatStatus(claim.status),
        tone: state.tone,
        icon: 'shield-checkmark-outline',
        route: '/my-claims',
        date: this.toDate(claim.updated_at || claim.created_at)
      });
    }
  }

  private addRecoveryItems(
    output: NotificationActivity[],
    response: LostPetRecoveriesResponse | null,
    scope: ActivityScope
  ): void {
    if (!response?.success || !Array.isArray(response.recoveries)) return;

    for (const recovery of response.recoveries) {
      const state = this.recoveryText(recovery, scope);
      output.push({
        id: `recovery-${scope}-${recovery.id}`,
        category: 'recovery',
        scope,
        title: state.title,
        message: state.message,
        statusLabel: this.formatStatus(recovery.status),
        tone: state.tone,
        icon: 'paw-outline',
        route: '/my-recoveries',
        date: this.toDate(recovery.updated_at || recovery.created_at)
      });
    }
  }

  private addAdoptionItems(
    output: NotificationActivity[],
    response: AdoptionRequestsResponse | null,
    scope: ActivityScope
  ): void {
    if (!response?.success || !Array.isArray(response.requests)) return;

    for (const request of response.requests) {
      const state = this.adoptionText(request, scope);
      output.push({
        id: `adoption-${scope}-${request.id}`,
        category: 'adoption',
        scope,
        title: state.title,
        message: state.message,
        statusLabel: this.formatStatus(request.status),
        tone: state.tone,
        icon: 'heart-outline',
        route: '/my-adoptions',
        date: this.toDate(request.updated_at || request.created_at)
      });
    }
  }

  private ownershipText(
    claim: OwnershipClaim,
    scope: ActivityScope
  ): { title: string; message: string; tone: ActivityTone } {
    const pet = claim.pet_name?.trim() || 'a found pet';
    switch (claim.status) {
      case 'pending':
        return scope === 'received'
          ? { title: 'Ownership Claim Awaiting Review', message: `Someone submitted an ownership claim for ${pet}. Review their evidence in My Claims.`, tone: 'warning' }
          : { title: 'Ownership Claim Submitted', message: `Your claim for ${pet} is waiting for the finder to review it.`, tone: 'neutral' };
      case 'approved':
      case 'pickup_scheduled':
        return { title: 'Ownership Claim Approved', message: `A pickup arrangement for ${pet} is available in My Claims.`, tone: 'success' };
      case 'reschedule_requested':
        return { title: 'Ownership Pickup Reschedule', message: `A new pickup schedule for ${pet} needs attention in My Claims.`, tone: 'warning' };
      case 'completed':
        return { title: 'Pet Return Completed', message: `The handover for ${pet} has been confirmed by both residents.`, tone: 'success' };
      case 'rejected':
        return { title: 'Ownership Claim Rejected', message: `The claim for ${pet} was not approved. You can review the details in My Claims.`, tone: 'danger' };
      case 'disputed':
        return { title: 'Ownership Claim Disputed', message: `The ownership claim for ${pet} needs attention.`, tone: 'warning' };
      case 'cancelled':
        return { title: 'Ownership Claim Closed', message: `The ownership claim for ${pet} was cancelled.`, tone: 'neutral' };
      default:
        return { title: 'Ownership Claim Update', message: `Review the latest status for ${pet}.`, tone: 'neutral' };
    }
  }

  private recoveryText(
    recovery: LostPetRecovery,
    scope: ActivityScope
  ): { title: string; message: string; tone: ActivityTone } {
    const pet = recovery.pet_name?.trim() || 'a missing pet';
    switch (recovery.status) {
      case 'pending':
        return scope === 'received'
          ? { title: 'Lost Pet Finding Awaiting Review', message: `A resident reported finding ${pet}. Review their evidence in My Recoveries.`, tone: 'warning' }
          : { title: 'Finding Report Submitted', message: `Your finding report for ${pet} is waiting for the pet owner to review.`, tone: 'neutral' };
      case 'approved':
      case 'pickup_scheduled':
        return { title: 'Recovery Pickup Scheduled', message: `A pickup arrangement for ${pet} is available in My Recoveries.`, tone: 'success' };
      case 'reschedule_requested':
        return { title: 'Recovery Pickup Reschedule', message: `A reschedule for ${pet} needs attention in My Recoveries.`, tone: 'warning' };
      case 'completed':
        return { title: 'Lost Pet Reunited', message: `The return of ${pet} has been confirmed by both residents.`, tone: 'success' };
      case 'rejected':
        return { title: 'Finding Report Rejected', message: `The finding report for ${pet} was not approved.`, tone: 'danger' };
      case 'disputed':
        return { title: 'Recovery Disputed', message: `The recovery for ${pet} needs attention.`, tone: 'warning' };
      case 'cancelled':
        return { title: 'Recovery Closed', message: `The finding report for ${pet} was cancelled.`, tone: 'neutral' };
      default:
        return { title: 'Lost Pet Recovery Update', message: `Review the latest recovery status for ${pet}.`, tone: 'neutral' };
    }
  }

  private adoptionText(
    request: AdoptionRequest,
    scope: ActivityScope
  ): { title: string; message: string; tone: ActivityTone } {
    const pet = request.pet_name?.trim() || 'a pet';
    switch (request.status) {
      case 'pending':
        return scope === 'received'
          ? { title: 'Adoption Request Awaiting Review', message: `Someone requested to adopt ${pet}. Review the application in My Adoptions.`, tone: 'warning' }
          : { title: 'Adoption Request Submitted', message: `Your request to adopt ${pet} is waiting for the owner's decision.`, tone: 'neutral' };
      case 'approved':
        return { title: 'Adoption Request Approved', message: `The adoption request for ${pet} was approved. Review the pickup arrangement in My Adoptions.`, tone: 'success' };
      case 'rejected':
        return { title: 'Adoption Request Not Approved', message: `The adoption request for ${pet} was not approved.`, tone: 'danger' };
      case 'completed':
        return { title: 'Adoption Completed', message: `The adoption process for ${pet} has been completed.`, tone: 'success' };
      case 'cancelled':
        return { title: 'Adoption Request Cancelled', message: `The adoption request for ${pet} was cancelled.`, tone: 'neutral' };
      default:
        return { title: 'Adoption Request Update', message: `Review the latest adoption status for ${pet}.`, tone: 'neutral' };
    }
  }

  private formatStatus(status: string): string {
    return status.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  }

  private toDate(value: string | null | undefined): Date {
    if (!value) return new Date(0);
    // MySQL DATETIME values are local Philippine wall-clock times.
    // ISO strings that already include a timezone are left untouched.
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)
      ? value.replace(' ', 'T')
      : value;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
  }
}
