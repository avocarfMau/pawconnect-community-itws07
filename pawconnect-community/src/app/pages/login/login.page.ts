import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { finalize } from 'rxjs';

import {
  IonContent,
  IonInput,
  IonButton,
  IonSpinner
} from '@ionic/angular';

import { AuthService } from '../../services/auth';

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
      return;
    }

    this.loading = true;
    console.time('Login API Request');

    this.authService.login(
      this.loginInput.trim(),
      this.password
    )
    .pipe(
      finalize(() => {
        this.loading = false;
        console.timeEnd('Login API Request');
      })
    )
    .subscribe({
      next: (response) => {
        if (response.success && response.token) {
          const role = response.user?.role;

          if (role !== 'resident' && role !== 'staff') {
            this.authService.clearSession();
            this.errorMessage =
              'Invalid account role. Please contact support.';
            return;
          }

          this.authService.saveSession(response);
          this.password = '';

          const destination =
            role === 'staff' ? '/staff-dashboard' : '/home';

          this.router.navigateByUrl(destination, {
            replaceUrl: true
          }).then((navigated) => {
            if (!navigated) {
              this.errorMessage =
                'Login successful, but unable to open the dashboard.';
            }
          }).catch((error) => {
            console.error('Navigation error:', error);
            this.errorMessage =
              'Unable to open the dashboard. Please try again.';
          });
        } else {
          this.errorMessage =
            response.message ||
            'Login failed. Please try again.';
        }
      },
      error: (error) => {
        console.error(
          'Login request failed:',
          error.status,
          error.message
        );

        if (error.status === 401) {
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
      }
    });
  }

  togglePassword() {
    this.showPassword = !this.showPassword;
  }

  goToRegister() {
    this.router.navigateByUrl('/register');
  }
}
