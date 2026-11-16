import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PetAdoptionPage } from './pet-adoption.page';

describe('PetAdoptionPage', () => {
  let component: PetAdoptionPage;
  let fixture: ComponentFixture<PetAdoptionPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(PetAdoptionPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
