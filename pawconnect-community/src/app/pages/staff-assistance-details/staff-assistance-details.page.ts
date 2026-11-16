import { CommonModule } from '@angular/common';
import { Component, OnDestroy, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  HttpClient,
  HttpErrorResponse,
  HttpHeaders,
  HttpParams
} from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { IonContent, IonIcon, IonSpinner } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  refreshOutline,
  pawOutline,
  heartOutline,
  alertCircleOutline,
  locationOutline,
  calendarOutline,
  personOutline,
  documentTextOutline,
  imageOutline,
  timeOutline,
  checkmarkCircleOutline,
  saveOutline
} from 'ionicons/icons';
import { Subscription } from 'rxjs';

import { getApiBaseUrl } from '../../config/ip-config';
import { AuthService } from '../../services/auth';
import type {
  AssistanceStatus,
  StaffAssistanceCase
} from '../staff-animal-assistance/staff-animal-assistance.page';

// ============================================================
// PAWCONNECT — STAFF ANIMAL ASSISTANCE CASE DETAILS + MANAGEMENT
// ============================================================
// Cases originate from residents' EXISTING Found Pet reports.
// This staff-only page can view a case and update its assistance
// status / assessment notes without editing the Found Pet report.
//
// GET  /animal_assistance/get_cases.php?case_id=<id>&limit=1&offset=0
// POST /animal_assistance/update_case.php
// Route: /staff-animal-assistance/:id (protected by staffGuard)
//
// Companion HTML / SCSS will be updated separately for the edit form.
// ============================================================

interface GetCaseDetailsResponse {
  success: boolean;
  message: string;
  total: number;
  cases: StaffAssistanceCase[];
}

interface UpdatedCaseResult {
  id: number;
  found_report_id: number;
  previous_status: AssistanceStatus;
  status: AssistanceStatus;
  staff_notes: string | null;
  reviewed_at: string | null;
  resolved_at: string | null;
  updated_at: string;
}

interface UpdateCaseResponse {
  success: boolean;
  message: string;
  case: UpdatedCaseResult;
}

const NEXT_STATUS: Record<AssistanceStatus, AssistanceStatus | null> = {
  pending: 'under_review',
  under_review: 'in_progress',
  in_progress: 'resolved',
  resolved: null
};

@Component({
  selector: 'app-staff-assistance-details',
  templateUrl: './staff-assistance-details.page.html',
  styleUrls: ['./staff-assistance-details.page.scss'],
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent, IonIcon, IonSpinner]
})
export class StaffAssistanceDetailsPage implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly apiBaseUrl = getApiBaseUrl().replace(/\/$/, '');
  private readonly casesEndpoint =
    `${this.apiBaseUrl}/animal_assistance/get_cases.php`;
  private readonly updateEndpoint =
    `${this.apiBaseUrl}/animal_assistance/update_case.php`;

  private caseSubscription?: Subscription;
  private updateSubscription?: Subscription;
  private requestVersion = 0;

  caseId: number | null = null;
  assistanceCase: StaffAssistanceCase | null = null;
  photoUrl: string | null = null;
  loading = false;
  errorMessage = '';
  lastUpdated: Date | null = null;

  // Staff edit form. The dropdown offers the CURRENT status and only
  // its immediate next status; the PHP endpoint independently enforces
  // this same status progression.
  selectedStatus: AssistanceStatus = 'pending';
  statusOptions: AssistanceStatus[] = [];
  assessmentNote = '';
  readonly maxAssessmentNoteLength = 2000;
  saving = false;
  updateErrorMessage = '';
  updateSuccessMessage = '';

  constructor() {
    addIcons({
      arrowBackOutline,
      refreshOutline,
      pawOutline,
      heartOutline,
      alertCircleOutline,
      locationOutline,
      calendarOutline,
      personOutline,
      documentTextOutline,
      imageOutline,
      timeOutline,
      checkmarkCircleOutline,
      saveOutline
    });
  }

  // Ionic may cache this component; refresh when staff return.
  ionViewWillEnter(): void {
    this.loadCase();
  }

  loadCase(): void {
    // Do not replace form data while an update is being submitted.
    if (this.saving) {
      return;
    }

    const idParam = this.route.snapshot.paramMap.get('id');
    const parsedId = idParam && /^\d+$/.test(idParam)
      ? Number(idParam)
      : NaN;

    // Matches the INT UNSIGNED case ID validation in PHP.
    if (!Number.isSafeInteger(parsedId) || parsedId < 1 || parsedId > 4294967295) {
      this.caseSubscription?.unsubscribe();
      this.requestVersion++;
      this.errorMessage = 'Invalid assistance case ID.';
      this.caseId = null;
      this.assistanceCase = null;
      this.photoUrl = null;
      this.loading = false;
      this.statusOptions = [];
      return;
    }

    const token = this.authService.getToken();
    if (!token) {
      void this.router.navigateByUrl('/login', { replaceUrl: true });
      return;
    }

    this.caseSubscription?.unsubscribe();
    const currentVersion = ++this.requestVersion;

    // Clear an older case when navigating to a different case ID.
    if (this.caseId !== parsedId) {
      this.assistanceCase = null;
      this.photoUrl = null;
      this.statusOptions = [];
      this.assessmentNote = '';
    }

    this.caseId = parsedId;
    this.loading = true;
    this.errorMessage = '';
    this.updateErrorMessage = '';
    this.updateSuccessMessage = '';

    const params = new HttpParams()
      .set('case_id', String(parsedId))
      .set('limit', '1')
      .set('offset', '0');

    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });

    this.caseSubscription = this.http.get<GetCaseDetailsResponse>(
      this.casesEndpoint,
      { headers, params }
    ).subscribe({
      next: (response) => {
        if (currentVersion !== this.requestVersion ||
            this.authService.getToken() !== token) {
          return;
        }

        this.loading = false;

        if (!response?.success || !Array.isArray(response.cases)) {
          this.errorMessage = response?.message || 'Unable to load this case.';
          return;
        }

        const item = response.cases.find((entry) => entry.id === parsedId);
        if (!item) {
          this.assistanceCase = null;
          this.photoUrl = null;
          this.statusOptions = [];
          this.errorMessage = 'This assistance case was not found.';
          return;
        }

        this.assistanceCase = item;
        this.photoUrl = this.resolvePhotoUrl(item.photo_path);
        this.lastUpdated = new Date();
        this.resetEditor(item.status);
      },
      error: (error: HttpErrorResponse) => {
        if (currentVersion !== this.requestVersion) {
          return;
        }

        this.loading = false;
        this.assistanceCase = null;
        this.photoUrl = null;
        this.statusOptions = [];

        // Keep the staff-only route protected by staffGuard, but do not
        // hide the actual API rejection behind an automatic login redirect.
        // No case data is displayed when the request is rejected.
        if (error.status === 401) {
          this.errorMessage =
            'Case Details API returned 401 (Unauthorized). The staff session was rejected. Sign in again, then retry.';
          return;
        }

        if (error.status === 403) {
          this.errorMessage =
            'Case Details API returned 403 (Forbidden). Your staff account was denied access to this case.';
          return;
        }

        if (error.status === 404) {
          this.errorMessage = 'This assistance case was not found.';
        } else if (error.status === 0) {
          this.errorMessage =
            'Cannot connect to the server. Check your connection and try again.';
        } else {
          this.errorMessage =
            'Unable to retrieve the case details. Please try again.';
        }
      }
    });
  }

  refreshCase(): void {
    this.loadCase();
  }

  backToCases(): void {
    if (this.saving) {
      return;
    }
    void this.router.navigateByUrl('/staff-animal-assistance');
  }

  private resetEditor(status: AssistanceStatus): void {
    this.selectedStatus = status;
    this.assessmentNote = '';
    this.statusOptions = [status];
    const next = NEXT_STATUS[status];
    if (next) {
      this.statusOptions.push(next);
    }
  }

  /** True when this is an allowed change with any required note included. */
  canSaveCaseUpdate(): boolean {
    if (!this.assistanceCase || this.caseId === null ||
        this.loading || this.saving) {
      return false;
    }

    if (!this.statusOptions.includes(this.selectedStatus)) {
      return false;
    }

    const note = this.assessmentNote.trim();
    if (note.length > this.maxAssessmentNoteLength) {
      return false;
    }

    const changedStatus = this.selectedStatus !== this.assistanceCase.status;
    if (!changedStatus && note.length === 0) {
      return false;
    }

    // Required by the PHP endpoint when moving to Resolved.
    if (changedStatus && this.selectedStatus === 'resolved' && !note) {
      return false;
    }

    return true;
  }

  saveCaseUpdate(): void {
    this.updateErrorMessage = '';
    this.updateSuccessMessage = '';

    const item = this.assistanceCase;
    const token = this.authService.getToken();

    if (!token) {
      void this.router.navigateByUrl('/login', { replaceUrl: true });
      return;
    }

    if (!item || this.caseId === null || this.loading || this.saving) {
      return;
    }

    const note = this.assessmentNote.trim();
    const changedStatus = this.selectedStatus !== item.status;

    if (!this.statusOptions.includes(this.selectedStatus)) {
      this.updateErrorMessage = 'Please select a valid next case status.';
      return;
    }
    if (note.length > this.maxAssessmentNoteLength) {
      this.updateErrorMessage = 'Assessment notes must be 2000 characters or fewer.';
      return;
    }
    if (!changedStatus && !note) {
      this.updateErrorMessage = 'Enter an assessment note or select the next status.';
      return;
    }
    if (changedStatus && this.selectedStatus === 'resolved' && !note) {
      this.updateErrorMessage = 'Add a resolution note before marking this case as Resolved.';
      return;
    }

    this.saving = true;
    const requestedCaseId = this.caseId;
    const requestedVersion = this.requestVersion;
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });

    this.updateSubscription = this.http.post<UpdateCaseResponse>(
      this.updateEndpoint,
      {
        case_id: requestedCaseId,
        status: this.selectedStatus,
        staff_note: note
      },
      { headers }
    ).subscribe({
      next: (response) => {
        this.saving = false;
        if (requestedVersion !== this.requestVersion ||
            this.caseId !== requestedCaseId ||
            this.authService.getToken() !== token) {
          return;
        }

        const result = response?.case;
        if (!response?.success || !result || result.id !== requestedCaseId) {
          this.updateErrorMessage = 'The server did not confirm this update. Refresh and try again.';
          return;
        }

        // The response is committed server state, not an optimistic update.
        this.assistanceCase = {
          ...item,
          status: result.status,
          staff_notes: result.staff_notes,
          reviewed_at: result.reviewed_at,
          resolved_at: result.resolved_at,
          updated_at: result.updated_at
        };
        this.lastUpdated = new Date();
        this.resetEditor(result.status);
        this.updateSuccessMessage = response.message || 'Case updated successfully.';
      },
      error: (error: HttpErrorResponse) => {
        this.saving = false;
        if (requestedVersion !== this.requestVersion ||
            this.authService.getToken() !== token) {
          return;
        }

        // Do not throw away staff's unsaved notes or mask an API permission
        // problem by immediately navigating away to Login.
        if (error.status === 401) {
          this.updateErrorMessage =
            'Save failed: 401 (Unauthorized). Your staff session was rejected. Sign in again before retrying.';
          return;
        }

        if (error.status === 403) {
          this.updateErrorMessage =
            'Save failed: 403 (Forbidden). This staff account is not permitted to update the case.';
          return;
        }

        // Preserve unsaved notes so staff can retry or refresh intentionally.
        const serverMessage = error.error?.message;
        if (error.status === 409) {
          this.updateErrorMessage = typeof serverMessage === 'string'
            ? `${serverMessage} Refresh this case before trying again.`
            : 'The case may have changed. Refresh it and try again.';
        } else if (error.status === 400 && typeof serverMessage === 'string') {
          this.updateErrorMessage = serverMessage;
        } else if (error.status === 0) {
          this.updateErrorMessage =
            'Cannot connect to the server. Your note was not confirmed as saved. Please check your connection.';
        } else {
          this.updateErrorMessage =
            'Unable to save the case update. Please try again.';
        }
      }
    });
  }

  getAnimalName(item: StaffAssistanceCase): string {
    const petName = item.pet_name?.trim();
    if (petName) {
      return petName;
    }
    return item.animal_type?.toLowerCase() === 'cat'
      ? 'Found Cat'
      : 'Found Dog';
  }

  getAnimalType(item: StaffAssistanceCase): string {
    return item.animal_type?.toLowerCase() === 'cat' ? 'Cat' : 'Dog';
  }

  getStatusLabel(status: AssistanceStatus): string {
    const labels: Record<AssistanceStatus, string> = {
      pending: 'Pending',
      under_review: 'Under Review',
      in_progress: 'In Progress',
      resolved: 'Resolved'
    };
    return labels[status] || 'Unknown';
  }

  getReasonLabel(reason: string): string {
    const labels: Record<string, string> = {
      injured: 'Injured',
      sick: 'Sick',
      trapped: 'Trapped',
      aggressive: 'Safety Concern',
      abandoned: 'Possibly Abandoned',
      roaming: 'Roaming / Unattended',
      other: 'Other Concern'
    };
    return labels[reason] || 'Animal Assistance';
  }

  hasCoordinates(item: StaffAssistanceCase): boolean {
    return item.latitude !== null && item.longitude !== null &&
      Number.isFinite(item.latitude) && Number.isFinite(item.longitude);
  }

  /**
   * Map known pet upload filenames to the configured PHP API.
   * Reject arbitrary server-provided image URLs.
   * Older PawRescue upload paths remain supported by filename.
   */
  private resolvePhotoUrl(photoPath: string | null): string | null {
    if (!photoPath || typeof photoPath !== 'string') {
      return null;
    }

    const normalized = photoPath.trim().replace(/\\/g, '/');
    const match = normalized.match(
      /(?:^|\/)uploads\/pets\/([a-f0-9]{32}\.(?:jpg|jpeg|png|webp))$/i
    );

    if (!match) {
      return null;
    }

    return `${this.apiBaseUrl}/uploads/pets/${match[1]}`;
  }

  ngOnDestroy(): void {
    this.requestVersion++;
    this.caseSubscription?.unsubscribe();
    this.updateSubscription?.unsubscribe();
  }
}
