import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StaffMyAssistedCasesPage } from './staff-my-assisted-cases.page';

describe('StaffMyAssistedCasesPage', () => {
  let component: StaffMyAssistedCasesPage;
  let fixture: ComponentFixture<StaffMyAssistedCasesPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(StaffMyAssistedCasesPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
