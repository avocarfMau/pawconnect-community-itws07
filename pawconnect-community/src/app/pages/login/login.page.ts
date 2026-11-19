import { Component, ChangeDetectorRef, NgZone, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { finalize, timeout } from 'rxjs';

import {
  IonContent,
  IonInput,
  IonButton,
  IonSpinner
} from '@ionic/angular';

import { AuthService } from '../../services/auth';
import { HapticsService } from '../../services/haptics.service';

@Component({
  selector: 'app-login',
  templateUrl: './login.page.html',
  styleUrls: ['./login.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    IonContent,
    IonInput,
    IonButton,
    IonSpinner
  ]
})
export class LoginPage {
  private authService = inject(AuthService);
  private router = inject(Router);
  private haptics = inject(HapticsService);
  private zone = inject(NgZone);
  private cdr = inject(ChangeDetectorRef);

  // Ensure the Ionic template reflects asynchronous HTTP state changes.
  private updateLoginUI(update: () => void): void {
    this.zone.run(() => {
      update();
      this.cdr.detectChanges();
    });
  }

  loginInput = '';
  password = '';
  showPassword = false;

  loading = false;
  errorMessage = '';

  login() {
    if (this.loading) {
      return;
    }

    this.errorMessage = '';

    if (!this.loginInput.trim() || !this.password) {
      this.errorMessage = 'Please complete all fields.';
      void this.haptics.error();
      return;
    }

    void this.haptics.medium();
    this.loading = true;
    console.time('Login API Request');

    this.authService.login(
      this.loginInput.trim(),
      this.password
    )
    .pipe(
      timeout(12000),
      finalize(() => {
        this.updateLoginUI(() => { this.loading = false; });
        console.timeEnd('Login API Request');
      })
    )
    .subscribe({
      next: (response) => {
        this.updateLoginUI(() => {
        if (response.success && response.token) {
          const role = response.user?.role;

          if (role !== 'resident' && role !== 'staff') {
            this.authService.clearSession();
            this.errorMessage =
              'Invalid account role. Please contact support.';
            void this.haptics.error();
            return;
          }

          void this.haptics.success();
          this.authService.saveSession(response);
          this.password = '';

          const destination =
            role === 'staff' ? '/staff-dashboard' : '/home';

          this.router.navigateByUrl(destination, {
            replaceUrl: true
          }).then((navigated) => {
            if (!navigated) {
              this.updateLoginUI(() => {
                this.errorMessage = 'Login successful, but unable to open the dashboard.';
              });
              void this.haptics.error();
            }
          }).catch((error) => {
            console.error('Navigation error:', error);
            this.updateLoginUI(() => {
              this.errorMessage = 'Unable to open the dashboard. Please try again.';
            });
            void this.haptics.error();
          });
        } else {
          this.errorMessage =
            response.message ||
            'Login failed. Please try again.';
          void this.haptics.error();
        }
        });
      },
      error: (error) => {
        // A 401 is an expected result for incorrect credentials.
        if (error?.status !== 401) {
          console.error('Login request failed:', error?.status, error?.message);
        }

        void this.haptics.error();
        this.updateLoginUI(() => {

        if (error?.name === 'TimeoutError') {
          this.errorMessage =
            'Login is taking too long. Please check your connection and try again.';
        } else if (error.status === 401) {
          this.errorMessage =
            'Invalid email/username or password.';
        } else if (error.status === 403) {
          this.errorMessage =
            'Your account is inactive. Please contact support.';
        } else if (error.status === 0) {
          this.errorMessage =
            'Unable to connect to the server. Please check your connection.';
        } else {
          this.errorMessage =
            error.error?.message ||
            'Something went wrong. Please try again.';
        }
        });
      }
    });
  }

  togglePassword() {
    void this.haptics.selection();
    this.showPassword = !this.showPassword;
  }

  goToRegister() {
    void this.haptics.light();
    this.router.navigateByUrl('/register');
  }
}
