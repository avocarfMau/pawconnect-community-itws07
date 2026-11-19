import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { HapticsService } from '../services/haptics.service';

import {
  IonContent,
  IonIcon
} from '@ionic/angular';

import { addIcons } from 'ionicons';

import {
  paw,
  searchOutline,
  heartOutline,
  personCircleOutline,
  documentTextOutline,
  homeOutline,
  arrowForwardOutline,
  notificationsOutline
} from 'ionicons/icons';

@Component({
  selector: 'app-home',
  templateUrl: './home.page.html',
  styleUrls: ['./home.page.scss'],
  standalone: true,
  imports: [
    IonContent,
    IonIcon
  ]
})
export class HomePage {

  constructor(
    private router: Router,
    private haptics: HapticsService
  ) {
    addIcons({
      paw,
      searchOutline,
      heartOutline,
          personCircleOutline,
      documentTextOutline,
      homeOutline,
      arrowForwardOutline,
      notificationsOutline
    });
  }

  // =====================================
  // LOST AND FOUND AND PET ADOPTION
  // =====================================

  openFeature(feature: string): void {

    // LOST AND FOUND PETS
    if (feature === 'lost-found') {
      void this.haptics.light();
      this.router.navigateByUrl('/lost-found');
      return;
    }

    // PET ADOPTION COMMUNITY
    if (feature === 'adoption') {
      void this.haptics.light();
      this.router.navigateByUrl('/pet-adoption');
      return;
    }

    console.log('Unknown feature:', feature);
  }

  // =====================================
  // NOTIFICATIONS
  // =====================================

  openNotifications(): void {
    void this.haptics.light();
    this.router.navigateByUrl('/notifications');
  }

  // =====================================
  // MY ACCOUNT
  // =====================================

  openAccount(): void {
    void this.haptics.light();
    this.router.navigateByUrl('/my-account');
  }

  // =====================================
  // MY REPORTS
  // =====================================

  openReports(): void {
    void this.haptics.light();
    this.router.navigateByUrl('/my-reports');
  }
}
