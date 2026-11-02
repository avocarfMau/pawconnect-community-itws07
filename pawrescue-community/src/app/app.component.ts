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

  constructor(
    private readonly router: Router,
    private readonly authService: AuthService,
    private readonly pushNotifications: PushNotificationService
  ) {
    // Register only after successful navigation to a resident-only page.
    // Login and Register do not trigger a notification permission prompt.
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      takeUntilDestroyed()
    ).subscribe((event) => {
      void this.initializePushForResident(event.urlAfterRedirects);
    });
  }

  private async initializePushForResident(url: string): Promise<void> {
    const path = url.split('?')[0].split('#')[0];

    // Clear the in-memory registration guard when leaving the account.
    // The backend will later manage device-token unlinking on logout.
    if (path === '/login' || path === '/register') {
      this.pushRegistrationStartedFor = null;
      return;
    }

    // Firebase native push is not available under ionic serve.
    if (!this.pushNotifications.isSupported()) {
      return;
    }

    // Every other configured PawRescue page requires residentGuard.
    // Wait for NavigationEnd so that guard has already succeeded.
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
      // Device-token upload to PHP/MySQL will be added in the next step.
      await this.pushNotifications.registerForPush();
    } catch {
      // Allow a later authenticated navigation to retry if registration failed.
      if (this.pushRegistrationStartedFor === sessionToken) {
        this.pushRegistrationStartedFor = null;
      }
      console.warn('[PawRescue] Push notification registration failed.');
    }
  }
}
