import { Injectable, inject } from '@angular/core';

import {

  HttpClient,

  HttpHeaders,
  HttpParams
} from '@angular/common/http';

import { Observable, from } from 'rxjs';

import { concatMap, toArray } from 'rxjs/operators';

import { getApiBaseUrl, getServerBaseUrl } from '../config/ip-config';

// =====================================
// PET REPORT PHOTO INFORMATION
// =====================================
export interface PetReportPhoto {

  id: number;

  photo_path: string;

  sort_order: number;

  created_at: string;

}

// =====================================
// PET REPORT INFORMATION
// =====================================
export interface PetReport {

  id: number;

  report_type: 'lost' | 'found';

  animal_type: 'dog' | 'cat';

  pet_name: string | null;

  description: string;

  photo_path: string | null;

  photos: PetReportPhoto[];

  photo_count: number;

  incident_date: string;

  location_address: string;

  latitude: string | null;

  longitude: string | null;

  status: string;

  created_at: string;

  reporter_name: string;

}

// =====================================
// RESPONSE WHEN RETRIEVING REPORTS
// =====================================
export interface PetReportsResponse {

  success: boolean;

  message: string;

  count: number;

  reports: PetReport[];

}

// =====================================
// ANIMAL ASSISTANCE REFERRAL REASONS
// =====================================
// Used only when the resident reports a FOUND pet and requests assistance.
export type FoundPetAssistanceReason =
  | 'injured'
  | 'sick'
  | 'trapped'
  | 'aggressive'
  | 'abandoned'
  | 'roaming'
  | 'other';

// =====================================
// DATA FOR CREATING A PET REPORT
// =====================================
export interface CreatePetReportRequest {

  report_type: 'lost' | 'found';

  animal_type: 'dog' | 'cat';

  pet_name: string | null;

  description: string;

  incident_date: string;

  location_address: string;

  latitude: number | null;

  longitude: number | null;

  // Optional: sent only for a Found Pet marked as needing assistance.
  // The API must validate these fields and create one linked case atomically.
  needs_assistance?: boolean;
  assistance_reason?: FoundPetAssistanceReason | null;
  assistance_details?: string | null;

}

// =====================================
// RESPONSE AFTER CREATING A REPORT
// =====================================
export interface CreatePetReportResponse {

  success: boolean;

  message: string;

  report_id: number;

}

// =====================================
// DATA FOR UPDATING A PET REPORT
// =====================================
export interface UpdatePetReportRequest {

  report_id: number;

  report_type: 'lost' | 'found';

  animal_type: 'dog' | 'cat';

  pet_name: string | null;

  description: string;

  incident_date: string;

  location_address: string;

  latitude: number | null;

  longitude: number | null;

}

// =====================================
// RESPONSE AFTER UPDATING A REPORT
// =====================================
export interface UpdatePetReportResponse {

  success: boolean;

  message: string;

  report_id: number;

}

// =====================================
// RESPONSE AFTER UPLOADING PHOTO
// =====================================
export interface UploadPhotoResponse {

  success: boolean;

  message: string;

  report_id: number;

  photo_id: number;

  photo_path: string;

  photo_count: number;

  max_photos: number;

}

// =====================================
// RESPONSE AFTER DELETING A REPORT PHOTO
// =====================================
export interface DeletePhotoResponse {

  success: boolean;

  message: string;

  report_id: number;

  deleted_photo_id: number;

  photo_count: number;

  primary_photo_path: string | null;

}

// =====================================
// RESPONSE AFTER RESOLVING REPORT
// =====================================
export interface ResolveReportResponse {

  success: boolean;

  message: string;

  report_id: number;

  status: 'resolved';

}

// =====================================
// FOUND PET AVAILABILITY (PUBLIC FEED UI HINT)
// =====================================
// The backend lists only active Found Pet reports which are no
// longer accepting new claims. An unlisted ID is not guaranteed
// available: submit_claim.php performs the final security check.
export type FoundPetClaimAvailabilityStatus =
  | 'reserved'
  | 'under_dispute'
  | 'returned';

export interface FoundPetClaimAvailability {
  report_id: number;
  availability: FoundPetClaimAvailabilityStatus;
  can_claim: false;
}

export interface FoundPetClaimAvailabilityResponse {
  success: boolean;
  message: string;
  count: number;
  report_availability: FoundPetClaimAvailability[];
}

// =====================================
// FOUND PET OWNERSHIP CLAIMS - TYPES
// =====================================
// Ownership claim evidence is private. Do not add its photo IDs
// or pickup locations to public PetReport/community feed objects.
export type OwnershipClaimStatus =
  | 'pending'
  | 'rejected'
  | 'approved'
  | 'pickup_scheduled'
  | 'reschedule_requested'
  | 'completed'
  | 'cancelled'
  | 'disputed';

export interface OwnershipClaimEvidencePhoto {
  id: number;
  sort_order: number;
  created_at: string;
}

export interface OwnershipPickupDetails {
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  date: string | null;       // YYYY-MM-DD (Asia/Manila)
  time: string | null;       // HH:mm:ss
  timezone: string;
  claimant_confirmed_at?: string | null;
}

export type OwnershipRescheduleStatus =
  'pending' | 'accepted' | 'rejected' | 'cancelled';

export interface OwnershipClaimReschedule {
  id: number;
  requested_by_user_id: number;
  previous_location: string | null;
  previous_latitude: number | null;
  previous_longitude: number | null;
  previous_date: string | null;
  previous_time: string | null;
  proposed_location: string;
  proposed_latitude: number | null;
  proposed_longitude: number | null;
  proposed_date: string;
  proposed_time: string;
  reason: string | null;
  status: OwnershipRescheduleStatus;
  response_note: string | null;
  responded_at: string | null;
  created_at: string;
}

export interface OwnershipClaim {
  id: number;
  found_report_id: number;
  found_report_status: string;
  pet_name: string | null;
  animal_type: 'dog' | 'cat';
  finder_user_id: number;
  finder_name: string;
  claimant_user_id: number;
  claimant_name: string;
  linked_lost_report_id: number | null;
  proof_description: string;
  status: OwnershipClaimStatus;
  rejection_reason: string | null;
  cancellation_reason: string | null;
  dispute_reason: string | null;
  pickup: OwnershipPickupDetails;
  approved_at: string | null;
  finder_handover_confirmed_at: string | null;
  claimant_handover_confirmed_at: string | null;
  completed_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
  disputed_at: string | null;
  created_at: string;
  updated_at: string;
  evidence_photos: OwnershipClaimEvidencePhoto[];
  latest_reschedule: OwnershipClaimReschedule | null;
}

export interface GetOwnershipClaimsOptions {
  claimId?: number;
  foundReportId?: number;
  limit?: number;
  offset?: number;
}

export interface OwnershipClaimsResponse {
  success: boolean;
  message: string;
  scope: 'sent' | 'received';
  total: number;
  count: number;
  limit: number;
  offset: number;
  has_more: boolean;
  claims: OwnershipClaim[];
}

export interface SubmitOwnershipClaimRequest {
  found_report_id: number;
  proof_description: string; // 10-3000 chars, checked server-side
  linked_lost_report_id?: number | null;
}

export interface SubmitOwnershipClaimResponse {
  success: boolean;
  message: string;
  claim_id: number;
  found_report_id: number;
  status: OwnershipClaimStatus;
}

export interface OwnershipEvidenceUploadResponse {
  success: boolean;
  message: string;
  claim_id: number;
  photo_id: number;
  photo_count: number;
  max_photos: number;
}

export interface OwnershipClaimDecisionRequest {
  claim_id: number;
  action: 'approve' | 'reject';
  // Required for approval; omitted when rejecting.
  pickup_location?: string;
  pickup_date?: string;
  pickup_time?: string;
  pickup_latitude?: number | null;
  pickup_longitude?: number | null;
  rejection_reason?: string | null;
}

export interface OwnershipClaimDecisionResponse {
  success: boolean;
  message: string;
  claim_id: number;
  found_report_id: number;
  action: 'approve' | 'reject';
  status: OwnershipClaimStatus;
  pickup?: OwnershipPickupDetails;
  rejection_reason?: string | null;
}

export interface OwnershipPickupConfirmationResponse {
  success: boolean;
  message: string;
  claim_id: number;
  found_report_id: number;
  status: OwnershipClaimStatus;
  already_confirmed: boolean;
  pickup: OwnershipPickupDetails;
}

export interface RequestOwnershipRescheduleRequest {
  claim_id: number;
  // All pickup fields optional: omitted values retain current schedule.
  pickup_location?: string;
  pickup_date?: string;
  pickup_time?: string;
  pickup_latitude?: number | null;
  pickup_longitude?: number | null;
  reason?: string | null;
}

export interface RequestOwnershipRescheduleResponse {
  success: boolean;
  message: string;
  claim_id: number;
  found_report_id: number;
  reschedule_id: number;
  requested_by_user_id: number;
  awaiting_user_id: number;
  status: 'reschedule_requested';
  reschedule_status: 'pending';
  proposed_pickup: OwnershipPickupDetails;
}

export interface RespondOwnershipRescheduleRequest {
  claim_id: number;
  reschedule_id: number;
  action: 'accept' | 'reject';
  response_note?: string | null;
}

export interface RespondOwnershipRescheduleResponse {
  success: boolean;
  message: string;
  claim_id: number;
  reschedule_id: number;
  found_report_id: number;
  status: 'pickup_scheduled';
  reschedule_status: 'accepted' | 'rejected';
  pickup_confirmation_required: boolean;
  pickup: OwnershipPickupDetails;
}

export interface OwnershipHandoverResponse {
  success: boolean;
  message: string;
  claim_id: number;
  found_report_id: number;
  status: 'pickup_scheduled' | 'completed';
  found_report_status: string;
  your_role: 'finder' | 'claimant';
  already_confirmed: boolean;
  finder_handover_confirmed_at: string | null;
  claimant_handover_confirmed_at: string | null;
  completed_at: string | null;
}

// =====================================
// LOST PET RECOVERY - PRIVATE TYPES
// =====================================
// Used when a resident finds another resident's missing pet.
// Finding coordinates, evidence and pickup details must remain
// private to the owner and finder (not the public Lost & Found feed).
export type LostPetRecoveryStatus =
  | 'pending'
  | 'rejected'
  | 'approved'
  | 'pickup_scheduled'
  | 'reschedule_requested'
  | 'completed'
  | 'cancelled'
  | 'disputed';

export interface LostPetRecoveryEvidencePhoto {
  id: number;
  sort_order: number;
  created_at: string;
}

export interface LostPetRecoveryPickup {
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  date: string | null; // YYYY-MM-DD, Asia/Manila
  time: string | null; // HH:MM:SS
  timezone: string;
  finder_confirmed_at?: string | null;
}

export type LostPetRecoveryRescheduleStatus =
  'pending' | 'accepted' | 'rejected' | 'cancelled';

export interface LostPetRecoveryReschedule {
  id: number;
  requested_by_user_id: number;
  previous_location: string | null;
  previous_latitude: number | null;
  previous_longitude: number | null;
  previous_date: string | null;
  previous_time: string | null;
  proposed_location: string;
  proposed_latitude: number | null;
  proposed_longitude: number | null;
  proposed_date: string;
  proposed_time: string;
  reason: string | null;
  status: LostPetRecoveryRescheduleStatus;
  response_note: string | null;
  responded_at: string | null;
  created_at: string;
}

export interface LostPetRecovery {
  id: number;
  lost_report_id: number;
  lost_report_status: string;
  pet_name: string | null;
  animal_type: 'dog' | 'cat';
  owner_user_id: number;
  owner_name: string;
  finder_user_id: number;
  finder_name: string;
  linked_found_report_id: number | null;
  finding_description: string;
  found_location: string;
  found_latitude: number | null;
  found_longitude: number | null;
  found_at: string | null;
  status: LostPetRecoveryStatus;
  rejection_reason: string | null;
  cancellation_reason: string | null;
  dispute_reason: string | null;
  pickup: LostPetRecoveryPickup;
  approved_at: string | null;
  owner_handover_confirmed_at: string | null;
  finder_handover_confirmed_at: string | null;
  completed_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
  disputed_at: string | null;
  created_at: string;
  updated_at: string;
  evidence_photos: LostPetRecoveryEvidencePhoto[];
  latest_reschedule: LostPetRecoveryReschedule | null;
}

export interface GetLostPetRecoveriesOptions {
  recoveryId?: number;
  lostReportId?: number;
  limit?: number; // Backend accepts 1..50
  offset?: number;
}

export interface LostPetRecoveriesResponse {
  success: boolean;
  message: string;
  scope: 'sent' | 'received';
  total: number;
  count: number;
  limit: number;
  offset: number;
  has_more: boolean;
  recoveries: LostPetRecovery[];
}

export interface SubmitLostPetRecoveryRequest {
  lost_report_id: number;
  finding_description: string; // Backend validates 10..3000 characters
  found_location: string;
  found_latitude?: number | null;
  found_longitude?: number | null;
  found_at?: string | null; // YYYY-MM-DD HH:MM, Asia/Manila
  linked_found_report_id?: number | null;
}

export interface SubmitLostPetRecoveryResponse {
  success: boolean;
  message: string;
  recovery_id: number;
  lost_report_id: number;
  status: 'pending';
  next_step?: string;
}

export interface LostPetRecoveryEvidenceUploadResponse {
  success: boolean;
  message: string;
  recovery_id: number;
  photo_id: number;
  photo_count: number;
  max_photos: number;
}

export interface LostPetRecoveryDecisionRequest {
  recovery_id: number;
  action: 'approve' | 'reject';
  // Supply location, date and time for approval; omit on rejection.
  pickup_location?: string;
  pickup_date?: string;
  pickup_time?: string;
  pickup_latitude?: number | null;
  pickup_longitude?: number | null;
  rejection_reason?: string | null;
}

export interface LostPetRecoveryDecisionResponse {
  success: boolean;
  message: string;
  recovery_id: number;
  lost_report_id: number;
  action: 'approve' | 'reject';
  status: 'pickup_scheduled' | 'rejected';
  other_pending_recoveries_closed?: number;
  pickup?: LostPetRecoveryPickup;
  rejection_reason?: string | null;
}

export interface LostPetRecoveryPickupConfirmationResponse {
  success: boolean;
  message: string;
  recovery_id: number;
  lost_report_id: number;
  status: 'pickup_scheduled';
  already_confirmed: boolean;
  pickup: LostPetRecoveryPickup;
}

export interface RequestLostPetRecoveryRescheduleRequest {
  recovery_id: number;
  // Omit fields that should retain the existing pickup values.
  pickup_location?: string;
  pickup_date?: string;
  pickup_time?: string;
  pickup_latitude?: number | null;
  pickup_longitude?: number | null;
  reason?: string | null;
}

export interface RequestLostPetRecoveryRescheduleResponse {
  success: boolean;
  message: string;
  action: 'request';
  recovery_id: number;
  lost_report_id: number;
  reschedule_id: number;
  requested_by_user_id: number;
  awaiting_user_id: number;
  status: 'reschedule_requested';
  reschedule_status: 'pending';
  current_pickup: LostPetRecoveryPickup;
  proposed_pickup: LostPetRecoveryPickup;
}

export interface RespondLostPetRecoveryRescheduleRequest {
  recovery_id: number;
  reschedule_id: number;
  action: 'accept' | 'reject';
  response_note?: string | null;
}

export interface RespondLostPetRecoveryRescheduleResponse {
  success: boolean;
  message: string;
  action: 'accept' | 'reject';
  recovery_id: number;
  lost_report_id: number;
  reschedule_id: number;
  status: 'pickup_scheduled';
  reschedule_status: 'accepted' | 'rejected';
  pickup_confirmation_required: boolean;
  pickup: LostPetRecoveryPickup;
}

export interface LostPetRecoveryHandoverResponse {
  success: boolean;
  message: string;
  action: 'confirm_handover';
  recovery_id: number;
  lost_report_id: number;
  status: 'pickup_scheduled' | 'completed';
  lost_report_status: string;
  your_role: 'owner' | 'finder';
  already_confirmed: boolean;
  owner_handover_confirmed_at: string | null;
  finder_handover_confirmed_at: string | null;
  completed_at: string | null;
}

@Injectable({

  providedIn: 'root'

})

export class PetReportsService {

  private http = inject(HttpClient);

  // All backend hosts and paths are defined centrally in ip-config.ts.
  private readonly apiBaseUrl = getServerBaseUrl();
  private readonly backendApiUrl = getApiBaseUrl();

  private readonly apiUrl = `${this.backendApiUrl}/reports`;

  // Private Found Pet ownership claims and Lost Pet recoveries.
  private readonly ownershipClaimsUrl = `${this.backendApiUrl}/ownership_claims`;
  private readonly lostPetRecoveriesUrl = `${this.backendApiUrl}/lost_pet_recoveries`;

  // =====================================
  // AUTHENTICATION HEADERS
  // =====================================
  private getHeaders(): HttpHeaders {

    const token =

      sessionStorage.getItem('pawrescue_token');

    return new HttpHeaders({

      Authorization: `Bearer ${token || ''}`

    });

  }

  // =====================================
  // GET COMMUNITY LOST AND FOUND REPORTS
  // =====================================
  getReports(

    type: 'all' | 'lost' | 'found' = 'all'

  ): Observable<PetReportsResponse> {

    return this.http.get<PetReportsResponse>(

      `${this.apiUrl}/get_reports.php`,

      {

        headers: this.getHeaders(),

        params: { type }

      }

    );

  }

  // =====================================
  // GET LOGGED-IN RESIDENT'S REPORTS
  // =====================================
  getMyReports(

    type: 'all' | 'lost' | 'found' = 'all'

  ): Observable<PetReportsResponse> {

    return this.http.get<PetReportsResponse>(

      `${this.apiUrl}/get_my_reports.php`,

      {

        headers: this.getHeaders(),

        params: { type }

      }

    );

  }

  // =====================================
  // CREATE LOST OR FOUND PET REPORT
  // =====================================
  createReport(

    data: CreatePetReportRequest

  ): Observable<CreatePetReportResponse> {

    return this.http.post<CreatePetReportResponse>(

      `${this.apiUrl}/create_report.php`,

      data,

      {

        headers: this.getHeaders()

      }

    );

  }

  // =====================================
  // UPDATE LOST OR FOUND PET REPORT
  // =====================================
  updateReport(

    data: UpdatePetReportRequest

  ): Observable<UpdatePetReportResponse> {

    return this.http.post<UpdatePetReportResponse>(

      `${this.apiUrl}/update_report.php`,

      data,

      {

        headers: this.getHeaders()

      }

    );

  }

  // =====================================
  // UPLOAD ONE PET PHOTO
  // =====================================
  uploadPhoto(

    reportId: number,

    file: File

  ): Observable<UploadPhotoResponse> {

    const formData = new FormData();

    formData.append(

      'report_id',

      String(reportId)

    );

    formData.append(

      'photo',

      file,

      file.name

    );

    return this.http.post<UploadPhotoResponse>(

      `${this.apiUrl}/upload_photo.php`,

      formData,

      {

        headers: this.getHeaders()

      }

    );

  }

  // =====================================
  // UPLOAD MULTIPLE PET PHOTOS
  // =====================================
  uploadPhotos(

    reportId: number,

    files: File[]

  ): Observable<UploadPhotoResponse[]> {

    // Upload photos one at a time to preserve
    // their order and respect the backend limit.
    // The API allows up to 10 photos per report.
    return from(files).pipe(

      concatMap(file => this.uploadPhoto(reportId, file)),

      toArray()

    );

  }

  // =====================================
  // DELETE ONE OWNED REPORT PHOTO
  // =====================================
  deletePhoto(

    reportId: number,

    photoId: number

  ): Observable<DeletePhotoResponse> {

    return this.http.post<DeletePhotoResponse>(

      `${this.apiUrl}/delete_photo.php`,

      {

        report_id: reportId,

        photo_id: photoId

      },

      {

        headers: this.getHeaders()

      }

    );

  }

  // =====================================
  // MARK PET REPORT AS RESOLVED
  // =====================================
  resolveReport(

    reportId: number

  ): Observable<ResolveReportResponse> {

    return this.http.post<ResolveReportResponse>(

      `${this.apiUrl}/resolve_report.php`,

      {

        report_id: reportId

      },

      {

        headers: this.getHeaders()

      }

    );

  }

  // =====================================
  // GET UPLOADED PET PHOTO URL
  // =====================================
  getPhotoUrl(

    photoPath: string | null

  ): string | null {

    if (!photoPath) {

      return null;

    }

    // Allow only valid pet-upload paths.
    const validPath =

      /^\/(?:pawrescue\/)?pawrescue_api\/uploads\/pets\/[a-f0-9]{32}\.(jpg|png|webp)$/;

    if (!validPath.test(photoPath)) {

      return null;

    }

    // Convert legacy paths to the new backend folder.
    const normalizedPath = photoPath.startsWith(

      '/pawrescue_api/uploads/pets/'

    )

      ? `/pawrescue${photoPath}`

      : photoPath;

    return `${this.apiBaseUrl}${normalizedPath}`;

  }

  // =====================================
  // GET ALL VALID PHOTO URLS FOR A REPORT
  // =====================================
  getReportPhotoUrls(

    report: PetReport

  ): string[] {

    const photoPaths =

      Array.isArray(report.photos) && report.photos.length > 0

        ? report.photos.map(photo => photo.photo_path)

        : (report.photo_path ? [report.photo_path] : []);

    const urls: string[] = [];

    for (const path of photoPaths) {

      const url = this.getPhotoUrl(path);

      if (url && !urls.includes(url)) {

        urls.push(url);

      }

    }

    return urls;

  }

  // =====================================
  // CHECK BLOCKED / RESERVED FOUND PET REPORTS
  // =====================================
  // Read-only status hint for the community Lost & Found feed.
  // Response contains ONLY blocked Found Pet report IDs and
  // availability labels. No private claimant or pickup details.
  // A missing ID does NOT prove the pet remains claimable;
  // submit_claim.php always validates eligibility server-side.
  getFoundPetClaimAvailability(): Observable<FoundPetClaimAvailabilityResponse> {
    return this.http.get<FoundPetClaimAvailabilityResponse>(
      `${this.ownershipClaimsUrl}/get_report_availability.php`,
      { headers: this.getHeaders() }
    );
  }

  // =====================================
  // FOUND PET OWNERSHIP CLAIMS
  // =====================================

  // Resident B: submit proof for a Found Pet report posted by A.
  // Photos are uploaded separately once the claim ID is returned.
  submitOwnershipClaim(
    data: SubmitOwnershipClaimRequest
  ): Observable<SubmitOwnershipClaimResponse> {
    return this.http.post<SubmitOwnershipClaimResponse>(
      `${this.ownershipClaimsUrl}/submit_claim.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

  // Load only claims the authenticated resident sent or received.
  // Filtering happens server-side; never retrieve private claims
  // through the public community reports endpoint.
  getOwnershipClaims(
    scope: 'sent' | 'received' = 'sent',
    options: GetOwnershipClaimsOptions = {}
  ): Observable<OwnershipClaimsResponse> {
    let params = new HttpParams().set('scope', scope);

    if (options.claimId !== undefined) {
      params = params.set('claim_id', String(options.claimId));
    }
    if (options.foundReportId !== undefined) {
      params = params.set('found_report_id', String(options.foundReportId));
    }
    if (options.limit !== undefined) {
      params = params.set('limit', String(options.limit));
    }
    if (options.offset !== undefined) {
      params = params.set('offset', String(options.offset));
    }

    return this.http.get<OwnershipClaimsResponse>(
      `${this.ownershipClaimsUrl}/get_claims.php`,
      { headers: this.getHeaders(), params }
    );
  }

  // Evidence uploads are private and limited by the backend to
  // 5 JPG/PNG/WebP images, max 5 MB each. Do not share their
  // storage paths in the public report feed.
  uploadOwnershipClaimPhoto(
    claimId: number,
    file: File
  ): Observable<OwnershipEvidenceUploadResponse> {
    const formData = new FormData();
    formData.append('claim_id', String(claimId));
    formData.append('photo', file, file.name);

    return this.http.post<OwnershipEvidenceUploadResponse>(
      `${this.ownershipClaimsUrl}/upload_claim_photo.php`,
      formData,
      { headers: this.getHeaders() }
    );
  }

  // Sequential uploads preserve order and make server photo-count
  // enforcement reliable. Photo upload failures propagate to caller.
  uploadOwnershipClaimPhotos(
    claimId: number,
    files: File[]
  ): Observable<OwnershipEvidenceUploadResponse[]> {
    return from(files).pipe(
      concatMap(file => this.uploadOwnershipClaimPhoto(claimId, file)),
      toArray()
    );
  }

  // Private evidence photos REQUIRE Authorization headers. An
  // <img src="..."> pointing directly at the PHP endpoint will
  // not carry the Bearer token. Consume the Blob in the page,
  // create an object URL, then revoke it when the view closes.
  getOwnershipClaimEvidencePhoto(photoId: number): Observable<Blob> {
    return this.http.get(
      `${this.ownershipClaimsUrl}/view_claim_photo.php`,
      {
        headers: this.getHeaders(),
        params: new HttpParams().set('photo_id', String(photoId)),
        responseType: 'blob'
      }
    );
  }

  // Resident A: approve (with private pickup details) or reject.
  respondOwnershipClaim(
    data: OwnershipClaimDecisionRequest
  ): Observable<OwnershipClaimDecisionResponse> {
    return this.http.post<OwnershipClaimDecisionResponse>(
      `${this.ownershipClaimsUrl}/respond_claim.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

  // Resident B: confirm the location, date and time arranged by A.
  confirmOwnershipPickup(
    claimId: number
  ): Observable<OwnershipPickupConfirmationResponse> {
    return this.http.post<OwnershipPickupConfirmationResponse>(
      `${this.ownershipClaimsUrl}/confirm_pickup.php`,
      { claim_id: claimId },
      { headers: this.getHeaders() }
    );
  }

  // Either participant may propose a different pickup arrangement.
  requestOwnershipPickupReschedule(
    data: RequestOwnershipRescheduleRequest
  ): Observable<RequestOwnershipRescheduleResponse> {
    return this.http.post<RequestOwnershipRescheduleResponse>(
      `${this.ownershipClaimsUrl}/request_reschedule.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

  // Only the OTHER participant may accept or reject a reschedule.
  respondOwnershipPickupReschedule(
    data: RespondOwnershipRescheduleRequest
  ): Observable<RespondOwnershipRescheduleResponse> {
    return this.http.post<RespondOwnershipRescheduleResponse>(
      `${this.ownershipClaimsUrl}/respond_reschedule.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

  // Both residents must independently confirm the actual handover.
  // Only the backend may complete the claim and resolve the report.
  confirmOwnershipHandover(
    claimId: number
  ): Observable<OwnershipHandoverResponse> {
    return this.http.post<OwnershipHandoverResponse>(
      `${this.ownershipClaimsUrl}/confirm_handover.php`,
      { claim_id: claimId, confirm_handover: true },
      { headers: this.getHeaders() }
    );
  }


  // =====================================
  // LOST PET RECOVERY (I FOUND THIS PET)
  // =====================================

  // Finder: submit finding details for an active Lost Pet report.
  // Photos are uploaded separately after receiving recovery_id.
  submitLostPetRecovery(
    data: SubmitLostPetRecoveryRequest
  ): Observable<SubmitLostPetRecoveryResponse> {
    return this.http.post<SubmitLostPetRecoveryResponse>(
      `${this.lostPetRecoveriesUrl}/submit_recovery.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

  // Only submissions sent or received by the logged-in resident.
  // Private finding/pickup details must never be placed in the
  // public getReports() response.
  getLostPetRecoveries(
    scope: 'sent' | 'received' = 'sent',
    options: GetLostPetRecoveriesOptions = {}
  ): Observable<LostPetRecoveriesResponse> {
    let params = new HttpParams().set('scope', scope);

    if (options.recoveryId !== undefined) {
      params = params.set('recovery_id', String(options.recoveryId));
    }
    if (options.lostReportId !== undefined) {
      params = params.set('lost_report_id', String(options.lostReportId));
    }
    if (options.limit !== undefined) {
      params = params.set('limit', String(options.limit));
    }
    if (options.offset !== undefined) {
      params = params.set('offset', String(options.offset));
    }

    return this.http.get<LostPetRecoveriesResponse>(
      `${this.lostPetRecoveriesUrl}/get_recoveries.php`,
      { headers: this.getHeaders(), params }
    );
  }

  // Private evidence: max 5 JPG/PNG/WebP photos, 5 MB each.
  // The API checks the logged-in finder and pending status.
  uploadLostPetRecoveryPhoto(
    recoveryId: number,
    file: File
  ): Observable<LostPetRecoveryEvidenceUploadResponse> {
    const formData = new FormData();
    formData.append('recovery_id', String(recoveryId));
    formData.append('photo', file, file.name);

    return this.http.post<LostPetRecoveryEvidenceUploadResponse>(
      `${this.lostPetRecoveriesUrl}/upload_recovery_photo.php`,
      formData,
      { headers: this.getHeaders() }
    );
  }

  // Sequential uploads preserve ordering and server-side limits.
  uploadLostPetRecoveryPhotos(
    recoveryId: number,
    files: File[]
  ): Observable<LostPetRecoveryEvidenceUploadResponse[]> {
    return from(files).pipe(
      concatMap(file => this.uploadLostPetRecoveryPhoto(recoveryId, file)),
      toArray()
    );
  }

  // Authenticated binary image response. Do NOT use PHP URL in
  // <img src> directly: the image element cannot attach Bearer
  // Authorization. Let the page turn this Blob into a display
  // URL or data URL, and release object URLs after use.
  getLostPetRecoveryEvidencePhoto(photoId: number): Observable<Blob> {
    return this.http.get(
      `${this.lostPetRecoveriesUrl}/view_recovery_photo.php`,
      {
        headers: this.getHeaders(),
        params: new HttpParams().set('photo_id', String(photoId)),
        responseType: 'blob'
      }
    );
  }

  // Lost Pet owner: accept a finder with a private pickup proposal
  // or reject a submission. Approval does NOT complete the recovery.
  respondLostPetRecovery(
    data: LostPetRecoveryDecisionRequest
  ): Observable<LostPetRecoveryDecisionResponse> {
    return this.http.post<LostPetRecoveryDecisionResponse>(
      `${this.lostPetRecoveriesUrl}/respond_recovery.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

  // Finder: confirm the pickup location, date and time set by owner.
  confirmLostPetRecoveryPickup(
    recoveryId: number
  ): Observable<LostPetRecoveryPickupConfirmationResponse> {
    return this.http.post<LostPetRecoveryPickupConfirmationResponse>(
      `${this.lostPetRecoveriesUrl}/confirm_recovery_pickup.php`,
      { recovery_id: recoveryId },
      { headers: this.getHeaders() }
    );
  }

  // Combined recovery management endpoint: REQUEST rescheduling.
  // Existing schedule is unchanged until the other participant agrees.
  requestLostPetRecoveryReschedule(
    data: RequestLostPetRecoveryRescheduleRequest
  ): Observable<RequestLostPetRecoveryRescheduleResponse> {
    return this.http.post<RequestLostPetRecoveryRescheduleResponse>(
      `${this.lostPetRecoveriesUrl}/request_recovery_reschedule.php`,
      { ...data, action: 'request' },
      { headers: this.getHeaders() }
    );
  }

  // Same combined endpoint: only the OTHER participant may ACCEPT
  // or REJECT the proposed schedule.
  respondLostPetRecoveryReschedule(
    data: RespondLostPetRecoveryRescheduleRequest
  ): Observable<RespondLostPetRecoveryRescheduleResponse> {
    return this.http.post<RespondLostPetRecoveryRescheduleResponse>(
      `${this.lostPetRecoveriesUrl}/request_recovery_reschedule.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

  // Same combined endpoint: each participant independently confirms
  // the ACTUAL handover. Only the backend can complete the recovery
  // and resolve the original Lost Pet report after BOTH confirm.
  confirmLostPetRecoveryHandover(
    recoveryId: number
  ): Observable<LostPetRecoveryHandoverResponse> {
    return this.http.post<LostPetRecoveryHandoverResponse>(
      `${this.lostPetRecoveriesUrl}/request_recovery_reschedule.php`,
      {
        recovery_id: recoveryId,
        action: 'confirm_handover',
        confirm_handover: true
      },
      { headers: this.getHeaders() }
    );
  }

}
