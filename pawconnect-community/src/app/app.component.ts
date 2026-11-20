import { Component } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { IonApp, IonRouterOutlet } from '@ionic/angular';
import { Capacitor } from '@capacitor/core';
import { PushNotifications, type ActionPerformed } from '@capacitor/push-notifications';
import { filter } from 'rxjs';

import { AuthService } from './services/auth';
import { PushNotificationService } from './services/push-notifications';

type NotificationAudience = 'resident' | 'staff';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  imports: [IonApp, IonRouterOutlet],
})
export class AppComponent {
  private pushRegistrationStartedFor: string | null = null;
  private pendingNotification: { route: string; audience: NotificationAudience } | null = null;
  private handlingNotificationNavigation = false;

  private readonly residentRoutes = new Set<string>([
    '/home',
    '/notifications',
    '/lost-found',
    '/report-pet',
    '/my-reports',
    '/my-claims',
    '/my-recoveries',
    '/pet-adoption',
    '/post-adoption',
    '/my-adoptions',
    '/my-account',
  ]);

  private readonly staffRoutes = new Set<string>([
    '/staff-dashboard',
    '/staff-animal-assistance',
    '/staff-my-assisted-cases',
    '/staff-my-account',
  ]);

  constructor(
    private readonly router: Router,
    private readonly authService: AuthService,
    private readonly pushNotifications: PushNotificationService
  ) {
    // Listen early so taps that launch Android from a stopped state are handled.
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      void PushNotifications.addListener(
        'pushNotificationActionPerformed',
        (action: ActionPerformed) => {
          void this.handleNotificationTap(action);
        }
      ).catch(() => {
        console.warn('[PawConnect] Notification tap listener could not be installed.');
      });
    }

    // NavigationEnd fires only after the destination's route guards succeed.
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      takeUntilDestroyed()
    ).subscribe((event) => {
      void this.initializePushForAuthenticatedRoute(event.urlAfterRedirects);
      void this.resumeNotificationNavigation(event.urlAfterRedirects);
    });
  }

  private normalizedPath(url: string): string {
    const pathname = url.split('?')[0].split('#')[0];
    return pathname.replace(/\/+$/, '') || '/';
  }

  private isResidentRoute(path: string): boolean {
    return this.residentRoutes.has(path)
      || /^\/(?:edit-report|adoption-details)\/\d+$/.test(path);
  }

  private isStaffRoute(path: string): boolean {
    return this.staffRoutes.has(path)
      || /^\/staff-animal-assistance\/[1-9]\d*$/.test(path);
  }

  private validatedResidentNotificationRoute(
    data: Record<string, unknown> | undefined
  ): string {
    const rawRoute = data?.['route'];
    if (typeof rawRoute === 'string' && rawRoute.startsWith('/')
        && !rawRoute.startsWith('//') && !rawRoute.includes('#')
        && !rawRoute.includes('\\')) {
      const claimsTabRoute = /^\/my-claims\?tab=(sent|received)$/.exec(rawRoute);
      if (claimsTabRoute) return `/my-claims?tab=${claimsTabRoute[1]}`;

      const recoveriesTabRoute = /^\/my-recoveries\?tab=(sent|received)$/.exec(rawRoute);
      if (recoveriesTabRoute) return `/my-recoveries?tab=${recoveriesTabRoute[1]}`;

      const adoptionsTabRoute = /^\/my-adoptions\?tab=(sent|received)$/.exec(rawRoute);
      if (adoptionsTabRoute) return `/my-adoptions?tab=${adoptionsTabRoute[1]}`;

      if (!rawRoute.includes('?')) {
        const route = this.normalizedPath(rawRoute);
        if (this.isResidentRoute(route)) {
          if (route === '/my-claims') {
            const tab = data?.['claims_tab'];
            if (tab === 'sent' || tab === 'received') return `/my-claims?tab=${tab}`;
          }
          if (route === '/my-recoveries') {
            const tab = data?.['recoveries_tab'];
            if (tab === 'sent' || tab === 'received') return `/my-recoveries?tab=${tab}`;
          }
          if (route === '/my-adoptions') {
            const tab = data?.['adoptions_tab'];
            if (tab === 'sent' || tab === 'received') return `/my-adoptions?tab=${tab}`;
          }
          return route;
        }
      }
    }

    const rawType = data?.['type'];
    const type = typeof rawType === 'string' ? rawType.toLowerCase() : '';
    const rawId = data?.['adoption_id'] ?? data?.['listing_id'];
    const id = typeof rawId === 'number' || typeof rawId === 'string' ? String(rawId) : '';

    if (type.includes('adoption')) {
      return /^\d+$/.test(id) && Number(id) > 0
        ? `/adoption-details/${id}`
        : '/my-adoptions';
    }
    if (type.startsWith('ownership_')) return '/notifications';
    if (type.includes('claim')) return '/my-claims';
    if (type.includes('recover') || type.includes('recovery')) return '/my-recoveries';
    if (type.includes('lost') || type.includes('found') || type.includes('report')) {
      return '/my-reports';
    }
    return '/notifications';
  }

  private validatedStaffNotificationRoute(
    data: Record<string, unknown> | undefined
  ): string {
    const rawRoute = data?.['route'];
    if (typeof rawRoute === 'string') {
      // Never accept arbitrary routes, query strings, fragments or external URLs.
      if (rawRoute === '/staff-animal-assistance') return rawRoute;
      const caseRoute = /^\/staff-animal-assistance\/([1-9]\d*)$/.exec(rawRoute);
      if (caseRoute) return `/staff-animal-assistance/${caseRoute[1]}`;
    }

    const rawCaseId = data?.['assistance_case_id'] ?? data?.['case_id'];
    const caseId = typeof rawCaseId === 'number' || typeof rawCaseId === 'string'
      ? String(rawCaseId)
      : '';
    if (/^[1-9]\d*$/.test(caseId)) {
      return `/staff-animal-assistance/${caseId}`;
    }
    return '/staff-animal-assistance';
  }

  private async handleNotificationTap(action: ActionPerformed): Promise<void> {
    const data = action.notification?.data as Record<string, unknown> | undefined;
    const rawType = data?.['type'];
    const type = typeof rawType === 'string' ? rawType.toLowerCase() : '';
    const rawAudience = data?.['audience'];
    const rawRoute = data?.['route'];

    // Staff routing must be explicit; do not classify a resident Found Pet
    // notification as staff-only just because it mentions a found animal.
    const staffNotification = rawAudience === 'staff'
      || type === 'animal_assistance_request'
      || (typeof rawRoute === 'string'
        && /^\/staff-animal-assistance(?:\/[1-9]\d*)?$/.test(rawRoute));

    this.pendingNotification = staffNotification
      ? { audience: 'staff', route: this.validatedStaffNotificationRoute(data) }
      : { audience: 'resident', route: this.validatedResidentNotificationRoute(data) };

    await this.resumeNotificationNavigation(this.router.url);
  }

  private async resumeNotificationNavigation(currentUrl: string): Promise<void> {
    if (!this.pendingNotification || this.handlingNotificationNavigation) return;

    const currentPath = this.normalizedPath(currentUrl);
    const token = this.authService.getToken();
    if (!token) {
      if (currentPath !== '/login') {
        await this.router.navigateByUrl('/login');
      }
      return;
    }

    const pending = this.pendingNotification;
    // Never cross from resident pages into staff pages (or vice versa).
    // The destination route's residentGuard/staffGuard provides final authorization.
    if (pending.audience === 'staff' && !this.isStaffRoute(currentPath)) return;
    if (pending.audience === 'resident' && !this.isResidentRoute(currentPath)) return;

    this.handlingNotificationNavigation = true;
    try {
      const navigated = await this.router.navigateByUrl(pending.route);
      if (navigated && this.pendingNotification === pending) {
        this.pendingNotification = null;
      }
    } catch {
      console.warn('[PawConnect] Notification destination could not be opened.');
      if (this.pendingNotification === pending) {
        this.pendingNotification = null;
        await this.router.navigateByUrl(
          pending.audience === 'staff' ? '/staff-animal-assistance' : '/notifications'
        );
      }
    } finally {
      this.handlingNotificationNavigation = false;
    }
  }

  private async initializePushForAuthenticatedRoute(url: string): Promise<void> {
    const path = this.normalizedPath(url);

    if (path === '/login' || path === '/register') {
      this.pushRegistrationStartedFor = null;
      return;
    }

    // Only initiate registration after a guarded resident or staff route succeeds.
    if (!this.isResidentRoute(path) && !this.isStaffRoute(path)) return;
    if (!this.pushNotifications.isSupported()) return;

    const sessionToken = this.authService.getToken();
    if (!sessionToken) {
      this.pushRegistrationStartedFor = null;
      return;
    }
    if (this.pushRegistrationStartedFor === sessionToken) return;

    this.pushRegistrationStartedFor = sessionToken;
    try {
      const result = await this.pushNotifications.registerForPush();
      if (result === 'denied' && this.pushRegistrationStartedFor === sessionToken) {
        // Allow another registration attempt after Android permissions change.
        this.pushRegistrationStartedFor = null;
      }
    } catch {
      if (this.pushRegistrationStartedFor === sessionToken) {
        this.pushRegistrationStartedFor = null;
      }
      console.warn('[PawConnect] Push notification registration failed.');
    }
  }
}
