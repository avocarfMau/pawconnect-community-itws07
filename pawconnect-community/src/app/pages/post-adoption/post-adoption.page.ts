import {
  Component,
  OnDestroy,
  inject,
  ChangeDetectorRef,
  NgZone
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonContent,
  IonIcon,
  IonButton,
  IonSpinner,
  IonToolbar, 
  IonHeader
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  pawOutline,
  cameraOutline,
  imagesOutline,
  closeCircleOutline,
  informationCircleOutline,
  checkmarkCircleOutline
} from 'ionicons/icons';
import { Camera, CameraDirection } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import {
  Subscription,
  timeout,
  finalize,
  from,
  concatMap,
  switchMap,
  map
} from 'rxjs';
import {
  PetAdoptionService,
  NewAdoptionPost
} from '../../services/pet-adoption';
import { HapticsService } from '../../services/haptics.service';

// =====================================
// PAWRESCUE COMMUNITY
// POST A PET FOR ADOPTION
// =====================================
// Fast, safe submission flow:
// 1. Optimize large gallery photos when the resident selects them, not after submit.
// 2. Save the listing once and immediately show its confirmed success state.
// 3. Upload smaller photos in their selected order (first photo stays the cover).
// Camera photos remain compressed. Do not auto-retry uncertain uploads.

interface SelectedPhoto {
  file: File;
  preview: string;
  uploaded: boolean;
  // Retain the original identity when the upload file is recompressed.
  sourceKey?: string;
  // Each photo is ready before its individual HTTP upload starts.
  ready?: Promise<void>;
}

@Component({
  selector: 'app-post-adoption',
  templateUrl: './post-adoption.page.html',
  styleUrls: ['./post-adoption.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonContent,
    IonIcon,
    IonButton,
    IonSpinner,
    IonToolbar, 
    IonHeader
  ]
})
export class PostAdoptionPage implements OnDestroy {
  private readonly adoption = inject(PetAdoptionService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly haptics = inject(HapticsService);

  private submitRequest?: Subscription;
  private photoRequest?: Subscription;
  private destroyed = false;
  // Serialize image processing to avoid decoding 10 large images at once.
  private photoPreparationQueue: Promise<void> = Promise.resolve();

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

  readonly maxPhotos = 10;
  selectedPhotos: SelectedPhoto[] = [];

  model = {
    pet_name: '',
    animal_type: 'dog' as 'dog' | 'cat',
    sex: 'unknown' as 'male' | 'female' | 'unknown',
    age_months: null as number | null,
    breed: '',
    description: '',
    health_notes: '',
    barangay: '',
    location_details: ''
  };

  cameraOpening = false;
  saving = false;
  uploading = false;
  uploadPosition = 0;
  uploadedCount = 0;
  photoUploaded = false;
  photoUploadUncertain = false;
  createdId: number | null = null;
  submissionUncertain = false;
  errorMessage = '';
  photoError = '';
  successMessage = '';

  // Three-step adoption listing wizard (presentation only; API unchanged).
  formStep: 1 | 2 | 3 = 1;
  stepError = '';

  constructor() {
    addIcons({
      arrowBackOutline,
      pawOutline,
      cameraOutline,
      imagesOutline,
      closeCircleOutline,
      informationCircleOutline,
      checkmarkCircleOutline
    });
  }

  private get isLocked(): boolean {
    return (
      this.destroyed ||
      this.saving ||
      this.uploading ||
      this.cameraOpening ||
      this.createdId !== null ||
      this.submissionUncertain
    );
  }

  // Capacitor callbacks may finish outside Angular change detection.
  private updateUI(callback: () => void): void {
    if (this.destroyed) return;
    this.zone.run(() => {
      if (this.destroyed) return;
      callback();
      this.cdr.detectChanges();
    });
  }

  // =====================================
  // ADOPTION LISTING WIZARD
  // =====================================
  private validateWizardStep(step: 1 | 2 | 3): string {
    if (step === 1) {
      if (!this.model.pet_name.trim()) return 'Please enter the pet name.';
      if (this.model.pet_name.trim().length > 100) return 'Pet name is too long.';
      if (!['dog', 'cat'].includes(this.model.animal_type)) return 'Please select an animal type.';
      if (!this.model.description.trim()) return 'Please enter a pet description.';
      if (this.model.description.trim().length > 5000) return 'Description is too long.';
      if (this.model.breed.length > 120 || this.model.health_notes.length > 3000) {
        return 'One or more pet details are too long.';
      }
      const age = this.model.age_months;
      if (age !== null && (!Number.isInteger(Number(age)) || Number(age) < 0 || Number(age) > 600)) {
        return 'Please select a valid approximate age.';
      }
    }
    if (step === 2) {
      if (!this.barangays.includes(this.model.barangay)) return 'Please select a barangay.';
      if (this.model.location_details.length > 255) return 'Nearby landmark is too long.';
    }
    return '';
  }

  nextStep(): void {
    if (this.isLocked || this.formStep >= 3) return;
    const error = this.validateWizardStep(this.formStep);
    if (error) {
      this.stepError = error;
      void this.haptics.error();
      return;
    }
    this.stepError = '';
    this.errorMessage = '';
    this.formStep = (this.formStep + 1) as 1 | 2 | 3;
    void this.haptics.light();
  }

  previousStep(): void {
    if (this.isLocked || this.formStep <= 1) return;
    this.stepError = '';
    this.errorMessage = '';
    this.formStep = (this.formStep - 1) as 1 | 2 | 3;
    void this.haptics.light();
  }

  // =====================================
  // GALLERY PHOTO SELECTION
  // =====================================
  // Large gallery images are optimized in advance, while the user finishes
  // the form. The backend still accepts a normal JPG/PNG/WebP File <= 5 MB.
  // Smaller originals and any failed conversions remain unchanged.
  onPhotosSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';

    if (this.isLocked) return;
    if (files.length > 0) void this.haptics.light();

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    const maxSize = 5 * 1024 * 1024;
    let invalidType = 0;
    let invalidSize = 0;
    let duplicate = 0;
    let excessive = 0;

    for (const file of files) {
      if (!allowedTypes.includes(file.type)) {
        invalidType++;
        continue;
      }

      if (file.size < 1 || file.size > maxSize) {
        invalidSize++;
        continue;
      }

      const sourceKey = `${file.name}|${file.size}|${file.lastModified}`;
      if (this.selectedPhotos.some(photo => photo.sourceKey === sourceKey)) {
        duplicate++;
        continue;
      }

      if (this.selectedPhotos.length >= this.maxPhotos) {
        excessive++;
        continue;
      }

      const photo: SelectedPhoto = {
        file,
        preview: URL.createObjectURL(file),
        uploaded: false,
        sourceKey
      };
      this.selectedPhotos.push(photo);

      // Queue just the optimization: it never creates an adoption post.
      // A photo may still be preparing if the resident submits immediately.
      // The upload pipeline awaits only that photo's preparation promise.
      const preparation = this.photoPreparationQueue
        .then(() => this.optimizeGalleryPhoto(photo))
        .catch(error => {
          // Preserve the original validated photo if optimization fails.
          console.warn('[PAWRESCUE ADOPTION] Using original gallery photo:', error);
        });
      photo.ready = preparation;
      this.photoPreparationQueue = preparation;
    }

    const messages: string[] = [];
    if (invalidType) messages.push('Only JPG, PNG, and WebP images are allowed.');
    if (invalidSize) messages.push('Each photo must be 5 MB or smaller.');
    if (duplicate) messages.push('Duplicate selected photos were skipped.');
    if (excessive) messages.push('Maximum of 10 photos per adoption post.');

    this.photoError = messages.join(' ');
    if (messages.length > 0) void this.haptics.error();
    this.cdr.detectChanges();
  }

  // Optimize ahead of submission, rather than uploading full-resolution
  // 3-5 MB gallery photos on a slower network connection.
  private async optimizeGalleryPhoto(photo: SelectedPhoto): Promise<void> {
    if (this.destroyed || !this.selectedPhotos.includes(photo)) return;

    const original = photo.file;
    // Already-small files are unlikely to benefit enough from re-encoding.
    if (original.size <= 256 * 1024) return;

    const bitmap = await createImageBitmap(original);
    let optimized: Blob | null = null;

    try {
      const maxDimension = 1280;
      const scale = Math.min(
        1,
        maxDimension / Math.max(bitmap.width, bitmap.height)
      );
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));

      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image conversion is not supported.');

      // White background avoids black fill in transparent PNG/WebP images.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      optimized = await new Promise<Blob | null>(resolve => {
        canvas.toBlob(resolve, 'image/jpeg', 0.78);
      });
    } finally {
      bitmap.close();
    }

    if (
      this.destroyed ||
      !this.selectedPhotos.includes(photo) ||
      !optimized ||
      optimized.size < 1 ||
      optimized.size >= original.size ||
      optimized.size > 5 * 1024 * 1024
    ) {
      return;
    }

    const newName = original.name.replace(/\.[^.]+$/, '') + '-optimized.jpg';
    const newFile = new File([optimized], newName, { type: 'image/jpeg' });
    const newPreview = URL.createObjectURL(newFile);

    this.updateUI(() => {
      if (!this.selectedPhotos.includes(photo)) {
        URL.revokeObjectURL(newPreview);
        return;
      }
      const previousPreview = photo.preview;
      photo.file = newFile;
      photo.preview = newPreview;
      URL.revokeObjectURL(previousPreview);
    });

    console.log(
      '[PAWRESCUE ADOPTION] Gallery photo optimized:',
      original.size, '->', newFile.size, 'bytes'
    );
  }

  // =====================================
  // NATIVE CAMERA
  // =====================================
  async takePhoto(): Promise<void> {
    if (this.isLocked) return;

    if (this.selectedPhotos.length >= this.maxPhotos) {
      this.photoError = 'Maximum of 10 photos per adoption post.';
      void this.haptics.error();
      return;
    }

    if (!Capacitor.isNativePlatform()) {
      this.photoError =
        'Camera capture is available in the Android app. Use Choose Photos in the browser.';
      return;
    }

    void this.haptics.light();
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

      if (!captured.webPath) {
        throw new Error('Camera did not return an image.');
      }

      const response = await fetch(captured.webPath);
      if (!response.ok) {
        throw new Error('Unable to read camera image.');
      }

      const file = await this.compressCameraPhoto(await response.blob());
      if (this.destroyed) return;
      if (file.size < 1 || file.size > 5 * 1024 * 1024) {
        throw new Error('Camera photo exceeds 5 MB.');
      }

      this.updateUI(() => {
        if (this.createdId !== null || this.saving || this.uploading) return;
        if (this.selectedPhotos.length >= this.maxPhotos) {
          this.photoError = 'Maximum of 10 photos per adoption post.';
          return;
        }

        void this.haptics.success();
        this.selectedPhotos.push({
          file,
          preview: URL.createObjectURL(file),
          uploaded: false
        });
      });
    } catch (error: any) {
      const message = String(error?.message || '').toLowerCase();
      const code = String(error?.code || '').toLowerCase();
      if (!message.includes('cancel') && !code.includes('cancel')) {
        this.updateUI(() => {
          this.photoError =
            'Unable to capture photo. Check camera permission and try again.';
          void this.haptics.error();
        });
      }
    } finally {
      this.updateUI(() => {
        this.cameraOpening = false;
      });
    }
  }

  // Camera images are resized once, as in the Report Pet camera flow.
  private async compressCameraPhoto(blob: Blob): Promise<File> {
    const bitmap = await createImageBitmap(blob);

    try {
      const scale = Math.min(
        1,
        1280 / Math.max(bitmap.width, bitmap.height)
      );
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));

      const context = canvas.getContext('2d');
      if (!context) throw new Error('Unable to process camera image.');

      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      let result: Blob | null = null;
      for (const quality of [0.82, 0.7, 0.55]) {
        result = await new Promise<Blob | null>(resolve => {
          canvas.toBlob(resolve, 'image/jpeg', quality);
        });
        if (result && result.size > 0 && result.size <= 5 * 1024 * 1024) {
          break;
        }
      }

      if (!result || result.size < 1 || result.size > 5 * 1024 * 1024) {
        throw new Error('Unable to compress camera image below 5 MB.');
      }

      return new File(
        [result],
        `adoption-camera-${Date.now()}.jpg`,
        { type: 'image/jpeg' }
      );
    } finally {
      bitmap.close();
    }
  }

  removePhoto(index: number): void {
    if (this.isLocked) return;
    if (!Number.isInteger(index) || index < 0 || index >= this.selectedPhotos.length) {
      return;
    }

    const [removed] = this.selectedPhotos.splice(index, 1);
    URL.revokeObjectURL(removed.preview);
    this.photoError = '';
    void this.haptics.light();
  }

  // =====================================
  // CREATE ADOPTION POST
  // =====================================
  submitPost(): void {
    if (this.isLocked) return;
    // Prevent publishing before all wizard steps have been reviewed.
    if (this.formStep !== 3) {
      this.stepError = 'Complete all steps before publishing.';
      void this.haptics.error();
      return;
    }
    for (const step of [1, 2] as const) {
      const error = this.validateWizardStep(step);
      if (error) {
        this.formStep = step;
        this.stepError = error;
        void this.haptics.error();
        return;
      }
    }
    this.stepError = '';

    this.errorMessage = '';
    this.photoError = '';
    this.successMessage = '';

    const rawAge: unknown = this.model.age_months;
    const age = rawAge === null || rawAge === undefined || rawAge === ''
      ? null
      : Number(rawAge);

    const data: NewAdoptionPost = {
      pet_name: this.model.pet_name.trim(),
      animal_type: this.model.animal_type,
      sex: this.model.sex,
      age_months: age,
      breed: this.model.breed.trim() || null,
      description: this.model.description.trim(),
      health_notes: this.model.health_notes.trim() || null,
      barangay: this.model.barangay,
      location_details: this.model.location_details.trim() || null
    };

    if (!data.pet_name || !data.description || !this.barangays.includes(data.barangay)) {
      this.errorMessage = 'Please complete all required fields.';
      void this.haptics.error();
      return;
    }

    if (age !== null && (!Number.isInteger(age) || age < 0 || age > 600)) {
      this.errorMessage = 'Age must be between 0 and 600 months.';
      void this.haptics.error();
      return;
    }

    if (
      data.pet_name.length > 100 ||
      data.description.length > 5000 ||
      (data.breed?.length || 0) > 120 ||
      (data.health_notes?.length || 0) > 3000 ||
      (data.location_details?.length || 0) > 255
    ) {
      this.errorMessage = 'One or more fields are too long.';
      void this.haptics.error();
      return;
    }

    void this.haptics.medium();
    this.updateUI(() => {
      this.saving = true;
    });

    const start = performance.now();
    this.submitRequest = this.adoption
      .createPost(data)
      .pipe(
        timeout(20000),
        finalize(() => {
          console.log(
            '[PAWRESCUE ADOPTION] Create post completed in',
            Math.round(performance.now() - start),
            'ms'
          );
          this.updateUI(() => {
            this.saving = false;
          });
        })
      )
      .subscribe({
        next: response => {
          const id = Number(response.adoption_id);
          if (!response.success || !Number.isSafeInteger(id) || id < 1) {
            this.updateUI(() => {
              // A success response without an ID might still mean the
              // post was created; do not submit a second copy blindly.
              if (response.success) this.submissionUncertain = true;
              this.errorMessage = response.message ||
                'Unable to confirm adoption post creation. Check My Adoptions.';
            });
            void this.haptics.error();
            return;
          }

          void this.haptics.success();
          this.updateUI(() => {
            this.createdId = id;
            this.errorMessage = '';
            this.successMessage = this.selectedPhotos.length > 0
              ? 'Adoption post saved successfully! Uploading selected photos...'
              : 'Adoption post submitted successfully!';
          });

          // Do not wait for photo uploads before showing the saved state.
          if (this.selectedPhotos.length > 0) {
            this.uploadSelectedPhotos();
          }
        },
        error: error => {
          void this.haptics.error();
          this.updateUI(() => {
            if (error?.status === 401) {
              this.errorMessage = 'Session expired. Please log in again.';
            } else if ([400, 403, 413, 415, 422].includes(error?.status)) {
              this.errorMessage = error?.error?.message ||
                'Invalid adoption post information.';
            } else {
              // A timeout/network/server error can occur after a successful insert.
              this.submissionUncertain = true;
              this.errorMessage =
                'Unable to confirm your adoption post. Check My Adoptions before submitting again to avoid duplicates.';
            }
          });
        }
      });
  }

  // =====================================
  // UPLOAD PHOTOS (PRE-OPTIMIZED, ORIGINAL SELECTION ORDER)
  // =====================================
  // Resume only photos that did NOT receive confirmed success.
  // Never retry a timeout or uncertain upload automatically.
  uploadSelectedPhotos(): void {
    if (
      this.destroyed ||
      this.createdId === null ||
      this.selectedPhotos.length === 0 ||
      this.uploading ||
      this.photoUploaded ||
      this.photoUploadUncertain
    ) {
      return;
    }

    const pending = this.selectedPhotos.filter(photo => !photo.uploaded);
    if (pending.length === 0) {
      this.updateUI(() => { this.photoUploaded = true; });
      return;
    }

    const adoptionId = this.createdId;
    this.updateUI(() => {
      this.uploading = true;
      this.photoError = '';
      this.uploadedCount = this.selectedPhotos.filter(photo => photo.uploaded).length;
      this.uploadPosition = this.uploadedCount + 1;
    });

    const start = performance.now();
    this.photoRequest = from(pending)
      .pipe(
        concatMap(photo => {
          this.updateUI(() => {
            this.uploadPosition = this.selectedPhotos.indexOf(photo) + 1;
          });

          // Await any unfinished background optimization for THIS photo.
          // Upload sequentially: PHP assigns photo sort_order by arrival,
          // so parallel requests could unexpectedly change the cover photo.
          return from(photo.ready ?? Promise.resolve()).pipe(
            switchMap(() => this.adoption.uploadPhoto(adoptionId, photo.file).pipe(
              // Start the HTTP timeout when the network request begins,
              // not while the selected image is still being optimized.
              timeout(30000),
              map(response => {
                if (!response.success) {
                  throw new Error(response.message || 'Photo upload failed.');
                }
                return { photo, response };
              })
            ))
          );
        }),
        finalize(() => {
          console.log(
            '[PAWRESCUE ADOPTION] Upload session completed in',
            Math.round(performance.now() - start),
            'ms'
          );
          this.updateUI(() => {
            this.uploading = false;
          });
        })
      )
      .subscribe({
        next: ({ photo, response }) => {
          this.updateUI(() => {
            photo.uploaded = true;
            this.uploadedCount = this.selectedPhotos.filter(item => item.uploaded).length;
            this.photoUploaded = this.selectedPhotos.every(item => item.uploaded);
            if (this.photoUploaded) void this.haptics.success();
            this.photoError = '';
            this.successMessage = this.photoUploaded
              ? `Pet adoption post and ${this.uploadedCount} photo(s) submitted successfully!`
              : `Adoption post saved. Uploading photos (${this.uploadedCount}/${this.selectedPhotos.length})...`;
          });
          console.log('[PAWRESCUE ADOPTION] Photo uploaded:', response.photo_path);
        },
        error: error => {
          void this.haptics.error();
          this.updateUI(() => {
            const uncertain = error?.name === 'TimeoutError' ||
              error?.status === 0 ||
              (typeof error?.status === 'number' && error.status >= 500);

            this.photoUploadUncertain = uncertain;
            this.photoUploaded = false;
            this.uploadedCount = this.selectedPhotos.filter(photo => photo.uploaded).length;
            this.successMessage =
              `Adoption post saved. ${this.uploadedCount} of ${this.selectedPhotos.length} photo(s) confirmed uploaded.`;

            if (uncertain) {
              this.photoError =
                'The latest photo may already have been saved. Check My Adoptions before trying again to avoid duplicate photos.';
            } else if (error?.status === 401) {
              this.photoError = 'Session expired. Please log in again.';
            } else if (error?.status === 413) {
              this.photoError = 'Photo is too large. Maximum size is 5 MB.';
            } else {
              this.photoError = error?.error?.message || error?.message ||
                'Unable to upload a photo. Your post and confirmed photos are already saved.';
            }
          });
        }
      });
  }

  goBack(): void {
    if (!this.saving && !this.uploading) {
      void this.haptics.light();
      this.router.navigateByUrl('/pet-adoption');
    }
  }

  viewMyAdoptions(): void {
    if (!this.saving && !this.uploading) {
      void this.haptics.light();
      this.router.navigateByUrl('/my-adoptions');
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.submitRequest?.unsubscribe();
    this.photoRequest?.unsubscribe();

    for (const photo of this.selectedPhotos) {
      URL.revokeObjectURL(photo.preview);
    }
  }
}
