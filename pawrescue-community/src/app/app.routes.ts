import { Routes } from '@angular/router';

import { residentGuard, staffGuard } from './guards/auth-guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'login',
    pathMatch: 'full',
  },

  {
    path: 'login',
    loadComponent: () => import('./pages/login/login.page').then((m) => m.LoginPage),
  },

  {
    path: 'register',
    loadComponent: () => import('./pages/register/register.page').then((m) => m.RegisterPage),
  },

  {
    path: 'home',
    loadComponent: () => import('./home/home.page').then((m) => m.HomePage),
    canActivate: [residentGuard],
  },

  // =====================================
  // RESIDENT ACTIVITY NOTIFICATIONS
  // =====================================
  {
    path: 'notifications',
    loadComponent: () => import('./pages/notifications/notifications.page').then((m) => m.NotificationsPage),
    canActivate: [residentGuard],
  },

  // =====================================
  // LOST AND FOUND PETS
  // =====================================
  {
    path: 'lost-found',
    loadComponent: () => import('./pages/lost-found/lost-found.page').then((m) => m.LostFoundPage),
    canActivate: [residentGuard],
  },

  {
    path: 'report-pet',
    loadComponent: () => import('./pages/report-pet/report-pet.page').then((m) => m.ReportPetPage),
    canActivate: [residentGuard],
  },

  {
    path: 'my-reports',
    loadComponent: () => import('./pages/my-reports/my-reports.page').then((m) => m.MyReportsPage),
    canActivate: [residentGuard],
  },

  // =====================================
  // OWNERSHIP CLAIMS AND PET RECOVERIES
  // =====================================
  {
    path: 'my-claims',
    loadComponent: () => import('./pages/my-claims/my-claims.page').then((m) => m.MyClaimsPage),
    canActivate: [residentGuard],
  },

  {
    path: 'my-recoveries',
    loadComponent: () => import('./pages/my-recoveries/my-recoveries.page').then((m) => m.MyRecoveriesPage),
    canActivate: [residentGuard],
  },

  {
    path: 'edit-report/:id',
    loadComponent: () => import('./pages/edit-report/edit-report.page').then((m) => m.EditReportPage),
    canActivate: [residentGuard],
  },

  // =====================================
  // PET ADOPTION COMMUNITY
  // =====================================
  {
    path: 'pet-adoption',
    loadComponent: () => import('./pages/pet-adoption/pet-adoption.page').then((m) => m.PetAdoptionPage),
    canActivate: [residentGuard],
  },

  {
    path: 'post-adoption',
    loadComponent: () => import('./pages/post-adoption/post-adoption.page').then((m) => m.PostAdoptionPage),
    canActivate: [residentGuard],
  },

  {
    path: 'my-adoptions',
    loadComponent: () => import('./pages/my-adoptions/my-adoptions.page').then((m) => m.MyAdoptionsPage),
    canActivate: [residentGuard],
  },

  {
    path: 'adoption-details/:id',
    loadComponent: () => import('./pages/adoption-details/adoption-details.page').then((m) => m.AdoptionDetailsPage),
    canActivate: [residentGuard],
  },

  // =====================================
  // MY ACCOUNT
  // =====================================
  {
    path: 'my-account',
    loadComponent: () => import('./pages/my-account/my-account.page').then((m) => m.MyAccountPage),
    canActivate: [residentGuard],
  },

  // =====================================
  // MUNICIPAL VETERINARY OFFICE — STAFF ONLY
  // =====================================
  {
    path: 'staff-dashboard',
    loadComponent: () =>
      import('./pages/staff-dashboard/staff-dashboard.page').then((m) => m.StaffDashboardPage),
    canActivate: [staffGuard],
  },

  // =====================================
  // ANIMAL ASSISTANCE MANAGEMENT — STAFF ONLY
  // =====================================
  {
    path: 'staff-animal-assistance',
    loadComponent: () =>
      import('./pages/staff-animal-assistance/staff-animal-assistance.page')
        .then((m) => m.StaffAnimalAssistancePage),
    canActivate: [staffGuard],
  },

  // =====================================
  // ANIMAL ASSISTANCE CASE DETAILS — STAFF ONLY
  // =====================================
  {
    path: 'staff-animal-assistance/:id',
    loadComponent: () =>
      import('./pages/staff-assistance-details/staff-assistance-details.page')
        .then((m) => m.StaffAssistanceDetailsPage),
    canActivate: [staffGuard],
  },

  // Keep the wildcard route at the very end.
  {
    path: '**',
    redirectTo: 'login',
  },
];
