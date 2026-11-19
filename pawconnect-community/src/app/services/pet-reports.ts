import { Injectable, inject } from '@angular/core';

import {

  HttpClient,

  HttpHeaders,
  HttpParams
} from '@angular/common/http';

import { Observable, from } from 'rxjs';

import { concatMap, toArray } from 'rxjs/operators';

import { getApiBaseUrl, getServerBaseUrl } from '../config/ip-config';

export interface PetReportPhoto {

  id: number;

  photo_path: string;

  sort_order: number;

  created_at: string;

}

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

export interface PetReportsResponse {

  success: boolean;

  message: string;

  count: number;

  reports: PetReport[];

}

export type FoundPetAssistanceReason =
  | 'injured'
  | 'sick'
  | 'trapped'
  | 'aggressive'
  | 'abandoned'
  | 'roaming'
  | 'other';

export interface CreatePetReportRequest {

  report_type: 'lost' | 'found';

  animal_type: 'dog' | 'cat';

  pet_name: string | null;

  description: string;

  incident_date: string;

  location_address: string;

  latitude: number | null;

  longitude: number | null;

  needs_assistance?: boolean;
  assistance_reason?: FoundPetAssistanceReason | null;
  assistance_details?: string | null;

}

export interface CreatePetReportResponse {

  success: boolean;

  message: string;

  report_id: number;

}

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

export interface UpdatePetReportResponse {

  success: boolean;

  message: string;

  report_id: number;

}

export interface UploadPhotoResponse {

  success: boolean;

  message: string;

  report_id: number;

  photo_id: number;

  photo_path: string;

  photo_count: number;

  max_photos: number;

}

export interface DeletePhotoResponse {

  success: boolean;

  message: string;

  report_id: number;

  deleted_photo_id: number;

  photo_count: number;

  primary_photo_path: string | null;

}

export interface DeletePetReportResponse {
  success: boolean;
  message: string;
  report_id?: number;
}

export interface ResolveReportResponse {

  success: boolean;

  message: string;

  report_id: number;

  status: 'resolved';

}

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
  date: string | null;
  time: string | null;
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
  proof_description: string;
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
  date: string | null;
  time: string | null;
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
  limit?: number;
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
  finding_description: string;
  found_location: string;
  found_latitude?: number | null;
  found_longitude?: number | null;
  found_at?: string | null;
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

  private readonly apiBaseUrl = getServerBaseUrl();
  private readonly backendApiUrl = getApiBaseUrl();

  private readonly apiUrl = `${this.backendApiUrl}/reports`;

  private readonly ownershipClaimsUrl = `${this.backendApiUrl}/ownership_claims`;
  private readonly lostPetRecoveriesUrl = `${this.backendApiUrl}/lost_pet_recoveries`;

  private getHeaders(): HttpHeaders {

    const token =

      sessionStorage.getItem('pawrescue_token');

    return new HttpHeaders({

      Authorization: `Bearer ${token || ''}`

    });

  }

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

  uploadPhotos(

    reportId: number,

    files: File[]

  ): Observable<UploadPhotoResponse[]> {

    return from(files).pipe(

      concatMap(file => this.uploadPhoto(reportId, file)),

      toArray()

    );

  }

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

  // Requires a matching authenticated PHP endpoint with ownership and
  // linked-claim/recovery validation before deletion is permitted.
  deleteReport(reportId: number): Observable<DeletePetReportResponse> {
    return this.http.post<DeletePetReportResponse>(
      `${this.apiUrl}/delete_report.php`,
      { report_id: reportId },
      { headers: this.getHeaders() }
    );
  }

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

  getPhotoUrl(photoPath: string | null): string | null {
    if (!photoPath) {
      return null;
    }

    const validPath = /^\/(?:(?:pawrescue\/pawrescue_api)|pawrescue_api|(?:pawconnect\/pawconnect_api)|pawconnect_api)\/uploads\/pets\/[a-f0-9]{32}\.(jpg|png|webp)$/;

    if (!validPath.test(photoPath)) {
      return null;
    }

    const filename = photoPath.substring(photoPath.lastIndexOf('/') + 1);
    return `${this.apiBaseUrl}/pawconnect/pawconnect_api/uploads/pets/${filename}`;
  }

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

  getFoundPetClaimAvailability(): Observable<FoundPetClaimAvailabilityResponse> {
    return this.http.get<FoundPetClaimAvailabilityResponse>(
      `${this.ownershipClaimsUrl}/get_report_availability.php`,
      { headers: this.getHeaders() }
    );
  }

  submitOwnershipClaim(
    data: SubmitOwnershipClaimRequest
  ): Observable<SubmitOwnershipClaimResponse> {
    return this.http.post<SubmitOwnershipClaimResponse>(
      `${this.ownershipClaimsUrl}/submit_claim.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

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

  uploadOwnershipClaimPhotos(
    claimId: number,
    files: File[]
  ): Observable<OwnershipEvidenceUploadResponse[]> {
    return from(files).pipe(
      concatMap(file => this.uploadOwnershipClaimPhoto(claimId, file)),
      toArray()
    );
  }

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

  respondOwnershipClaim(
    data: OwnershipClaimDecisionRequest
  ): Observable<OwnershipClaimDecisionResponse> {
    return this.http.post<OwnershipClaimDecisionResponse>(
      `${this.ownershipClaimsUrl}/respond_claim.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

  confirmOwnershipPickup(
    claimId: number
  ): Observable<OwnershipPickupConfirmationResponse> {
    return this.http.post<OwnershipPickupConfirmationResponse>(
      `${this.ownershipClaimsUrl}/confirm_pickup.php`,
      { claim_id: claimId },
      { headers: this.getHeaders() }
    );
  }

  requestOwnershipPickupReschedule(
    data: RequestOwnershipRescheduleRequest
  ): Observable<RequestOwnershipRescheduleResponse> {
    return this.http.post<RequestOwnershipRescheduleResponse>(
      `${this.ownershipClaimsUrl}/request_reschedule.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

  respondOwnershipPickupReschedule(
    data: RespondOwnershipRescheduleRequest
  ): Observable<RespondOwnershipRescheduleResponse> {
    return this.http.post<RespondOwnershipRescheduleResponse>(
      `${this.ownershipClaimsUrl}/respond_reschedule.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

  confirmOwnershipHandover(
    claimId: number
  ): Observable<OwnershipHandoverResponse> {
    return this.http.post<OwnershipHandoverResponse>(
      `${this.ownershipClaimsUrl}/confirm_handover.php`,
      { claim_id: claimId, confirm_handover: true },
      { headers: this.getHeaders() }
    );
  }

  submitLostPetRecovery(
    data: SubmitLostPetRecoveryRequest
  ): Observable<SubmitLostPetRecoveryResponse> {
    return this.http.post<SubmitLostPetRecoveryResponse>(
      `${this.lostPetRecoveriesUrl}/submit_recovery.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

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

  uploadLostPetRecoveryPhotos(
    recoveryId: number,
    files: File[]
  ): Observable<LostPetRecoveryEvidenceUploadResponse[]> {
    return from(files).pipe(
      concatMap(file => this.uploadLostPetRecoveryPhoto(recoveryId, file)),
      toArray()
    );
  }

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

  respondLostPetRecovery(
    data: LostPetRecoveryDecisionRequest
  ): Observable<LostPetRecoveryDecisionResponse> {
    return this.http.post<LostPetRecoveryDecisionResponse>(
      `${this.lostPetRecoveriesUrl}/respond_recovery.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

  confirmLostPetRecoveryPickup(
    recoveryId: number
  ): Observable<LostPetRecoveryPickupConfirmationResponse> {
    return this.http.post<LostPetRecoveryPickupConfirmationResponse>(
      `${this.lostPetRecoveriesUrl}/confirm_recovery_pickup.php`,
      { recovery_id: recoveryId },
      { headers: this.getHeaders() }
    );
  }

  requestLostPetRecoveryReschedule(
    data: RequestLostPetRecoveryRescheduleRequest
  ): Observable<RequestLostPetRecoveryRescheduleResponse> {
    return this.http.post<RequestLostPetRecoveryRescheduleResponse>(
      `${this.lostPetRecoveriesUrl}/request_recovery_reschedule.php`,
      { ...data, action: 'request' },
      { headers: this.getHeaders() }
    );
  }

  respondLostPetRecoveryReschedule(
    data: RespondLostPetRecoveryRescheduleRequest
  ): Observable<RespondLostPetRecoveryRescheduleResponse> {
    return this.http.post<RespondLostPetRecoveryRescheduleResponse>(
      `${this.lostPetRecoveriesUrl}/request_recovery_reschedule.php`,
      data,
      { headers: this.getHeaders() }
    );
  }

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
