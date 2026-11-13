import { Component } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { IonApp, IonRouterOutlet } from '@ionic/angular';
import { filter } from 'rxjs';

import { AuthService } from './services/auth';
import { PushNotificationService } from './services/push-notifications';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  imports: [IonApp, IonRouterOutlet],
})
export class AppComponent {
  // Avoid repeated FCM registration on every page navigation.
  // Keep this in memory only; never log the resident's auth token.
  private pushRegistrationStartedFor: string | null = null;

  // These are the resident-only routes configured in app.routes.ts.
  // Only these routes should trigger resident push registration.
  // Add new resident-protected routes here when they are introduced.
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

  constructor(
    private readonly router: Router,
    private readonly authService: AuthService,
    private readonly pushNotifications: PushNotificationService
  ) {
    // NavigationEnd only occurs after a route's guards succeed.
    // Login, Register, and staff routes must not register resident push.
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      takeUntilDestroyed()
    ).subscribe((event) => {
      void this.initializePushForResident(event.urlAfterRedirects);
    });
  }

  private isResidentRoute(path: string): boolean {
    return this.residentRoutes.has(path)
      || /^\/(?:edit-report|adoption-details)\/[^/]+$/.test(path);
  }

  private async initializePushForResident(url: string): Promise<void> {
    const pathname = url.split('?')[0].split('#')[0];
    const path = pathname.replace(/\/+$/, '') || '/';

    // Clear the in-memory registration guard when leaving the account.
    if (path === '/login' || path === '/register') {
      this.pushRegistrationStartedFor = null;
      return;
    }

    // Staff Dashboard / Animal Assistance Management are intentionally
    // excluded: only residentGuard-protected routes can register resident FCM.
    if (!this.isResidentRoute(path)) {
      return;
    }

    // Firebase native push is not available under ionic serve.
    if (!this.pushNotifications.isSupported()) {
      return;
    }

    // Resident route guards have already succeeded at NavigationEnd.
    const sessionToken = this.authService.getToken();

    if (!sessionToken) {
      this.pushRegistrationStartedFor = null;
      return;
    }

    if (this.pushRegistrationStartedFor === sessionToken) {
      return;
    }

    // Set before awaiting to prevent simultaneous registration attempts.
    this.pushRegistrationStartedFor = sessionToken;

    try {
      // Permission is requested here if needed. The FCM token arrives
      // asynchronously via PushNotificationService.token$.
      await this.pushNotifications.registerForPush();
    } catch {
      // Allow a later authenticated navigation to retry if registration failed.
      if (this.pushRegistrationStartedFor === sessionToken) {
        this.pushRegistrationStartedFor = null;
      }
      console.warn('[PawConnect] Push notification registration failed.');
    }
  }
}
