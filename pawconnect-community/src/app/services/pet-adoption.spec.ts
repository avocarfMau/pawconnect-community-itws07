import { TestBed } from '@angular/core/testing';
import { PetAdoption } from './pet-adoption';

describe('PetAdoption', () => {
  let service: PetAdoption;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PetAdoption);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
