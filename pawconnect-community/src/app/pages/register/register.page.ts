
import { Component, ChangeDetectorRef, inject } from '@angular/core';
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
import { HapticsService } from '../../services/haptics.service';

@Component({
  selector: 'app-register',
  templateUrl: './register.page.html',
  styleUrls: ['./register.page.scss'],
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
export class RegisterPage {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private haptics = inject(HapticsService);

  form = {
    first_name: '',
    middle_name: '',
    last_name: '',
    email: '',
    username: '',
    contact_number: '',
    password: '',
    confirm_password: ''
  };

  loading = false;
  errorMessage = '';
  successMessage = '';

  private validationError(message: string): void {
    this.errorMessage = message;
    void this.haptics.error();
  }

  register() {
    // Prevent multiple submissions
    if (this.loading) {
      return;
    }

    this.errorMessage = '';
    this.successMessage = '';

    const data = {
      first_name: this.form.first_name.trim(),
      middle_name: this.form.middle_name.trim(),
      last_name: this.form.last_name.trim(),
      email: this.form.email.trim().toLowerCase(),
      username: this.form.username.trim(),
      contact_number: this.form.contact_number.trim(),
      password: this.form.password,
      confirm_password: this.form.confirm_password
    };

    // Required fields
    if (
      !data.first_name ||
      !data.last_name ||
      !data.email ||
      !data.username ||
      !data.contact_number ||
      !data.password ||
      !data.confirm_password
    ) {
      this.validationError('Please complete all required fields.');
      return;
    }

    // Validate names
    if (
      data.first_name.length > 100 ||
      data.middle_name.length > 100 ||
      data.last_name.length > 100
    ) {
      this.validationError('Name fields must not exceed 100 characters.');
      return;
    }

    const fullName = [
      data.first_name,
      data.middle_name,
      data.last_name
    ].filter(Boolean).join(' ');

    if (fullName.length > 150) {
      this.validationError('Full name must not exceed 150 characters.');
      return;
    }

    // Validate email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(data.email)) {
      this.validationError('Please enter a valid email address.');
      return;
    }

    // Validate username
    const usernameRegex = /^[a-zA-Z0-9_]{3,50}$/;

    if (!usernameRegex.test(data.username)) {
      this.validationError(
        'Username must be 3-50 characters and contain only letters, numbers, or underscores.'
      );
      return;
    }

    // Validate contact number
    const contactRegex = /^\+?[0-9]{10,15}$/;

    if (!contactRegex.test(data.contact_number)) {
      this.validationError('Please enter a valid contact number.');
      return;
    }

    // Validate password
    if (
      data.password.length < 8 ||
      data.password.length > 72
    ) {
      this.validationError('Password must be 8-72 characters.');
      return;
    }

    if (data.password !== data.confirm_password) {
      this.validationError('Passwords do not match.');
      return;
    }

    void this.haptics.medium();
    this.loading = true;
    this.cdr.detectChanges();

    console.time('Registration API');

    this.authService.register(data)
      .pipe(
        finalize(() => {
          this.loading = false;
          this.cdr.detectChanges();
          console.timeEnd('Registration API');
        })
      )
      .subscribe({
        next: (response) => {
          if (response.success) {
            void this.haptics.success();
            this.successMessage = response.message;

            // Clear form on success
            this.form = {
              first_name: '',
              middle_name: '',
              last_name: '',
              email: '',
              username: '',
              contact_number: '',
              password: '',
              confirm_password: ''
            };

            this.cdr.detectChanges();
          } else {
            void this.haptics.error();
            this.errorMessage = response.message;
          }
        },

        error: (error) => {
          console.error('Registration error:', error);
          void this.haptics.error();

          if (error.name === 'TimeoutError') {
            this.errorMessage =
              'The server is taking too long to respond. ' +
              'Your account may already have been created. ' +
              'Please try logging in before registering again.';
          } else {
            this.errorMessage =
              error.error?.message ||
              'Registration failed. Please try again.';
          }

          this.cdr.detectChanges();
        }
      });
  }

  goToLogin() {
    void this.haptics.light();
    this.router.navigateByUrl('/login');
  }
}
