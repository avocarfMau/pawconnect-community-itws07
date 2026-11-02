import {
  Component,
  inject,
  OnDestroy,
  ChangeDetectorRef,
  NgZone,
  ViewChild,
  ElementRef
} from '@angular/core';

import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import {
  Subscription,
  timeout,
  finalize,
  from,
  concatMap,
  map
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
  cameraOutline,
  closeCircleOutline,
  locationOutline,
  locateOutline,
  mapOutline,
  closeOutline,
  chevronDownOutline,
  informationCircleOutline, addOutline, refreshOutline, imageOutline, calendarOutline, chevronForwardOutline, expandOutline, chevronBackOutline, createOutline } from 'ionicons/icons';

import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Camera, CameraDirection } from '@capacitor/camera';

import * as L from 'leaflet';

import {
  PetReportsService,
  CreatePetReportRequest
} from '../../services/pet-reports';

// =====================================
// SELECTED PHOTO FOR MULTI-PHOTO UPLOAD
// =====================================
interface SelectedPetPhoto {
  file: File;
  previewUrl: string;
  uploaded: boolean;
}

@Component({
  selector: 'app-report-pet',
  templateUrl: './report-pet.page.html',
  styleUrls: ['./report-pet.page.scss'],
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
export class ReportPetPage implements OnDestroy {
  private reportsService = inject(PetReportsService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);

  private submitRequest?: Subscription;
  private photoRequest?: Subscription;

  private destroyed = false;

  // =====================================
  // LOADING STATES
  // =====================================
  loading = false;
  uploadingPhoto = false;
  gettingLocation = false;

  // =====================================
  // MESSAGES
  // =====================================
  successMessage = '';
  errorMessage = '';
  photoError = '';
  locationMessage = '';
  locationError = '';

  // =====================================
  // REPORT STATE
  // =====================================
  submittedReportId: number | null = null;

  submissionUncertain = false;

  // =====================================
  // MULTIPLE PHOTO STATE
  // =====================================
  readonly maxPhotos = 10;

  selectedPhotos: SelectedPetPhoto[] = [];

  // Legacy preview properties are retained for compatibility.
  selectedPhoto: File | null = null;

  photoPreview: string | null = null;

  photoUploaded = false;

  cameraOpening = false;

  uploadedPhotosCount = 0;

  currentPhotoNumber = 0;

  // A request can succeed on the server even if its response times out.
  // Do not retry that picture automatically without checking the report.
  photoUploadUncertain = false;

  get remainingPhotoSlots(): number {
    return Math.max(0, this.maxPhotos - this.selectedPhotos.length);
  }

  // =====================================
  // THREE STEP REPORT FORM
  // =====================================
  formStep: 1 | 2 | 3 = 1;
  stepError = '';

  private scrollFormToTop(): void {
    void this.pageContent?.scrollToTop(220);
  }

  nextStep(): void {
    if (
      this.loading || this.uploadingPhoto || this.cameraOpening ||
      this.submissionUncertain || this.submittedReportId !== null
    ) {
      return;
    }

    this.stepError = '';

    if (this.formStep === 1) {
      if (!this.form.description.trim()) {
        this.stepError = 'Please describe the pet before continuing.';
        return;
      }
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(this.form.incident_date) ||
        this.form.incident_date > this.today
      ) {
        this.stepError = 'Please select a valid date when the pet was lost or found.';
        return;
      }
      this.formStep = 2;
      // For Found Pet, start GPS capture on entering Location step.
      // Residents can retry using the GPS button if permission is denied.
      if (this.form.report_type === 'found' && !this.foundGpsVerified) {
        void this.useCurrentLocation();
      }
    } else if (this.formStep === 2) {
      if (this.form.report_type === 'found') {
        if (this.gettingLocation) {
          this.stepError = 'Please wait for GPS location capture to finish.';
          return;
        }
        if (!this.foundGpsVerified || this.selectedLatitude === null || this.selectedLongitude === null) {
          this.stepError = 'Please capture the GPS location where you found the pet before continuing.';
          return;
        }
      } else if (!this.selectedBarangay.trim()) {
        this.stepError = 'Please select the barangay where your missing pet was last seen.';
        return;
      }
      this.updateLocationAddress();
      if (this.form.location_address.length > 255) {
        this.stepError = 'The location is too long. Please shorten the landmark.';
        return;
      }
      // Remove the Leaflet instance before leaving the map step.
      // Previously selected coordinates are intentionally retained.
      if (this.showMap) {
        this.showMap = false;
        this.destroyMap();
      }
      this.formStep = 3;
    }

    this.scrollFormToTop();
  }

  previousStep(): void {
    if (
      this.loading || this.uploadingPhoto || this.cameraOpening ||
      this.submissionUncertain || this.submittedReportId !== null
    ) {
      return;
    }
    this.stepError = '';
    this.formStep = this.formStep === 3 ? 2 : 1;
    this.scrollFormToTop();
  }

  // =====================================
  // LOCATION STATE
  // =====================================
  selectedLatitude: number | null = null;

  selectedLongitude: number | null = null;

  // True only after GPS successfully captures the location for a Found Pet.
  foundGpsVerified = false;

  showMap = false;

  mapReady = false;

  private map: L.Map | null = null;

  private locationMarker: L.Marker | null = null;

  private locationRequestId = 0;

  // Default map location: Philippines
  private readonly defaultMapCenter: L.LatLngExpression = [
    12.8797,
    121.7740
  ];

  // =====================================
  // MAP CONTAINER
  // =====================================
  @ViewChild(IonContent)
  private pageContent?: IonContent;

  @ViewChild('locationMap')
  set locationMapElement(
    element: ElementRef<HTMLDivElement> | undefined
  ) {
    if (
      element &&
      this.showMap &&
      !this.map &&
      !this.destroyed
    ) {
      this.initializeMap(element.nativeElement);
    }
  }

  // =====================================
  // REPORT FORM
  // =====================================
  // Barangay and landmark fields displayed separately in the form.
  // Existing API still receives the combined location_address.
  selectedBarangay = '';
  landmark = '';

  updateLocationAddress(): void {
    if (this.form.report_type === 'found') {
      // The existing API requires a nonempty location_address even when
      // exact latitude/longitude are submitted in their own columns.
      // Do not invent a barangay or a reverse-geocoded street address.
      this.form.location_address =
        this.foundGpsVerified && this.selectedLatitude !== null && this.selectedLongitude !== null
          ? `Found pet GPS: ${this.selectedLatitude.toFixed(7)}, ${this.selectedLongitude.toFixed(7)}`
          : '';
      return;
    }

    const barangay = this.selectedBarangay.trim();
    const landmark = this.landmark.trim();
    this.form.location_address = barangay
      ? [barangay, landmark, 'San Leonardo, Nueva Ecija']
          .filter(Boolean)
          .join(', ')
      : '';
  }

  onReportTypeChange(type: 'lost' | 'found'): void {
    this.form.report_type = type;
    // Do not reuse an old Lost Pet map pin as a Found Pet GPS position,
    // or vice versa. Keep other pet information already typed.
    this.locationRequestId++;
    this.gettingLocation = false;
    this.showMap = false;
    this.destroyMap();
    this.selectedLatitude = null;
    this.selectedLongitude = null;
    this.foundGpsVerified = false;
    this.selectedBarangay = '';
    this.landmark = '';
    this.form.location_address = '';
    this.locationError = '';
    this.locationMessage = '';
    this.stepError = '';
    this.errorMessage = '';
  }

  today = this.getLocalDate();

  form = {
    report_type: 'lost' as 'lost' | 'found',
    animal_type: 'dog' as 'dog' | 'cat',
    pet_name: '',
    description: '',
    incident_date: '',
    location_address: ''
  };

  constructor() {
    addIcons({arrowBackOutline,refreshOutline,pawOutline,imageOutline,locationOutline,calendarOutline,chevronForwardOutline,expandOutline,chevronBackOutline,mapOutline,createOutline,checkmarkCircleOutline,closeOutline,chevronDownOutline,informationCircleOutline,locateOutline,cameraOutline,closeCircleOutline,addOutline});
  }

  // Ionic keeps pages in its router outlet rather than constructing a new
  // component every time. Reset the prior successful submission on re-entry.
  ionViewWillEnter(): void {
    if (!this.loading && !this.uploadingPhoto) {
      this.resetForNewReport();
    }
  }

  private resetForNewReport(): void {
    // Stop callbacks from a previous visit before discarding its state.
    this.submitRequest?.unsubscribe();
    this.photoRequest?.unsubscribe();
    this.submitRequest = undefined;
    this.photoRequest = undefined;
    this.locationRequestId++;
    this.gettingLocation = false;
    this.showMap = false;
    this.destroyMap();
    this.clearPhotoPreview(); // Revoke photo preview URLs; prevent leaks.

    this.formStep = 1;
    this.stepError = '';
    this.today = this.getLocalDate();
    this.form = {
      report_type: 'lost',
      animal_type: 'dog',
      pet_name: '',
      description: '',
      incident_date: '',
      location_address: ''
    };
    this.selectedBarangay = '';
    this.landmark = '';
    this.selectedLatitude = null;
    this.selectedLongitude = null;
    this.foundGpsVerified = false;
    this.submittedReportId = null;
    this.submissionUncertain = false;
    this.loading = false;
    this.uploadingPhoto = false;
    this.cameraOpening = false;
    this.photoUploaded = false;
    this.photoUploadUncertain = false;
    this.uploadedPhotosCount = 0;
    this.currentPhotoNumber = 0;
    this.successMessage = '';
    this.errorMessage = '';
    this.photoError = '';
    this.locationMessage = '';
    this.locationError = '';
  }

  reportAnotherPet(): void {
    // Never abandon a pending/uncertain upload: the report may already exist.
    if (
      this.submittedReportId === null || this.loading || this.uploadingPhoto ||
      this.submissionUncertain || this.photoUploadUncertain || this.photoError ||
      (this.selectedPhotos.length > 0 && !this.photoUploaded)
    ) {
      return;
    }
    this.resetForNewReport();
    void this.pageContent?.scrollToTop(0);
  }

  // =====================================
  // UI UPDATE HELPER
  // =====================================
  private updateUI(callback: () => void) {
    if (this.destroyed) {
      return;
    }

    this.zone.run(() => {
      callback();
      this.cdr.detectChanges();
    });
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
  // CUSTOM SVG LOCATION MARKER
  // =====================================
  private createLocationIcon(): L.DivIcon {
    const svg = `
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="44"
        height="56"
        viewBox="0 0 44 56"
        aria-hidden="true"
      >
        <path
          d="M22 2 C10.4 2 2 10.8 2 22 C2 37.5 22 54 22 54 C22 54 42 37.5 42 22 C42 10.8 33.6 2 22 2 Z"
          fill="#e53935"
          stroke="#ffffff"
          stroke-width="2.5"
        />
        <circle
          cx="22"
          cy="21"
          r="11"
          fill="#ffffff"
        />
        <circle
          cx="22"
          cy="21"
          r="5"
          fill="#e53935"
        />
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

  // =====================================
  // USE CURRENT GPS LOCATION
  // =====================================
  async useCurrentLocation() {
    if (
      this.loading ||
      this.uploadingPhoto ||
      this.gettingLocation ||
      this.submissionUncertain ||
      this.submittedReportId !== null
    ) {
      return;
    }

    this.locationError = '';
    this.locationMessage = '';

    // Browser requires localhost or HTTPS.
    if (
      !Capacitor.isNativePlatform() &&
      !window.isSecureContext
    ) {
      this.locationError =
        'Location access requires HTTPS or localhost.';
      return;
    }

    this.gettingLocation = true;

    const requestId = ++this.locationRequestId;

    this.cdr.detectChanges();

    try {
      // Request native permissions when needed.
      if (Capacitor.isNativePlatform()) {
        let permissions = await Geolocation.checkPermissions();

        if (
          permissions.location !== 'granted' &&
          permissions.coarseLocation !== 'granted'
        ) {
          permissions = await Geolocation.requestPermissions();
        }

        if (
          permissions.location !== 'granted' &&
          permissions.coarseLocation !== 'granted'
        ) {
          throw new Error('Location permission was denied.');
        }
      }

      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      });

      if (
        this.destroyed ||
        requestId !== this.locationRequestId
      ) {
        return;
      }

      this.updateUI(() => {
        this.setSelectedLocation(
          position.coords.latitude,
          position.coords.longitude
        );

        if (this.form.report_type === 'found') {
          this.foundGpsVerified = true;
          this.updateLocationAddress();
          this.stepError = '';
          this.locationMessage = 'GPS location captured for your Found Pet report.';
        } else {
          this.locationMessage =
            'Current GPS location selected. Please verify that the map pin ' +
            'matches where the missing pet was last seen.';
        }
      });

      console.log(
        'Current location:',
        position.coords.latitude,
        position.coords.longitude
      );
    } catch (error: any) {
      if (
        this.destroyed ||
        requestId !== this.locationRequestId
      ) {
        return;
      }

      console.error('Geolocation error:', error);

      this.updateUI(() => {
        const message = String(error?.message || '').toLowerCase();

        if (
          message.includes('permission') ||
          message.includes('denied')
        ) {
          this.locationError =
            'Location permission was denied. ' +
            'Please allow location access ' +
            'or manually select a location on the map.';
        } else if (
          message.includes('timeout') ||
          message.includes('timed out')
        ) {
          this.locationError =
            'Location request timed out. ' +
            'Please try again or select a location manually.';
        } else {
          this.locationError =
            'Unable to retrieve your location. ' +
            'Please check your location settings ' +
            'or select a location on the map.';
        }
      });
    } finally {
      if (
        !this.destroyed &&
        requestId === this.locationRequestId
      ) {
        this.updateUI(() => {
          this.gettingLocation = false;
        });
      }
    }
  }

  // =====================================
  // SHOW OR HIDE LOCATION MAP
  // =====================================
  toggleMap() {
    if (
      this.loading ||
      this.uploadingPhoto ||
      this.submissionUncertain ||
      this.submittedReportId !== null
    ) {
      return;
    }

    if (this.showMap) {
      this.showMap = false;
      this.destroyMap();
    } else {
      this.showMap = true;
      this.locationError = '';
    }

    this.cdr.detectChanges();
  }

  // =====================================
  // INITIALIZE LEAFLET MAP
  // =====================================
  private initializeMap(container: HTMLDivElement) {
    if (this.map || this.destroyed || !this.showMap) {
      return;
    }

    const hasSelectedLocation =
      this.selectedLatitude !== null &&
      this.selectedLongitude !== null;

    const center: L.LatLngExpression = hasSelectedLocation
      ? [this.selectedLatitude!, this.selectedLongitude!]
      : this.defaultMapCenter;

    this.map = L.map(container, {
      center,
      zoom: hasSelectedLocation ? 16 : 6,
      zoomControl: true
    });

    L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }
    ).addTo(this.map);

    // Tap on map to set or move marker.
    this.map.on('click', (event: L.LeafletMouseEvent) => {
      if (
        this.loading ||
        this.uploadingPhoto ||
        this.submissionUncertain ||
        this.submittedReportId !== null
      ) {
        return;
      }

      this.updateUI(() => {
        this.setSelectedLocation(
          event.latlng.lat,
          event.latlng.lng
        );

        this.locationMessage =
          'Location pin selected. ' +
          'You can drag the marker to adjust ' +
          'the exact incident location.';
      });
    });

    this.mapReady = true;

    // Show marker immediately if the
    // user already selected GPS coordinates.
    if (hasSelectedLocation) {
      this.updateLocationMarker();
    }

    // Leaflet needs an accurate size
    // after the container becomes visible.
    setTimeout(() => {
      if (this.map && this.showMap && !this.destroyed) {
        this.map.invalidateSize();

        if (
          this.selectedLatitude !== null &&
          this.selectedLongitude !== null
        ) {
          this.updateLocationMarker();
        }
      }
    }, 150);
  }

  // =====================================
  // SAVE SELECTED COORDINATES
  // =====================================
  private setSelectedLocation(
    latitude: number,
    longitude: number
  ) {
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return;
    }

    this.selectedLatitude = Number(latitude.toFixed(7));

    this.selectedLongitude = Number(longitude.toFixed(7));

    this.locationError = '';

    // Update or create location pin.
    this.updateLocationMarker();

    if (this.map) {
      const coordinates: L.LatLngExpression = [
        this.selectedLatitude,
        this.selectedLongitude
      ];

      this.map.setView(
        coordinates,
        Math.max(this.map.getZoom(), 16)
      );
    }
  }

  // =====================================
  // CREATE OR MOVE LOCATION MARKER
  // =====================================
  private updateLocationMarker() {
    if (
      !this.map ||
      this.selectedLatitude === null ||
      this.selectedLongitude === null
    ) {
      return;
    }

    const coordinates: L.LatLngExpression = [
      this.selectedLatitude,
      this.selectedLongitude
    ];

    // Existing marker: move it instead
    // of creating a duplicate.
    if (this.locationMarker) {
      this.locationMarker.setLatLng(coordinates);

      this.locationMarker.setZIndexOffset(1000);

      return;
    }

    // Create visible SVG marker.
    this.locationMarker = L.marker(coordinates, {
      icon: this.createLocationIcon(),
      draggable: true,
      autoPan: true,
      zIndexOffset: 1000
    }).addTo(this.map);

    this.locationMarker.bindTooltip('Drag to adjust location', {
      direction: 'top',
      offset: [0, -45]
    });

    // When marker is dragged,
    // save the new coordinates.
    this.locationMarker.on('dragend', () => {
      if (
        !this.locationMarker ||
        this.loading ||
        this.uploadingPhoto ||
        this.submissionUncertain ||
        this.submittedReportId !== null
      ) {
        return;
      }

      const position = this.locationMarker.getLatLng();

      this.updateUI(() => {
        this.setSelectedLocation(position.lat, position.lng);

        this.locationMessage =
          'Location marker adjusted successfully.';
      });
    });

    console.log(
      'Map marker created:',
      this.selectedLatitude,
      this.selectedLongitude
    );
  }

  // =====================================
  // CLEAR SELECTED LOCATION
  // =====================================
  clearSelectedLocation() {
    if (
      this.loading ||
      this.uploadingPhoto ||
      this.submissionUncertain ||
      this.submittedReportId !== null
    ) {
      return;
    }

    // Invalidate an unfinished GPS request.
    this.locationRequestId++;

    this.gettingLocation = false;

    this.selectedLatitude = null;
    this.selectedLongitude = null;
    this.foundGpsVerified = false;
    this.updateLocationAddress();

    this.locationMessage = '';
    this.locationError = '';

    if (this.map && this.locationMarker) {
      this.map.removeLayer(this.locationMarker);

      this.locationMarker = null;
    }

    this.cdr.detectChanges();
  }

  // =====================================
  // DESTROY LEAFLET MAP
  // =====================================
  private destroyMap() {
    if (this.map) {
      this.map.off();
      this.map.remove();
      this.map = null;
    }

    this.locationMarker = null;

    this.mapReady = false;
  }

  // =====================================
  // TAKE PHOTO WITH NATIVE CAMERA
  // =====================================
  async takePhoto(): Promise<void> {
    if (
      this.destroyed ||
      this.cameraOpening ||
      this.loading ||
      this.uploadingPhoto ||
      this.submissionUncertain ||
      this.submittedReportId !== null
    ) {
      return;
    }

    if (this.remainingPhotoSlots === 0) {
      this.photoError = `You can add up to ${this.maxPhotos} photos per report.`;
      return;
    }

    if (!Capacitor.isNativePlatform()) {
      this.updateUI(() => {
        this.photoError =
          'Take Photo requires the installed PawRescue Android app. ' +
          'You can still choose a photo from your gallery.';
      });
      return;
    }

    // Update the button state inside Angular's zone before opening Camera.
    this.updateUI(() => {
      this.cameraOpening = true;
      this.photoError = '';
    });

    try {
      const captured = await Camera.takePhoto({
        quality: 75,
        cameraDirection: CameraDirection.Rear,
        targetWidth: 1600,
        targetHeight: 1600,
        saveToGallery: false
      });

      if (this.destroyed) return;

      if (!captured.webPath) {
        throw new Error('Camera returned no photo path.');
      }

      const response = await fetch(captured.webPath);

      if (!response.ok) {
        throw new Error('Cannot read the captured photo.');
      }

      const blob = await response.blob();

      const file = await this.compressCameraPhoto(blob);

      if (file.size === 0 || file.size > 5 * 1024 * 1024) {
        this.updateUI(() => {
          this.photoError =
            'Unable to reduce photo below 5 MB. Please try again.';
        });
        return;
      }

      this.updateUI(() => {
        if (
          this.loading ||
          this.uploadingPhoto ||
          this.submissionUncertain ||
          this.submittedReportId !== null
        ) {
          return;
        }

        if (this.remainingPhotoSlots === 0) {
          this.photoError =
            `You can add up to ${this.maxPhotos} photos per report.`;
          return;
        }

        this.addPhotoToSelection(file);
        this.photoError = '';
      });
    } catch (error: any) {
      const message = String(error?.message || '').toLowerCase();

      const code = String(error?.code || '').toLowerCase();

      if (!message.includes('cancel') && !code.includes('cancel')) {
        console.error('[PAWRESCUE CAMERA] Capture failed:', error);

        this.updateUI(() => {
          this.photoError =
            'Unable to take photo. Check camera permissions and try again.';
        });
      }
    } finally {
      // Capacitor Camera may complete outside Angular change detection.
      // Refresh the UI so the Take Another Photo button is enabled again.
      this.updateUI(() => {
        this.cameraOpening = false;
      });
    }
  }

  // =====================================
  // COMPRESS NATIVE CAMERA PHOTO BELOW 5 MB
  // =====================================
  private async compressCameraPhoto(blob: Blob): Promise<File> {
    const image = await createImageBitmap(blob);

    try {
      const maxDimension = 1280;

      const scale = Math.min(
        1,
        maxDimension / Math.max(image.width, image.height)
      );

      const canvas = document.createElement('canvas');

      canvas.width = Math.max(1, Math.round(image.width * scale));

      canvas.height = Math.max(1, Math.round(image.height * scale));

      const context = canvas.getContext('2d');

      if (!context) {
        throw new Error('Unable to process camera image.');
      }

      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      let compressed: Blob | null = null;

      for (const quality of [0.82, 0.7, 0.55]) {
        compressed = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob(resolve, 'image/jpeg', quality);
        });

        if (
          compressed &&
          compressed.size > 0 &&
          compressed.size <= 5 * 1024 * 1024
        ) {
          break;
        }
      }

      if (!compressed || compressed.size === 0) {
        throw new Error('Unable to compress the captured photo.');
      }

      console.log(
        '[PAWRESCUE CAMERA] Photo bytes:',
        blob.size,
        '->',
        compressed.size
      );

      return new File(
        [compressed],
        `pawrescue-camera-${Date.now()}.jpg`,
        { type: 'image/jpeg' }
      );
    } finally {
      image.close();
    }
  }

  // =====================================
  // ADD A PHOTO WITHOUT REPLACING PREVIOUS ONES
  // =====================================
  private addPhotoToSelection(file: File) {
    this.selectedPhotos.push({
      file,
      previewUrl: URL.createObjectURL(file),
      uploaded: false
    });

    this.photoUploaded = false;
    this.syncLegacyPhotoPreview();
  }

  // =====================================
  // KEEP EXISTING HTML WORKING
  // =====================================
  private syncLegacyPhotoPreview() {
    this.selectedPhoto = this.selectedPhotos[0]?.file ?? null;
    this.photoPreview = this.selectedPhotos[0]?.previewUrl ?? null;
  }

  // =====================================
  // SELECT MULTIPLE PET PHOTOS FROM GALLERY
  // =====================================
  onPhotoSelected(event: Event) {
    const input = event.target as HTMLInputElement;

    if (
      this.destroyed ||
      this.loading ||
      this.uploadingPhoto ||
      this.cameraOpening ||
      this.submissionUncertain ||
      this.submittedReportId !== null
    ) {
      input.value = '';
      return;
    }

    const files = Array.from(input.files ?? []);

    // Allows the same gallery selection to be opened again.
    input.value = '';

    if (files.length === 0) {
      return;
    }

    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/webp'
    ];

    const maxSize = 5 * 1024 * 1024;
    let invalidTypeCount = 0;
    let invalidSizeCount = 0;
    let duplicateCount = 0;
    let excessCount = 0;
    let addedCount = 0;

    for (const file of files) {
      if (!allowedTypes.includes(file.type)) {
        invalidTypeCount++;
        continue;
      }

      if (file.size === 0 || file.size > maxSize) {
        invalidSizeCount++;
        continue;
      }

      const alreadySelected = this.selectedPhotos.some((photo) =>
        photo.file.name === file.name &&
        photo.file.size === file.size &&
        photo.file.lastModified === file.lastModified
      );

      if (alreadySelected) {
        duplicateCount++;
        continue;
      }

      if (this.remainingPhotoSlots === 0) {
        excessCount++;
        continue;
      }

      this.addPhotoToSelection(file);
      addedCount++;
    }

    const warnings: string[] = [];

    if (invalidTypeCount > 0) {
      warnings.push('Only JPG, PNG, and WebP images are allowed.');
    }

    if (invalidSizeCount > 0) {
      warnings.push('Each photo must be 5 MB or smaller.');
    }

    if (duplicateCount > 0) {
      warnings.push('Duplicate selected photos were skipped.');
    }

    if (excessCount > 0) {
      warnings.push(`Maximum ${this.maxPhotos} photos per report.`);
    }

    this.photoError = warnings.join(' ');

    if (addedCount > 0) {
      console.log(
        '[PAWRESCUE PHOTOS] Added',
        addedCount,
        'photo(s). Total:',
        this.selectedPhotos.length
      );
    }

    this.cdr.detectChanges();
  }

  // =====================================
  // REMOVE ONE SELECTED PET PHOTO
  // =====================================
  // Optional index maintains compatibility with the old HTML's
  // removePhoto() call while the gallery HTML is being updated.
  removePhoto(index = 0) {
    if (
      this.destroyed ||
      this.loading ||
      this.uploadingPhoto ||
      this.cameraOpening ||
      this.submissionUncertain ||
      this.submittedReportId !== null
    ) {
      return;
    }

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.selectedPhotos.length
    ) {
      return;
    }

    const [removed] = this.selectedPhotos.splice(index, 1);
    URL.revokeObjectURL(removed.previewUrl);

    this.syncLegacyPhotoPreview();
    this.photoUploaded = false;
    this.photoError = '';

    this.cdr.detectChanges();
  }

  // =====================================
  // CLEAN UP ALL PHOTO PREVIEWS
  // =====================================
  private clearPhotoPreview() {
    for (const photo of this.selectedPhotos) {
      URL.revokeObjectURL(photo.previewUrl);
    }

    this.selectedPhotos = [];
    this.syncLegacyPhotoPreview();
  }

  // =====================================
  // SUBMIT PET REPORT
  // =====================================
  submitReport() {
    // Enter can submit a form from an earlier step. Never send an
    // incomplete report to the API before the review step.
    if (this.formStep !== 3) {
      this.nextStep();
      return;
    }
    if (
      this.loading ||
      this.uploadingPhoto ||
      this.cameraOpening ||
      this.submittedReportId !== null ||
      this.submissionUncertain
    ) {
      return;
    }

    this.errorMessage = '';
    this.successMessage = '';
    this.photoError = '';

    this.updateLocationAddress();

    const data: CreatePetReportRequest = {
      report_type: this.form.report_type,
      animal_type: this.form.animal_type,
      pet_name: this.form.pet_name.trim() || null,
      description: this.form.description.trim(),
      incident_date: this.form.incident_date,
      location_address: this.form.location_address.trim(),
      latitude: this.selectedLatitude,
      longitude: this.selectedLongitude
    };

    // =====================================
    // VALIDATE REQUIRED FIELDS
    // =====================================
    if (
      !data.description ||
      !data.incident_date ||
      (this.form.report_type === 'lost' && !this.selectedBarangay.trim()) ||
      (this.form.report_type === 'found' &&
        (!this.foundGpsVerified || data.latitude === null || data.longitude === null)) ||
      !data.location_address
    ) {
      this.errorMessage = 'Please complete all required fields.';
      return;
    }

    // =====================================
    // VALIDATE TEXT LENGTH
    // =====================================
    if (
      data.description.length > 5000 ||
      data.location_address.length > 255 ||
      (data.pet_name && data.pet_name.length > 100)
    ) {
      this.errorMessage = 'One or more fields are too long.';
      return;
    }

    // =====================================
    // VALIDATE INCIDENT DATE
    // =====================================
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(data.incident_date) ||
      data.incident_date > this.today
    ) {
      this.errorMessage = 'Please select a valid incident date.';
      return;
    }

    // =====================================
    // SEND REPORT TO PHP API
    // =====================================
    this.loading = true;

    this.cdr.detectChanges();

    const startTime = performance.now();

    console.log('Submitting pet report...');

    this.submitRequest = this.reportsService
      .createReport(data)
      .pipe(
        timeout(20000),
        finalize(() => {
          const elapsed = Math.round(performance.now() - startTime);

          console.log(
            'Create report request finished in',
            elapsed,
            'ms'
          );

          this.updateUI(() => {
            this.loading = false;
          });
        })
      )
      .subscribe({
        next: (response) => {
          this.updateUI(() => {
            if (
              response.success &&
              Number(response.report_id) > 0
            ) {
              this.submittedReportId = Number(response.report_id);

              this.successMessage =
                'Pet report submitted successfully!';

              this.errorMessage = '';

              console.log(
                'Report saved successfully. ID:',
                this.submittedReportId
              );
            } else {
              this.errorMessage =
                response.message || 'Unable to submit report.';
            }
          });

          // Upload all selected photos after confirmed
          // report creation, one photo per API request.
          if (
            this.submittedReportId !== null &&
            this.selectedPhotos.length > 0
          ) {
            this.uploadSelectedPhoto();
          }
        },

        error: (error) => {
          console.error('Pet report submission error:', error);

          this.updateUI(() => {
            if (error.name === 'TimeoutError') {
              this.submissionUncertain = true;

              this.errorMessage =
                'The request took too long. ' +
                'Your report may already have been saved. ' +
                'Please check existing reports first.';
            } else if (error.status === 401) {
              this.errorMessage =
                'Your session has expired. Please log in again.';
            } else if (error.status === 400) {
              this.errorMessage =
                error.error?.message || 'Invalid report information.';
            } else if (error.status === 0) {
              this.submissionUncertain = true;

              this.errorMessage =
                'Connection to the server was interrupted. ' +
                'Your report may already be saved. ' +
                'Please check existing reports first.';
            } else {
              this.submissionUncertain = true;

              this.errorMessage =
                error.error?.message ||
                'Unable to confirm the submission. ' +
                'Please check existing reports.';
            }
          });
        }
      });
  }

  // =====================================
  // UPLOAD SELECTED PET PHOTOS SEQUENTIALLY
  // =====================================
  // Retained the method name for compatibility with existing HTML.
  uploadSelectedPhoto() {
    if (
      this.destroyed ||
      this.submittedReportId === null ||
      this.selectedPhotos.length === 0 ||
      this.uploadingPhoto ||
      this.photoUploaded ||
      this.photoUploadUncertain
    ) {
      return;
    }

    const pendingPhotos = this.selectedPhotos.filter(
      (photo) => !photo.uploaded
    );

    if (pendingPhotos.length === 0) {
      this.photoUploaded = true;
      return;
    }

    const reportId = this.submittedReportId;

    this.uploadingPhoto = true;
    this.photoError = '';
    this.uploadedPhotosCount = this.selectedPhotos.filter(
      (photo) => photo.uploaded
    ).length;
    this.currentPhotoNumber = this.uploadedPhotosCount + 1;

    this.cdr.detectChanges();

    const startTime = performance.now();

    console.log(
      '[PAWRESCUE PHOTOS] Uploading',
      pendingPhotos.length,
      'photo(s)...'
    );

    // Each upload uses the existing authenticated upload_photo.php.
    // The updated backend appends a row to pet_report_photos.
    this.photoRequest = from(pendingPhotos)
      .pipe(
        concatMap((photo) => {
          this.updateUI(() => {
            this.currentPhotoNumber =
              this.selectedPhotos.filter((item) => item.uploaded).length + 1;
          });

          return this.reportsService
            .uploadPhoto(reportId, photo.file)
            .pipe(
              timeout(30000),
              map((response) => {
                if (!response.success) {
                  throw new Error(
                    response.message || 'Photo upload failed.'
                  );
                }

                return { photo, response };
              })
            );
        }),
        finalize(() => {
          const elapsed = Math.round(performance.now() - startTime);

          console.log(
            '[PAWRESCUE PHOTOS] Upload session finished in',
            elapsed,
            'ms'
          );

          this.updateUI(() => {
            this.uploadingPhoto = false;
          });
        })
      )
      .subscribe({
        next: ({ photo, response }) => {
          this.updateUI(() => {
            photo.uploaded = true;

            this.uploadedPhotosCount = this.selectedPhotos.filter(
              (item) => item.uploaded
            ).length;

            this.photoError = '';
            this.photoUploaded = this.selectedPhotos.every(
              (item) => item.uploaded
            );

            this.successMessage = this.photoUploaded
              ? `Pet report and ${this.uploadedPhotosCount} photo(s) submitted successfully!`
              : `Pet report saved. Uploading photos (${this.uploadedPhotosCount}/${this.selectedPhotos.length})...`;
          });

          console.log(
            '[PAWRESCUE PHOTOS] Uploaded:',
            response.photo_path
          );
        },

        error: (error) => {
          console.error('[PAWRESCUE PHOTOS] Upload failed:', error);

          this.updateUI(() => {
            const isUncertain =
              error?.name === 'TimeoutError' ||
              error?.status === 0 ||
              (typeof error?.status === 'number' && error.status >= 500);

            this.photoUploadUncertain = isUncertain;
            this.photoUploaded = false;

            this.uploadedPhotosCount = this.selectedPhotos.filter(
              (photo) => photo.uploaded
            ).length;

            this.successMessage =
              `Pet report saved. ${this.uploadedPhotosCount} of ` +
              `${this.selectedPhotos.length} photo(s) confirmed uploaded.`;

            if (isUncertain) {
              this.photoError =
                'The latest photo may already have been saved. ' +
                'Check My Reports before trying again to avoid duplicate photos.';
            } else if (error?.status === 401) {
              this.photoError =
                'Session expired. Please log in again.';
            } else if (error?.status === 413) {
              this.photoError =
                'Photo is too large. Maximum size is 5 MB.';
            } else {
              this.photoError =
                error?.error?.message ||
                error?.message ||
                'Unable to upload one of the photos. ' +
                'The report and previously uploaded photos are saved.';
            }
          });
        }
      });
  }

  // =====================================
  // NAVIGATION
  // =====================================
  goBack() {
    if (this.loading || this.uploadingPhoto) {
      return;
    }

    this.locationRequestId++;
    this.gettingLocation = false;
    this.showMap = false;

    this.destroyMap();

    void this.router.navigateByUrl('/lost-found').then((navigated) => {
      if (navigated && !this.destroyed) this.resetForNewReport();
    });
  }

  viewReports() {
    if (this.loading || this.uploadingPhoto) {
      return;
    }

    this.locationRequestId++;
    this.gettingLocation = false;
    this.showMap = false;

    this.destroyMap();

    void this.router.navigateByUrl('/my-reports').then((navigated) => {
      if (navigated && !this.destroyed) this.resetForNewReport();
    });
  }

  // =====================================
  // PAGE CLEANUP
  // =====================================
  ngOnDestroy() {
    this.destroyed = true;

    this.locationRequestId++;

    this.submitRequest?.unsubscribe();
    this.photoRequest?.unsubscribe();

    this.destroyMap();
    this.clearPhotoPreview();
  }
}