import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StaffMyAccountPage } from './staff-my-account.page';

describe('StaffMyAccountPage', () => {
  let component: StaffMyAccountPage;
  let fixture: ComponentFixture<StaffMyAccountPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(StaffMyAccountPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
