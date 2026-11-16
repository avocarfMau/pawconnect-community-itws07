import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StaffAnimalAssistancePage } from './staff-animal-assistance.page';

describe('StaffAnimalAssistancePage', () => {
  let component: StaffAnimalAssistancePage;
  let fixture: ComponentFixture<StaffAnimalAssistancePage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(StaffAnimalAssistancePage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
