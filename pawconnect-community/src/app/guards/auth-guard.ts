
import { inject } from '@angular/core';
import {
  CanActivateFn,
  Router
} from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { AuthService } from '../services/auth';

// Resident-only guard
export const residentGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.verifySession('resident').pipe(
    map(valid =>
      valid ? true : router.createUrlTree(['/login'])
    ),
    catchError(() =>
      of(router.createUrlTree(['/login']))
    )
  );
};

// Staff-only guard
export const staffGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.verifySession('staff').pipe(
    map(valid =>
      valid ? true : router.createUrlTree(['/login'])
    ),
    catchError(() =>
      of(router.createUrlTree(['/login']))
    )
  );
};
