import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EditReportPage } from './edit-report.page';

describe('EditReportPage', () => {
  let component: EditReportPage;
  let fixture: ComponentFixture<EditReportPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(EditReportPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
