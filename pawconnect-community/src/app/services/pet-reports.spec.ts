import { TestBed } from '@angular/core/testing';
import { PetReports } from './pet-reports';

describe('PetReports', () => {
  let service: PetReports;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PetReports);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
