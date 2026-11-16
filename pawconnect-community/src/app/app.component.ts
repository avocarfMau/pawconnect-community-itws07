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
  private pushRegistrationStartedFor: string | null = null;

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

    if (path === '/login' || path === '/register') {
      this.pushRegistrationStartedFor = null;
      return;
    }

    if (!this.isResidentRoute(path)) {
      return;
    }

    if (!this.pushNotifications.isSupported()) {
      return;
    }

    const sessionToken = this.authService.getToken();

    if (!sessionToken) {
      this.pushRegistrationStartedFor = null;
      return;
    }

    if (this.pushRegistrationStartedFor === sessionToken) {
      return;
    }

    this.pushRegistrationStartedFor = sessionToken;

    try {
      await this.pushNotifications.registerForPush();
    } catch {
      if (this.pushRegistrationStartedFor === sessionToken) {
        this.pushRegistrationStartedFor = null;
      }
      console.warn('[PawConnect] Push notification registration failed.');
    }
  }
}
