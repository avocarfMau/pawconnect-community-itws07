import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StaffAssistanceDetailsPage } from './staff-assistance-details.page';

describe('StaffAssistanceDetailsPage', () => {
  let component: StaffAssistanceDetailsPage;
  let fixture: ComponentFixture<StaffAssistanceDetailsPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(StaffAssistanceDetailsPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
