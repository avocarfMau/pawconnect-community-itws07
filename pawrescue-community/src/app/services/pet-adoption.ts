import { Injectable, inject } from '@angular/core';
import {
  HttpClient,
  HttpHeaders,
  HttpParams
} from '@angular/common/http';
import { Observable } from 'rxjs';
import { getApiBaseUrl, getServerBaseUrl } from '../config/ip-config';

// =====================================
// PAWRESCUE COMMUNITY - ADOPTION SERVICE
// =====================================

export type AdoptionAnimalType = 'dog' | 'cat';

export type AdoptionStatus =
  | 'available'
  | 'reserved'
  | 'adopted'
  | 'closed';

export type AdoptionRequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'completed';

// =====================================
// ADOPTION PHOTO
// =====================================

export interface AdoptionPhoto {
  id: number;
  adoption_id: number;
  photo_path: string;
  sort_order: number;
  created_at: string;
}

// =====================================
// ADOPTION POST
// =====================================

export interface AdoptionPost {
  id: number;
  user_id: number;
  pet_name: string;
  animal_type: AdoptionAnimalType;
  sex: 'male' | 'female' | 'unknown';
  age_months: number | null;
  breed: string | null;
  description: string;
  health_notes: string | null;
  barangay: string;
  location_details: string | null;
  status: AdoptionStatus;
  adopted_at: string | null;
  created_at: string;
  updated_at: string;
  owner_name: string;
  photos: AdoptionPhoto[];
  photo_count: number;
  photo_path: string | null;
  is_owner: boolean;
}

// =====================================
// ADOPTION REQUEST
// =====================================

export interface AdoptionRequest {
  id: number;
  adoption_id: number;
  requester_id: number;
  message: string;
  status: AdoptionRequestStatus;
  created_at: string;
  updated_at: string;
  pet_name: string;
  animal_type: AdoptionAnimalType;
  adoption_status: AdoptionStatus;
  owner_id: number;
  requester_name: string;
  owner_name: string;

  // Pickup arrangements are populated only for an approved request.
  // Keep them optional so older API responses remain compatible while
  // get_requests.php is being updated in the next step.
  meeting_location?: string | null;
  pickup_date?: string | null; // YYYY-MM-DD
  pickup_time?: string | null; // HH:MM:SS (MySQL TIME)
}

// The owner fills out these details BEFORE approving an applicant.
export interface AdoptionPickupDetails {
  meeting_location: string;
  pickup_date: string; // YYYY-MM-DD
  pickup_time: string; // HH:MM or HH:MM:SS
}

// =====================================
// NEW ADOPTION POST DATA
// =====================================

export interface NewAdoptionPost {
  pet_name: string;
  animal_type: AdoptionAnimalType;
  sex: 'male' | 'female' | 'unknown';
  age_months: number | null;
  breed: string | null;
  description: string;
  health_notes: string | null;
  barangay: string;
  location_details: string | null;
}

// =====================================
// API RESPONSES
// =====================================

export interface ApiResult {
  success: boolean;
  message: string;
}

export interface AdoptionPostsResponse extends ApiResult {
  count: number;
  posts: AdoptionPost[];
}

export interface AdoptionRequestsResponse extends ApiResult {
  count: number;
  requests: AdoptionRequest[];
}

export interface CreateAdoptionPostResponse extends ApiResult {
  adoption_id: number;
}

export interface UploadAdoptionPhotoResponse extends ApiResult {
  adoption_id: number;
  photo_id: number;
  photo_path: string;
  photo_count: number;
}

export interface SubmitAdoptionRequestResponse extends ApiResult {
  request_id: number;
  status: AdoptionRequestStatus;
}

export interface RespondToAdoptionRequestResponse extends ApiResult {
  request_id: number;
  adoption_id: number;
  status: 'approved' | 'rejected';
  listing_status: AdoptionStatus;
  meeting_location: string | null;
  pickup_date: string | null;
  pickup_time: string | null;
  other_requests_rejected: number;
  other_applicants_notice: string | null;
  // Populated by the backend only when a pickup schedule is changed.
  reschedule_id?: number | null;
}

// Cache the resolved photo URLs for a post while its photo paths remain
// unchanged. This prevents repeated URL validation and array recreation
// when Angular checks the adoption feed/gallery templates.
interface PhotoUrlCacheEntry {
  paths: string[];
  urls: string[];
}

// =====================================
// PET ADOPTION SERVICE
// =====================================

@Injectable({
  providedIn: 'root'
})
export class PetAdoptionService {

  private readonly http = inject(HttpClient);

  // Shared backend configuration used by all PawRescue services.
  private readonly baseUrl = getApiBaseUrl();
  private readonly serverBaseUrl = getServerBaseUrl();
  private readonly apiUrl = `${this.baseUrl}/adoption`;

  private readonly photoUrlCache =
    new WeakMap<AdoptionPost, PhotoUrlCacheEntry>();

  // =====================================
  // AUTHORIZATION HEADERS
  // =====================================

  private headers(): HttpHeaders {

    const token =
      sessionStorage.getItem('pawrescue_token') || '';

    return new HttpHeaders({
      Authorization: `Bearer ${token}`
    });
  }

  // =====================================
  // GET ADOPTION POSTS
  // =====================================

  getPosts(
    type: 'all' | 'dog' | 'cat' = 'all',
    scope: 'community' | 'mine' = 'community',
    status: AdoptionStatus | 'all' = 'all',
    id?: number
  ): Observable<AdoptionPostsResponse> {

    let params = new HttpParams()
      .set('type', type)
      .set('scope', scope)
      .set('status', status);

    if (id !== undefined) {
      params = params.set('id', String(id));
    }

    return this.http.get<AdoptionPostsResponse>(
      `${this.apiUrl}/get_posts.php`,
      {
        headers: this.headers(),
        params
      }
    );
  }

  // =====================================
  // CREATE ADOPTION POST
  // =====================================

  createPost(
    data: NewAdoptionPost
  ): Observable<CreateAdoptionPostResponse> {

    return this.http.post<CreateAdoptionPostResponse>(
      `${this.apiUrl}/create_post.php`,
      data,
      {
        headers: this.headers()
      }
    );
  }

  // =====================================
  // UPLOAD ADOPTION PHOTO
  // =====================================

  uploadPhoto(
    adoptionId: number,
    photo: File
  ): Observable<UploadAdoptionPhotoResponse> {

    const body = new FormData();

    body.append(
      'adoption_id',
      String(adoptionId)
    );

    body.append(
      'photo',
      photo,
      photo.name
    );

    // Keep multipart/form-data and the existing endpoint unchanged.
    // The page uploads sequentially to preserve its existing photo order.
    // Do not enable parallel uploads until the PHP backend is reviewed.
    return this.http.post<UploadAdoptionPhotoResponse>(
      `${this.apiUrl}/upload_photo.php`,
      body,
      {
        headers: this.headers()
      }
    );
  }

  // =====================================
  // SUBMIT ADOPTION REQUEST
  // =====================================

  submitRequest(
    adoptionId: number,
    message: string
  ): Observable<SubmitAdoptionRequestResponse> {

    return this.http.post<SubmitAdoptionRequestResponse>(
      `${this.apiUrl}/submit_request.php`,
      {
        adoption_id: adoptionId,
        message
      },
      {
        headers: this.headers()
      }
    );
  }

  // =====================================
  // GET SENT OR RECEIVED REQUESTS
  // =====================================

  getRequests(
    direction: 'sent' | 'received'
  ): Observable<AdoptionRequestsResponse> {

    return this.http.get<AdoptionRequestsResponse>(
      `${this.apiUrl}/get_requests.php`,
      {
        headers: this.headers(),
        params: { direction }
      }
    );
  }

  // =====================================
  // APPROVE OR REJECT REQUEST
  // =====================================

  respondToRequest(
    requestId: number,
    action: 'approve' | 'reject',
    pickupDetails?: AdoptionPickupDetails
  ): Observable<RespondToAdoptionRequestResponse> {

    // The backend requires all three pickup fields when action=approve.
    // Keeping this third parameter optional preserves existing component
    // calls until the owner's approval form is updated. Reject never needs
    // pickup information.
    const body: {
      request_id: number;
      action: 'approve' | 'reject';
      meeting_location?: string;
      pickup_date?: string;
      pickup_time?: string;
    } = {
      request_id: requestId,
      action
    };

    if (action === 'approve' && pickupDetails) {
      body.meeting_location = pickupDetails.meeting_location.trim();
      body.pickup_date = pickupDetails.pickup_date;
      body.pickup_time = pickupDetails.pickup_time;
    }

    return this.http.post<RespondToAdoptionRequestResponse>(
      `${this.apiUrl}/respond_request.php`,
      body,
      {
        headers: this.headers()
      }
    );
  }

  // =====================================
  // RESCHEDULE APPROVED PET PICKUP
  // =====================================

  reschedulePickup(
    requestId: number,
    pickupDetails: AdoptionPickupDetails,
    reason = ''
  ): Observable<RespondToAdoptionRequestResponse> {

    // Reuse respond_request.php. Only the pet owner may reschedule an
    // approved request while the pet is reserved; PHP validates those rules
    // and saves the old/new arrangements in one database transaction.
    const body: {
      request_id: number;
      action: 'reschedule';
      meeting_location: string;
      pickup_date: string;
      pickup_time: string;
      reason?: string;
    } = {
      request_id: requestId,
      action: 'reschedule',
      meeting_location: pickupDetails.meeting_location.trim(),
      pickup_date: pickupDetails.pickup_date,
      pickup_time: pickupDetails.pickup_time
    };

    const trimmedReason = reason.trim();
    if (trimmedReason) {
      body.reason = trimmedReason;
    }

    return this.http.post<RespondToAdoptionRequestResponse>(
      `${this.apiUrl}/respond_request.php`,
      body,
      {
        headers: this.headers()
      }
    );
  }

  // =====================================
  // COMPLETE PET ADOPTION
  // =====================================

  completeAdoption(
    adoptionId: number
  ): Observable<ApiResult> {

    return this.http.post<ApiResult>(
      `${this.apiUrl}/complete_adoption.php`,
      {
        adoption_id: adoptionId
      },
      {
        headers: this.headers()
      }
    );
  }

  // =====================================
  // GET PHOTO URL
  // =====================================

  getPhotoUrl(
    photoPath: string | null | undefined
  ): string | null {

    if (!photoPath) {
      return null;
    }

    // Accept only the existing backend's photo path formats.
    const validPath =
      /^\/(?:pawrescue\/)?pawrescue_api\/uploads\/adoptions\/[a-f0-9]{32}\.(jpg|png|webp)$/;

    if (!validPath.test(photoPath)) {
      return null;
    }

    const normalizedPath =
      photoPath.startsWith('/pawrescue_api/')
        ? `/pawrescue${photoPath}`
        : photoPath;

    return `${this.serverBaseUrl}${normalizedPath}`;
  }

  // =====================================
  // GET ALL PHOTO URLS
  // =====================================

  getPhotoUrls(post: AdoptionPost): string[] {

    const paths = (post.photos || [])
      .map(photo => photo.photo_path);

    if (paths.length === 0 && post.photo_path) {
      paths.push(post.photo_path);
    }

    const cached = this.photoUrlCache.get(post);

    // Compare the contents, not just the array reference. If photos are
    // updated in place, their URLs will still refresh correctly.
    if (
      cached &&
      cached.paths.length === paths.length &&
      paths.every((path, index) => path === cached.paths[index])
    ) {
      return cached.urls;
    }

    const urls = Array.from(new Set(paths))
      .map(path => this.getPhotoUrl(path))
      .filter((url): url is string => !!url);

    this.photoUrlCache.set(post, {
      paths,
      urls
    });

    return urls;
  }
}
