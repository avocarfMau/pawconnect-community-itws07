import {
  Component,
  ElementRef,
  ViewChild,
  OnInit,
  OnDestroy,
  ChangeDetectorRef,
  inject
} from '@angular/core';

import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import {
  Subscription,
  timeout,
  finalize,
  firstValueFrom
} from 'rxjs';

import {
  IonContent,
  IonButton,
  IonSpinner,
  IonIcon
} from '@ionic/angular';

import { addIcons } from 'ionicons';

import {
  arrowBackOutline,
  pawOutline,
  checkmarkCircleOutline,
  locationOutline,
  locateOutline,
  mapOutline,
  closeOutline,
  chevronDownOutline,
  informationCircleOutline,
  cameraOutline,
  closeCircleOutline,
  imageOutline,
  refreshOutline
} from 'ionicons/icons';

import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Camera, CameraDirection } from '@capacitor/camera';

import * as L from 'leaflet';

import {
  PetReportsService,
  PetReport,
  PetReportPhoto,
  UpdatePetReportRequest
} from '../../services/pet-reports';

interface PendingPhoto {
  file: File;
  previewUrl: string;
}

@Component({
  selector: 'app-edit-report',
  templateUrl: './edit-report.page.html',
  styleUrls: ['./edit-report.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonContent,
    IonButton,
    IonSpinner,
    IonIcon
  ]
})
export class EditReportPage implements OnInit, OnDestroy {
  private reportsService = inject(PetReportsService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  // =====================================
  // LOADING AND MESSAGE STATES
  // =====================================

  loading = true;
  saving = false;
  gettingLocation = false;
  saved = false;
  errorMessage = '';
  successMessage = '';
  locationMessage = '';
  locationError = '';

  private loadRequest?: Subscription;
  private saveRequest?: Subscription;
  private destroyed = false;
  private locationRequestId = 0;

  // =====================================
  // MULTIPLE-PHOTO MANAGEMENT
  // =====================================
  readonly maxPhotos = 10;
  selectedPhotos: PendingPhoto[] = [];
  uploadingPhoto = false;
  cameraOpening = false;
  deletingPhotoId: number | null = null;
  refreshingPhotos = false;
  photoError = '';
  photoActionMessage = '';
  photoUploadUncertain = false;
  uploadedPhotosCount = 0;
  currentPhotoNumber = 0;
  private photoRequest?: Subscription;

  get existingPhotos(): PetReportPhoto[] {
    if (!this.originalReport) return [];
    if (Array.isArray(this.originalReport.photos) && this.originalReport.photos.length > 0) {
      return this.originalReport.photos;
    }
    // Fallback for older reports that have not yet been migrated.
    return this.originalReport.photo_path
      ? [{ id: 0, photo_path: this.originalReport.photo_path, sort_order: 0, created_at: '' }]
      : [];
  }

  get remainingPhotoSlots(): number {
    return Math.max(0, this.maxPhotos - this.existingPhotos.length - this.selectedPhotos.length);
  }

  getPhotoUrl(photoPath: string | null): string | null {
    return this.reportsService.getPhotoUrl(photoPath);
  }


  // =====================================
  // REPORT STATE
  // =====================================

  reportId: number | null = null;
  originalReport: PetReport | null = null;
  selectedBarangay = '';
  landmark = '';
  today = this.getLocalDate();

  form = {
    report_type: 'lost' as 'lost' | 'found',
    animal_type: 'dog' as 'dog' | 'cat',
    pet_name: '',
    description: '',
    incident_date: '',
    location_address: ''
  };

  // =====================================
  // LOCATION STATE
  // =====================================

  selectedLatitude: number | null = null;
  selectedLongitude: number | null = null;
  showMap = false;
  mapReady = false;
  private map: L.Map | null = null;
  private locationMarker: L.Marker | null = null;

  private readonly defaultMapCenter: L.LatLngExpression = [
    12.8797,
    121.7740
  ];

  readonly barangays = [
    'San Bartolome',
    'Burgos',
    'Rizal',
    'Bonifacio',
    'Mallorca',
    'Mambangnan',
    'Diversion',
    'Tambo-Adorable',
    'Nieves',
    'Tabuating',
    'Magpapalayoc',
    'San Anton',
    'Castellano',
    'Tagumpay',
    'San Roque'
  ];

  @ViewChild('locationMap')
  set locationMapElement(
    element: ElementRef<HTMLDivElement> | undefined
  ) {
    if (element && this.showMap && !this.map && !this.destroyed) {
      this.initializeMap(element.nativeElement);
    }
  }

  constructor() {
    addIcons({
      arrowBackOutline,
      pawOutline,
      checkmarkCircleOutline,
      locationOutline,
      locateOutline,
      mapOutline,
      closeOutline,
      chevronDownOutline,
      informationCircleOutline,
      cameraOutline,
      closeCircleOutline,
      imageOutline,
      refreshOutline
    });
  }

  // =====================================
  // PAGE LIFECYCLE
  // =====================================

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));

    if (!Number.isSafeInteger(id) || id < 1) {
      this.loading = false;
      this.errorMessage = 'Invalid report ID.';
      return;
    }

    this.reportId = id;
    this.loadReport();
  }

  // =====================================
  // GET LOCAL DATE
  // =====================================

  private getLocalDate(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // =====================================
  // LOAD EXISTING REPORT
  // =====================================

  loadReport(): void {
    if (this.destroyed || this.reportId === null) return;

    this.loadRequest?.unsubscribe();
    this.loading = true;
    this.errorMessage = '';

    this.loadRequest = this.reportsService
      .getMyReports('all')
      .pipe(
        timeout(15000),
        finalize(() => {
          if (!this.destroyed) {
            this.loading = false;
            this.cdr.detectChanges();
          }
        })
      )
      .subscribe({
        next: response => {
          if (this.destroyed) return;

          const report = response.reports?.find(
            item => Number(item.id) === this.reportId
          );

          if (!response.success || !report) {
            this.errorMessage = 'Report not found in your reports.';
            return;
          }

          if (!['pending', 'under_review', 'in_progress'].includes(report.status)) {
            this.errorMessage = 'Resolved or closed reports cannot be edited.';
            return;
          }

          this.originalReport = report;
          this.form = {
            report_type: report.report_type,
            animal_type: report.animal_type,
            pet_name: report.pet_name || '',
            description: report.description,
            incident_date: report.incident_date?.slice(0, 10) || '',
            location_address: report.location_address || ''
          };

          this.parseLocationAddress(report.location_address || '');
          this.selectedLatitude = this.validCoordinate(report.latitude, -90, 90);
          this.selectedLongitude = this.validCoordinate(report.longitude, -180, 180);

          if (this.selectedLatitude === null || this.selectedLongitude === null) {
            this.selectedLatitude = null;
            this.selectedLongitude = null;
          }

          this.cdr.detectChanges();
        },
        error: error => {
          if (this.destroyed) return;
          this.errorMessage = error.status === 401
            ? 'Your session has expired. Please log in again.'
            : error.status === 0
              ? 'Unable to connect to the server.'
              : 'Unable to load this report. Please try again.';
          this.cdr.detectChanges();
        }
      });
  }

  // =====================================
  // PRE-FILL BARANGAY AND LANDMARK
  // =====================================

  private parseLocationAddress(address: string): void {
    const suffix = ', San Leonardo, Nueva Ecija';
    const cleaned = address.trim().endsWith(suffix)
      ? address.trim().slice(0, -suffix.length)
      : address.trim();

    const barangay = this.barangays.find(
      item => cleaned === item || cleaned.startsWith(`${item}, `)
    );

    this.selectedBarangay = barangay || '';
    this.landmark = barangay
      ? cleaned.slice(barangay.length).replace(/^,\s*/, '')
      : '';
  }

  updateLocationAddress(): void {
    const barangay = this.selectedBarangay.trim();
    const landmark = this.landmark.trim();

    this.form.location_address = barangay
      ? [barangay, landmark, 'San Leonardo, Nueva Ecija']
          .filter(Boolean)
          .join(', ')
      : '';
  }

  private validCoordinate(
    value: string | number | null | undefined,
    min: number,
    max: number
  ): number | null {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= min && numeric <= max
      ? numeric
      : null;
  }

  // =====================================
  // MAP LOCATION CONTROLS
  // =====================================

  toggleMap(): void {
    if (this.loading || this.saving || this.gettingLocation) return;

    if (this.showMap) {
      this.showMap = false;
      this.destroyMap();
    } else {
      this.showMap = true;
      this.locationError = '';
    }

    this.cdr.detectChanges();
  }

  async useCurrentLocation(): Promise<void> {
    if (this.loading || this.saving || this.gettingLocation || this.destroyed) return;

    this.locationMessage = '';
    this.locationError = '';

    if (!Capacitor.isNativePlatform() && !window.isSecureContext) {
      this.locationError = 'Location access requires HTTPS or localhost.';
      return;
    }

    const requestId = ++this.locationRequestId;
    this.gettingLocation = true;
    this.cdr.detectChanges();

    try {
      if (Capacitor.isNativePlatform()) {
        let permission = await Geolocation.checkPermissions();

        if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') {
          permission = await Geolocation.requestPermissions();
        }

        if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') {
          throw new Error('Location permission was denied.');
        }
      }

      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      });

      if (this.destroyed || requestId !== this.locationRequestId) return;

      this.setSelectedLocation(position.coords.latitude, position.coords.longitude);
      this.locationMessage = 'Current GPS location selected. Verify the incident location.';
    } catch (error: any) {
      if (this.destroyed || requestId !== this.locationRequestId) return;
      this.locationError = String(error?.message || '').toLowerCase().includes('permission')
        ? 'Location permission was denied. Select a location on the map.'
        : 'Unable to retrieve location. Try again or select on the map.';
    } finally {
      if (!this.destroyed && requestId === this.locationRequestId) {
        this.gettingLocation = false;
        this.cdr.detectChanges();
      }
    }
  }

  private createLocationIcon(): L.DivIcon {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="44" height="56" viewBox="0 0 44 56" aria-hidden="true">
        <path d="M22 2 C10.4 2 2 10.8 2 22 C2 37.5 22 54 22 54 C22 54 42 37.5 42 22 C42 10.8 33.6 2 22 2 Z"
          fill="#e53935" stroke="#ffffff" stroke-width="2.5" />
        <circle cx="22" cy="21" r="11" fill="#ffffff" />
        <circle cx="22" cy="21" r="5" fill="#e53935" />
      </svg>
    `;

    return L.divIcon({
      className: 'pawrescue-custom-marker',
      html: svg,
      iconSize: [44, 56],
      iconAnchor: [22, 54],
      popupAnchor: [0, -48]
    });
  }

  private initializeMap(container: HTMLDivElement): void {
    if (this.destroyed || this.map || !this.showMap) return;

    const hasLocation = this.selectedLatitude !== null && this.selectedLongitude !== null;
    const center: L.LatLngExpression = hasLocation
      ? [this.selectedLatitude!, this.selectedLongitude!]
      : this.defaultMapCenter;

    this.map = L.map(container, {
      center,
      zoom: hasLocation ? 16 : 6,
      zoomControl: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(this.map);

    this.map.on('click', (event: L.LeafletMouseEvent) => {
      if (this.saving || this.loading) return;
      this.setSelectedLocation(event.latlng.lat, event.latlng.lng);
      this.locationMessage = 'Location pin selected. Drag it to adjust the location.';
      this.cdr.detectChanges();
    });

    this.mapReady = true;

    if (hasLocation) this.updateLocationMarker();

    setTimeout(() => {
      if (this.map && this.showMap && !this.destroyed) {
        this.map.invalidateSize();
        if (this.selectedLatitude !== null && this.selectedLongitude !== null) {
          this.updateLocationMarker();
        }
      }
    }, 150);
  }

  private setSelectedLocation(latitude: number, longitude: number): void {
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 ||
      longitude < -180 || longitude > 180
    ) return;

    this.selectedLatitude = Number(latitude.toFixed(7));
    this.selectedLongitude = Number(longitude.toFixed(7));
    this.locationError = '';

    this.updateLocationMarker();

    if (this.map) {
      this.map.setView([this.selectedLatitude, this.selectedLongitude],
        Math.max(this.map.getZoom(), 16));
    }
  }

  private updateLocationMarker(): void {
    if (!this.map || this.selectedLatitude === null || this.selectedLongitude === null) return;

    const coordinates: L.LatLngExpression = [this.selectedLatitude, this.selectedLongitude];

    if (this.locationMarker) {
      this.locationMarker.setLatLng(coordinates);
      return;
    }

    this.locationMarker = L.marker(coordinates, {
      icon: this.createLocationIcon(),
      draggable: true,
      autoPan: true,
      zIndexOffset: 1000
    }).addTo(this.map);

    this.locationMarker.on('dragend', () => {
      if (!this.locationMarker || this.saving) return;
      const position = this.locationMarker.getLatLng();
      this.setSelectedLocation(position.lat, position.lng);
      this.locationMessage = 'Location marker adjusted successfully.';
      this.cdr.detectChanges();
    });
  }

  clearSelectedLocation(): void {
    if (this.loading || this.saving) return;

    ++this.locationRequestId;
    this.gettingLocation = false;
    this.selectedLatitude = null;
    this.selectedLongitude = null;
    this.locationMessage = '';
    this.locationError = '';

    if (this.map && this.locationMarker) {
      this.map.removeLayer(this.locationMarker);
      this.locationMarker = null;
    }

    this.cdr.detectChanges();
  }

  private destroyMap(): void {
    if (this.map) {
      this.map.off();
      this.map.remove();
      this.map = null;
    }

    this.locationMarker = null;
    this.mapReady = false;
  }


  // =====================================
  // SELECT ADDITIONAL GALLERY PHOTOS
  // =====================================
  onPhotosSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';

    if (this.isPhotoBusy() || this.photoUploadUncertain) return;

    this.photoError = '';
    let rejected = 0;
    let noSpace = false;

    for (const file of files) {
      if (this.remainingPhotoSlots <= 0) {
        noSpace = true;
        break;
      }
      if (!this.isValidPhoto(file)) {
        rejected++;
        continue;
      }
      this.selectedPhotos.push({
        file,
        previewUrl: URL.createObjectURL(file)
      });
    }

    if (rejected > 0 || noSpace) {
      this.photoError =
        (rejected > 0 ? `${rejected} invalid photo(s) skipped. Use JPG/PNG/WebP under 5 MB. ` : '') +
        (noSpace ? 'A report can have at most 10 photos.' : '');
    }
    this.cdr.detectChanges();
  }

  private isValidPhoto(file: File): boolean {
    return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) &&
      file.size > 0 && file.size <= 5 * 1024 * 1024;
  }

  private isPhotoBusy(): boolean {
    return this.destroyed || this.loading || this.saving || this.saved ||
      this.uploadingPhoto || this.cameraOpening || this.deletingPhotoId !== null ||
      this.refreshingPhotos;
  }

  removeSelectedPhoto(index: number): void {
    if (this.isPhotoBusy()) return;
    const removed = this.selectedPhotos.splice(index, 1)[0];
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    this.photoError = '';
    this.cdr.detectChanges();
  }

  private clearSelectedPhotos(): void {
    for (const item of this.selectedPhotos) {
      URL.revokeObjectURL(item.previewUrl);
    }
    this.selectedPhotos = [];
  }

  // =====================================
  // CAPTURE MORE THAN ONE CAMERA PHOTO
  // =====================================
  async takePhoto(): Promise<void> {
    if (this.isPhotoBusy() || this.remainingPhotoSlots <= 0 || this.photoUploadUncertain) return;
    if (!Capacitor.isNativePlatform()) {
      this.photoError = 'Camera capture requires the PawConnect Android app. You can use Choose Photos instead.';
      this.cdr.detectChanges();
      return;
    }

    this.cameraOpening = true;
    this.photoError = '';
    this.cdr.detectChanges();

    try {
      const captured = await Camera.takePhoto({
        quality: 75,
        cameraDirection: CameraDirection.Rear,
        targetWidth: 1600,
        targetHeight: 1600,
        saveToGallery: false
      });
      if (this.destroyed || !captured.webPath) return;
      const response = await fetch(captured.webPath);
      if (!response.ok) throw new Error('Unable to read captured photo.');
      const file = await this.compressCameraPhoto(await response.blob());
      if (!this.isValidPhoto(file)) throw new Error('Photo must be under 5 MB.');
      if (!this.destroyed && this.remainingPhotoSlots > 0) {
        this.selectedPhotos.push({ file, previewUrl: URL.createObjectURL(file) });
      }
    } catch (error: any) {
      const message = String(error?.message || '').toLowerCase();
      const code = String(error?.code || '').toLowerCase();
      if (!message.includes('cancel') && !code.includes('cancel')) {
        this.photoError = 'Unable to capture photo. Check permissions and try again.';
        console.error('[PAWCONNECT EDIT PHOTO]', error);
      }
    } finally {
      if (!this.destroyed) {
        this.cameraOpening = false;
        // Force a UI refresh: otherwise camera button can stay disabled.
        this.cdr.detectChanges();
      }
    }
  }

  private async compressCameraPhoto(blob: Blob): Promise<File> {
    const image = await createImageBitmap(blob);
    try {
      const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image processing unavailable.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      let compressed: Blob | null = null;
      for (const quality of [0.82, 0.70, 0.55]) {
        compressed = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (compressed && compressed.size > 0 && compressed.size <= 5 * 1024 * 1024) break;
      }
      if (!compressed || compressed.size > 5 * 1024 * 1024) {
        throw new Error('Could not compress photo below 5 MB.');
      }
      return new File([compressed], `pawrescue-edit-${Date.now()}.jpg`, { type: 'image/jpeg' });
    } finally {
      image.close();
    }
  }

  // =====================================
  // UPLOAD ADDITIONAL PHOTOS ONE AT A TIME
  // =====================================
  async uploadSelectedPhotos(): Promise<void> {
    if (this.isPhotoBusy() || this.photoUploadUncertain ||
        this.reportId === null || this.selectedPhotos.length === 0) return;

    this.uploadingPhoto = true;
    this.photoError = '';
    this.photoActionMessage = '';
    this.uploadedPhotosCount = 0;
    this.currentPhotoNumber = 0;
    this.cdr.detectChanges();

    const totalToUpload = this.selectedPhotos.length;
    try {
      while (this.selectedPhotos.length > 0) {
        if (this.destroyed || this.reportId === null) return;
        const item = this.selectedPhotos[0];
        this.currentPhotoNumber = this.uploadedPhotosCount + 1;
        this.cdr.detectChanges();

        const response = await firstValueFrom(
          this.reportsService.uploadPhoto(this.reportId, item.file).pipe(timeout(30000))
        );
        if (this.destroyed) return;
        if (!response.success) throw new Error(response.message || 'Photo upload failed.');

        // Update the gallery without discarding unsaved form changes.
        const current = this.originalReport;
        if (current) {
          const updatedPhotos = [
            ...(Array.isArray(current.photos) ? current.photos : []),
            {
              id: Number(response.photo_id),
              photo_path: response.photo_path,
              sort_order: current.photos?.length ?? 0,
              created_at: new Date().toISOString()
            }
          ];
          this.originalReport = {
            ...current,
            photos: updatedPhotos,
            photo_count: Number(response.photo_count),
            photo_path: current.photo_path || response.photo_path
          };
        }

        URL.revokeObjectURL(item.previewUrl);
        this.selectedPhotos.shift();
        this.uploadedPhotosCount++;
        this.cdr.detectChanges();
      }
      this.photoActionMessage = `${totalToUpload} photo(s) added successfully!`;
    } catch (error: any) {
      console.error('[PAWCONNECT EDIT PHOTO UPLOAD]', error);
      const uncertain = error?.status === 0 || error?.name === 'TimeoutError';
      this.photoUploadUncertain = uncertain;
      this.photoError = uncertain
        ? 'Connection interrupted. A photo may have been saved. Tap Refresh Photos before selecting or uploading again to avoid duplicates.'
        : error?.error?.message || error?.message || 'Unable to upload photos.';
    } finally {
      if (!this.destroyed) {
        this.uploadingPhoto = false;
        this.cdr.detectChanges();
      }
    }
  }

  // =====================================
  // RELOAD PHOTOS ONLY (PRESERVES FORM)
  // =====================================
  async refreshPhotos(): Promise<void> {
    if (this.isPhotoBusy() || this.reportId === null) return;
    this.refreshingPhotos = true;
    this.photoError = '';
    try {
      const response = await firstValueFrom(
        this.reportsService.getMyReports('all').pipe(timeout(15000))
      );
      if (this.destroyed) return;
      const updated = response.reports?.find(item => Number(item.id) === this.reportId);
      if (!response.success || !updated) throw new Error('Report not found.');
      const current = this.originalReport;
      if (current) {
        this.originalReport = {
          ...current,
          photos: updated.photos,
          photo_count: updated.photo_count,
          photo_path: updated.photo_path,
          status: updated.status
        };
      }
      // Discard uncertain pending requests: never automatically resend.
      this.clearSelectedPhotos();
      this.photoUploadUncertain = false;
      this.photoActionMessage = 'Photo gallery refreshed. You can select additional photos.';
    } catch (error: any) {
      this.photoError = error?.message || 'Unable to refresh photos.';
    } finally {
      if (!this.destroyed) {
        this.refreshingPhotos = false;
        this.cdr.detectChanges();
      }
    }
  }

  // =====================================
  // DELETE A SPECIFIC EXISTING PHOTO
  // =====================================
  async deleteExistingPhoto(photo: PetReportPhoto): Promise<void> {
    if (this.isPhotoBusy() || this.photoUploadUncertain ||
        this.reportId === null || photo.id < 1) return;
    if (!window.confirm('Delete this photo from your pet report? This cannot be undone.')) return;

    this.deletingPhotoId = photo.id;
    this.photoError = '';
    this.photoActionMessage = '';
    this.cdr.detectChanges();

    try {
      const response = await firstValueFrom(
        this.reportsService.deletePhoto(this.reportId, photo.id).pipe(timeout(20000))
      );
      if (this.destroyed) return;
      if (!response.success) throw new Error(response.message || 'Unable to delete photo.');
      const current = this.originalReport;
      if (current) {
        const remaining = (current.photos || []).filter(item => Number(item.id) !== photo.id);
        this.originalReport = {
          ...current,
          photos: remaining.map((item, index) => ({ ...item, sort_order: index })),
          photo_count: Number(response.photo_count),
          photo_path: response.primary_photo_path
        };
      }
      this.photoActionMessage = 'Photo removed successfully.';
    } catch (error: any) {
      console.error('[PAWCONNECT DELETE PHOTO]', error);
      this.photoError = error?.status === 0 || error?.name === 'TimeoutError'
        ? 'Unable to confirm deletion. Tap Refresh Photos to check before trying again.'
        : error?.error?.message || error?.message || 'Unable to delete photo.';
    } finally {
      if (!this.destroyed) {
        this.deletingPhotoId = null;
        this.cdr.detectChanges();
      }
    }
  }

  // =====================================
  // SAVE UPDATED REPORT
  // =====================================

  saveChanges(): void {
    if (this.destroyed || this.loading || this.saving || this.uploadingPhoto ||
        this.deletingPhotoId !== null || !this.originalReport || this.reportId === null) {
      return;
    }

    this.errorMessage = '';
    this.successMessage = '';
    this.updateLocationAddress();

    const data: UpdatePetReportRequest = {
      report_id: this.reportId,
      report_type: this.form.report_type,
      animal_type: this.form.animal_type,
      pet_name: this.form.pet_name.trim() || null,
      description: this.form.description.trim(),
      incident_date: this.form.incident_date,
      location_address: this.form.location_address.trim(),
      latitude: this.selectedLatitude,
      longitude: this.selectedLongitude
    };

    if (!this.selectedBarangay || !data.description || !data.incident_date || !data.location_address) {
      this.errorMessage = 'Please complete all required fields.';
      return;
    }

    if (
      data.description.length > 5000 ||
      data.location_address.length > 255 ||
      (data.pet_name && data.pet_name.length > 100)
    ) {
      this.errorMessage = 'One or more fields are too long.';
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.incident_date) || data.incident_date > this.today) {
      this.errorMessage = 'Please select a valid incident date.';
      return;
    }

    if (!window.confirm('Save changes to this pet report?')) return;

    this.saving = true;
    this.cdr.detectChanges();

    this.saveRequest = this.reportsService
      .updateReport(data)
      .pipe(
        timeout(20000),
        finalize(() => {
          if (!this.destroyed) {
            this.saving = false;
            this.cdr.detectChanges();
          }
        })
      )
      .subscribe({
        next: response => {
          if (this.destroyed) return;

          if (response.success) {
            this.saved = true;
            this.successMessage = response.message || 'Pet report updated successfully!';
            this.destroyMap();
            this.showMap = false;
          } else {
            this.errorMessage = response.message || 'Unable to update report.';
          }

          this.cdr.detectChanges();
        },
        error: error => {
          if (this.destroyed) return;

          if (error.status === 401) {
            this.errorMessage = 'Your session has expired. Please log in again.';
          } else if (error.status === 404) {
            this.errorMessage = 'Report not found or access denied.';
          } else if (error.status === 409) {
            this.errorMessage = error.error?.message || 'Report cannot be edited. Refresh My Reports.';
          } else if (error.status === 0 || error.name === 'TimeoutError') {
            this.errorMessage = 'Unable to confirm the update. Check My Reports before retrying.';
          } else {
            this.errorMessage = error.error?.message || 'Unable to update report.';
          }

          this.cdr.detectChanges();
        }
      });
  }

  // =====================================
  // NAVIGATION AND CLEANUP
  // =====================================

  goBack(): void {
    if (this.saving || this.uploadingPhoto || this.deletingPhotoId !== null) return;
    this.destroyMap();
    this.router.navigateByUrl('/my-reports');
  }

  viewReports(): void {
    this.goBack();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    ++this.locationRequestId;
    this.loadRequest?.unsubscribe();
    this.saveRequest?.unsubscribe();
    this.photoRequest?.unsubscribe();
    this.clearSelectedPhotos();
    this.destroyMap();
  }
}
